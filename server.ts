import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { MercadoPagoConfig, Preference } from "mercadopago";
import { db } from "./server/db.js";

const app = express();
const PORT = 3000;

// Mercado Pago In-Memory Settings Store with env fallback
let mpSettings = {
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || "",
  publicKey: process.env.VITE_MERCADOPAGO_PUBLIC_KEY || "",
};

// Middleware for parsing JSON and urlencoded payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Custom lightweight cookie parsing middleware to avoid extra package dependencies
const cookieParser = (req: any, res: any, next: any) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};
  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie: string) => {
      const parts = cookie.split("=");
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      req.cookies[name] = decodeURIComponent(value);
    });
  }
  next();
};
app.use(cookieParser);

// Administrative Session Management using HMAC signatures
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "dr-tecno-secret-key-12345678";

function createSessionToken(username: string): string {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 8; // 8 hours duration
  const payload = JSON.stringify({ username, expiresAt });
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64") + "." + signature;
}

function verifySessionToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payloadStr = Buffer.from(parts[0], "base64").toString("utf8");
    const signature = parts[1];

    const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(payloadStr).digest("hex");
    if (hmac !== signature) return null;

    const payload = JSON.parse(payloadStr);
    if (payload.expiresAt < Date.now()) return null; // Expired session

    return payload.username;
  } catch {
    return null;
  }
}

// Authentication middleware to protect administrative routes
const requireAdmin = (req: any, res: any, next: any) => {
  let token = req.cookies.dr_tecno_session;

  // Try to extract from Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.status(401).json({ error: "No autorizado, sesión inexistente" });
  }
  const username = verifySessionToken(token);
  if (!username) {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }
  req.adminUsername = username;
  next();
};

// ==================== PUBLIC API ENDPOINTS ====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", database: db.isSupabase ? "Supabase" : "Local JSON" });
});

// Get catalog products with search, filtering, and sorting
app.get("/api/products", async (req, res) => {
  try {
    const search = req.query.search as string || undefined;
    const category = req.query.category as string || undefined;
    const collection = req.query.collection as string || undefined;
    const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice as string) : undefined;
    const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice as string) : undefined;
    const featured = req.query.featured === "true" ? true : req.query.featured === "false" ? false : undefined;
    const sort = req.query.sort as string || undefined;

    const products = await db.getProducts({
      search,
      category,
      collection,
      minPrice,
      maxPrice,
      featured,
      sort,
    });

    res.json(products);
  } catch (error: any) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Error al obtener productos de la base de datos" });
  }
});

// Get a single product by slug
app.get("/api/products/:slug", async (req, res) => {
  try {
    const product = await db.getProductBySlug(req.params.slug);
    if (!product) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    res.json(product);
  } catch (error: any) {
    console.error("Error fetching product by slug:", error);
    res.status(500).json({ error: "Error al obtener el detalle del producto" });
  }
});

// Get all unique product categories
app.get("/api/categories", async (req, res) => {
  try {
    const products = await db.getProducts();
    const defaultCategories = ["Repuestos", "Herramientas", "Insumos", "Capacitaciones", "Merchandising", "Gaming", "Audio", "Smartphones", "Laptops"];
    const set = new Set<string>(defaultCategories);
    products.forEach((p) => {
      if (p.category && p.category.trim()) {
        set.add(p.category.trim());
      }
    });
    res.json(Array.from(set));
  } catch (error: any) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Error al obtener categorías" });
  }
});

// Get all collections
app.get("/api/collections", async (req, res) => {
  try {
    const collections = await db.getCollections();
    res.json(collections);
  } catch (error: any) {
    console.error("Error fetching collections:", error);
    res.status(500).json({ error: "Error al obtener las colecciones" });
  }
});

// Get a single collection by ID
app.get("/api/collections/:id", async (req, res) => {
  try {
    const collection = await db.getCollectionById(req.params.id);
    if (!collection) {
      return res.status(404).json({ error: "Colección no encontrada" });
    }
    res.json(collection);
  } catch (error: any) {
    console.error("Error fetching collection by ID:", error);
    res.status(500).json({ error: "Error al obtener el detalle de la colección" });
  }
});

// Submit/Create an order (Checkout)
app.post("/api/orders", async (req, res) => {
  try {
    const {
      customer_name,
      customer_email,
      customer_phone,
      shipping_address,
      city,
      state,
      country,
      postal_code,
      delivery_method,
      payment_method,
      paymentMethod,
      notes,
      items, // array of { product_id: string, quantity: number, unit_price: number }
      subtotal,
      total,
    } = req.body;

    // Server-side validation
    if (!customer_name || !customer_email || !items || !Array.isArray(items) || items.length === 0 || total === undefined) {
      return res.status(400).json({ error: "Datos de orden incompletos o inválidos" });
    }

    const sanitizedItems = items.map((item: any) => ({
      product_id: String(item.product_id || item.id || ""),
      quantity: Number(item.quantity || 1),
      unit_price: Number(item.unit_price || item.price || 0)
    }));

    const parsedSubtotal = typeof subtotal === "number" ? subtotal : (parseFloat(subtotal) || 0);
    const parsedTotal = typeof total === "number" ? total : (parseFloat(total) || 0);
    const selectedPaymentMethod = payment_method || paymentMethod || "efectivo";

    const createdOrder = await db.createOrder(
      {
        customer_id: null,
        customer_name,
        customer_email,
        customer_phone: customer_phone || null,
        shipping_address: shipping_address || null,
        city: city || null,
        state: state || null,
        country: country || null,
        postal_code: postal_code || null,
        delivery_method: delivery_method || null,
        notes: notes || null,
        subtotal: parsedSubtotal,
        total: parsedTotal,
        status: "En preparación",
        items_count: sanitizedItems.reduce((acc, item) => acc + item.quantity, 0),
      },
      sanitizedItems
    );

    // Generate MercadoPago Preference if payment method is mercadopago or requested
    let initPoint = null;
    const token = mpSettings.accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (selectedPaymentMethod === "mercadopago") {
      if (token) {
        try {
          const client = new MercadoPagoConfig({ accessToken: token });
          const preference = new Preference(client);

          const host = req.get("host") || "localhost:3000";
          const protocol = req.protocol || "http";
          const origin = req.get("origin") || `${protocol}://${host}`;

          const prefResult = await preference.create({
            body: {
              items: sanitizedItems.map((item: any) => ({
                id: item.product_id || "1",
                title: item.product_name || item.name || `Producto #${item.product_id}`,
                quantity: Number(item.quantity || 1),
                unit_price: Number(item.unit_price || 0),
                currency_id: "ARS"
              })),
              back_urls: {
                success: `${origin}/#/pedido-confirmacion?order=${createdOrder.id}&status=approved`,
                failure: `${origin}/#/pedido-confirmacion?order=${createdOrder.id}&status=failure`,
                pending: `${origin}/#/pedido-confirmacion?order=${createdOrder.id}&status=pending`
              },
              auto_return: "approved",
              external_reference: createdOrder.id,
              statement_descriptor: "DR. TECNO",
              notification_url: `${origin}/api/mercadopago/webhook`
            }
          });

          initPoint = prefResult.init_point || prefResult.sandbox_init_point;
        } catch (mpErr: any) {
          console.error("Error creating MercadoPago preference:", mpErr?.message || mpErr);
        }
      } else {
        console.warn("MercadoPago Access Token not configured.");
      }
    }

    res.status(201).json({
      ...createdOrder,
      order: createdOrder,
      init_point: initPoint
    });
  } catch (error: any) {
    console.error("Error creating order:", error);
    res.status(500).json({ error: error?.message || "Error al procesar la compra en el servidor" });
  }
});

// Fetch an order by order number
app.get("/api/orders/:orderNumber", async (req, res) => {
  try {
    const order = await db.getOrderByNumber(req.params.orderNumber);
    if (!order) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    res.json(order);
  } catch (error: any) {
    console.error("Error fetching order by number:", error);
    res.status(500).json({ error: "Error al recuperar los detalles del pedido" });
  }
});

// Create technical service request
app.post("/api/service-requests", async (req, res) => {
  try {
    const {
      customer_name,
      customer_dni,
      dni,
      phone,
      email,
      device_type,
      service_type,
      brand,
      model,
      problem_description,

      // Frontend fields mappings
      customer_email,
      customer_phone,
      brand_model,
      issue_description
    } = req.body;

    const parsedDni = dni || customer_dni;
    const parsedPhone = phone || customer_phone;
    const parsedEmail = email || customer_email;
    const parsedProblem = problem_description || issue_description;
    const parsedServiceType = service_type || "Reparación";

    let parsedBrand = brand || "";
    let parsedModel = model || "";
    if (!parsedBrand && !parsedModel && brand_model) {
      const parts = brand_model.trim().split(/\s+/);
      parsedBrand = parts[0];
      parsedModel = parts.slice(1).join(" ") || "Modelo Genérico";
    }
    if (!parsedBrand) parsedBrand = "Genérico";
    if (!parsedModel) parsedModel = "Genérico";

    // Server-side validation using mapped/fallback fields
    if (!customer_name || !parsedPhone || !parsedDni || !device_type || !parsedServiceType || !parsedProblem) {
      return res.status(400).json({ error: "Por favor complete todos los campos obligatorios, incluyendo el DNI." });
    }

    const newRequest = await db.createServiceRequest({
      customer_name,
      customer_dni: parsedDni || null,
      phone: parsedPhone,
      email: parsedEmail || null,
      device_type,
      service_type: parsedServiceType,
      brand: parsedBrand,
      model: parsedModel,
      problem_description: parsedProblem,
      diagnosis: null,
      estimated_price: null,
      internal_notes: null,
      estimated_delivery_date: null,
      delivered_at: null,
    });

    res.status(201).json({
      ...newRequest,
      ticket_number: newRequest.request_number // Bridge for frontend!
    });
  } catch (error: any) {
    console.error("Error creating technical service request:", error);
    res.status(500).json({ error: "Error al registrar la solicitud de servicio técnico" });
  }
});

// Helper to extract clean plain-text notes from stringified JSON metadata or text
function extractCleanNotes(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.plain_notes && parsed.plain_notes.trim()) {
        return parsed.plain_notes.trim();
      }
      return null;
    } catch (e) {
      return text;
    }
  }
  return text;
}

// Track a service request by number
app.get("/api/service-requests/:requestNumber", async (req, res) => {
  try {
    const request = await db.getServiceRequestByNumber(req.params.requestNumber);
    if (!request) {
      return res.status(404).json({ error: "Solicitud técnica no encontrada" });
    }

    // Map database request status to frontend client statuses
    const statusMap: Record<string, string> = {
      "Pendiente": "recibido",
      "En diagnóstico": "en_diagnostico",
      "Esperando aprobación": "presupuestado",
      "En proceso": "en_reparacion",
      "Listo": "listo_para_entregar",
      "Entregado": "entregado",
      "Cancelado": "entregado"
    };

    const cleanDiagnosis = extractCleanNotes(request.diagnosis);
    const cleanInternalNotes = extractCleanNotes(request.internal_notes);
    const finalNotes = cleanDiagnosis || cleanInternalNotes || null;

    res.json({
      ...request,
      ticket_number: request.request_number,
      customer_name: request.customer_name,
      device_type: request.device_type,
      brand_model: `${request.brand || ""} ${request.model || ""}`.trim() || request.device_type,
      issue_description: request.problem_description,
      status: statusMap[request.status] || "recibido",
      status_notes: finalNotes
    });
  } catch (error: any) {
    console.error("Error tracking service request:", error);
    res.status(500).json({ error: "Error al consultar la solicitud de servicio técnico" });
  }
});


// ==================== ADMINISTRATIVE AUTHENTICATION ====================

// Admin Login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    }

    // SHA-256 Hashing of the password
    const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
    
    console.log(`[Login Attempt] Username: "${username}", Hash: "${passwordHash}"`);
    console.log(`[Database Type] isSupabase: ${db.isSupabase}`);

    const isVerified = await db.verifyAdmin(username, passwordHash);
    console.log(`[Login Result] isVerified: ${isVerified}`);

    if (!isVerified) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    // Generate token and set HTTP-only cookie
    const token = createSessionToken(username);
    res.cookie("dr_tecno_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    });

    res.json({ success: true, username, token });
  } catch (error: any) {
    console.error("Error in admin login:", error);
    res.status(500).json({ error: "Error interno en el servidor durante el login" });
  }
});

// Admin Logout
app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("dr_tecno_session");
  res.json({ success: true });
});

// Verify Current Admin Session
app.get("/api/admin/session", (req, res) => {
  let token = req.cookies.dr_tecno_session;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.status(401).json({ error: "No hay sesión activa" });
  }
  const username = verifySessionToken(token);
  if (!username) {
    res.clearCookie("dr_tecno_session");
    return res.status(401).json({ error: "Sesión expirada" });
  }
  res.json({ username });
});


// ==================== PROTECTED ADMIN API ENDPOINTS ====================

// Get Dashboard overview stats
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const products = await db.getProducts();
    const orders = await db.getOrders();
    const customers = await db.getCustomers();
    const serviceRequests = await db.getServiceRequests();

    const stats = {
      totalProducts: products.length,
      lowStockProducts: products.filter(p => p.stock <= 3).length,
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => o.status === "En preparación" || o.status === "Probado").length,
      totalRevenue: orders.filter(o => o.status !== "Cancelado").reduce((acc, o) => acc + o.total, 0),
      totalCustomers: customers.length,
      pendingServiceRequests: serviceRequests.filter(s => s.status === "Pendiente" || s.status === "En diagnóstico" || s.status === "Esperando aprobación").length,
      inProgressServiceRequests: serviceRequests.filter(s => s.status === "En proceso").length,
      recentOrders: orders.slice(0, 5),
      recentServiceRequests: serviceRequests.slice(0, 5),
    };

    res.json(stats);
  } catch (error: any) {
    console.error("Error loading admin dashboard stats:", error);
    res.status(500).json({ error: "Error al compilar las estadísticas del panel" });
  }
});

// Admin Products CRUD: List all
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const products = await db.getProducts(); // Fetch all (active and inactive)
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: "Error al listar productos para administración" });
  }
});

// Admin Products CRUD: Create
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const {
      name,
      slug,
      category,
      collection,
      brand,
      price,
      short_description,
      description,
      image_url,
      images,
      specifications,
      stock,
      featured,
      badge,
      active,
    } = req.body;

    if (!name || !slug || !category || price === undefined) {
      return res.status(400).json({ error: "Nombre, Slug, Categoría y Precio son obligatorios" });
    }

    const newProd = await db.createProduct({
      name,
      slug,
      category,
      collection: collection || null,
      brand: brand || null,
      price: parseFloat(price),
      short_description: short_description || null,
      description: description || null,
      image_url: image_url || "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=600&auto=format&fit=crop&q=60",
      images: images || [],
      specifications: specifications || {},
      stock: parseInt(stock) || 0,
      featured: !!featured,
      badge: badge || null,
      active: active !== undefined ? !!active : true,
    });

    res.status(201).json(newProd);
  } catch (error: any) {
    console.error("Error creating product:", error);
    res.status(500).json({ error: "Error al crear el producto" });
  }
});

// Admin Products CRUD: Update
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateProduct(req.params.id, req.body);
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating product:", error);
    res.status(500).json({ error: "Error al modificar el producto" });
  }
});

// Admin Products CRUD: Delete
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const success = await db.deleteProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ error: "Producto no encontrado o no se pudo eliminar" });
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting product:", error);
    res.status(500).json({ error: "Error al eliminar el producto" });
  }
});

// Admin Orders: List
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await db.getOrders();
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: "Error al listar los pedidos" });
  }
});

// Admin Orders: Update Status
app.put("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: "Estado es requerido" });
    }
    const updated = await db.updateOrderStatus(req.params.id, status);
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating order status:", error);
    res.status(500).json({ error: "Error al modificar el estado del pedido" });
  }
});

// Admin Customers: List
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const customers = await db.getCustomers();
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: "Error al listar clientes" });
  }
});

// Admin Customers: Update
app.put("/api/admin/customers/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateCustomer(req.params.id, req.body);
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating customer:", error);
    res.status(500).json({ error: "Error al modificar el cliente" });
  }
});

// Admin Service Requests: List
app.get("/api/admin/service-requests", requireAdmin, async (req, res) => {
  try {
    const reqs = await db.getServiceRequests();
    res.json(reqs);
  } catch (error: any) {
    res.status(500).json({ error: "Error al listar solicitudes de servicio técnico" });
  }
});

// Admin Service Requests: Update
app.put("/api/admin/service-requests/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateServiceRequest(req.params.id, req.body);
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating service request:", error);
    res.status(500).json({ error: "Error al modificar la solicitud técnica" });
  }
});

// Admin Service Requests: Delete
app.delete("/api/admin/service-requests/:id", requireAdmin, async (req, res) => {
  try {
    const success = await db.deleteServiceRequest(req.params.id);
    if (!success) {
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting service request:", error);
    res.status(500).json({ error: "Error al eliminar la solicitud técnica" });
  }
});

// Admin Collections CRUD: List
app.get("/api/admin/collections", requireAdmin, async (req, res) => {
  try {
    const collections = await db.getCollections();
    res.json(collections);
  } catch (error: any) {
    res.status(500).json({ error: "Error al listar colecciones para administración" });
  }
});

// Admin Collections CRUD: Update
app.put("/api/admin/collections/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateCollection(req.params.id, req.body);
    res.json(updated);
  } catch (error: any) {
    console.error("Error updating collection:", error);
    res.status(500).json({ error: "Error al modificar la colección" });
  }
});

// Admin Collections CRUD: Create
app.post("/api/admin/collections", requireAdmin, async (req, res) => {
  try {
    const created = await db.createCollection(req.body);
    res.status(201).json(created);
  } catch (error: any) {
    console.error("Error creating collection:", error);
    res.status(500).json({ error: error.message || "Error al crear la colección" });
  }
});

// Admin Collections CRUD: Delete
app.delete("/api/admin/collections/:id", requireAdmin, async (req, res) => {
  try {
    const success = await db.deleteCollection(req.params.id);
    if (!success) {
      return res.status(404).json({ error: "Colección no encontrada" });
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting collection:", error);
    res.status(500).json({ error: "Error al eliminar la colección" });
  }
});


// Admin Mercado Pago Configuration Endpoints
app.get("/api/admin/mercadopago/config", requireAdmin, (req, res) => {
  return res.json({
    accessToken: mpSettings.accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN || "",
    publicKey: mpSettings.publicKey || process.env.VITE_MERCADOPAGO_PUBLIC_KEY || "",
    configured: !!(mpSettings.accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN)
  });
});

app.post("/api/admin/mercadopago/config", requireAdmin, (req, res) => {
  const { accessToken, publicKey } = req.body;
  if (accessToken !== undefined) mpSettings.accessToken = String(accessToken).trim();
  if (publicKey !== undefined) mpSettings.publicKey = String(publicKey).trim();

  return res.json({
    success: true,
    message: "Configuración de Mercado Pago guardada exitosamente.",
    configured: !!(mpSettings.accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN)
  });
});

// Mercado Pago Webhook / IPN Endpoint
app.post("/api/mercadopago/webhook", async (req, res) => {
  console.log("MercadoPago Webhook Received:", req.query, req.body);
  return res.status(200).send("OK");
});

// ==================== VITE AND STATIC ASSETS HANDLING ====================

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Dr Tecno Server running on http://localhost:${PORT}`);
  });
}

startServer();
