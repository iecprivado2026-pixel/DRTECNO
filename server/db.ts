import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==================== Types ====================
export interface Product {
  id: string;
  name: string;
  slug: string;
  category: string;
  collection: string | null;
  brand: string | null;
  price: number;
  short_description: string | null;
  description: string | null;
  image_url: string | null;
  images: any[];
  specifications: Record<string, any>;
  stock: number;
  featured: boolean;
  badge: string | null;
  active: boolean;
  created_at?: string;
}

export interface Collection {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  image_url: string | null;
  created_at?: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  created_at?: string;
}

export interface Order {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  shipping_address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  delivery_method: string | null;
  notes: string | null;
  subtotal: number;
  total: number;
  status: string;
  items_count: number;
  items?: OrderItem[];
  created_at?: string;
}

export interface OrderItem {
  id?: string;
  order_id?: string;
  product_id: string;
  product_name?: string;
  quantity: number;
  unit_price: number;
}

export interface ServiceRequest {
  id: string;
  request_number: string;
  customer_name: string;
  customer_dni: string | null;
  phone: string;
  email: string | null;
  device_type: string;
  service_type: string;
  brand: string | null;
  model: string | null;
  problem_description: string;
  diagnosis: string | null;
  estimated_price: number | null;
  internal_notes: string | null;
  estimated_delivery_date: string | null;
  delivered_at: string | null;
  status: string;
  created_at?: string;
}

interface ProductFilters {
  search?: string;
  category?: string;
  collection?: string;
  minPrice?: number;
  maxPrice?: number;
  featured?: boolean;
  sort?: string;
}

// ==================== Supabase client ====================
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

function toNumber(v: any, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProduct(row: any): Product {
  return {
    ...row,
    price: toNumber(row.price),
    stock: Math.trunc(toNumber(row.stock)),
    images: Array.isArray(row.images) ? row.images : [],
    specifications:
      row.specifications && typeof row.specifications === "object"
        ? row.specifications
        : {},
    featured: !!row.featured,
    active: row.active === undefined ? true : !!row.active,
  };
}

function genNumber(prefix: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${stamp}-${rand}`;
}

class Database {
  public isSupabase: boolean;
  private client: SupabaseClient | null = null;

  constructor() {
    this.isSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
    if (this.isSupabase) {
      this.client = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      console.log("[db] Connected to Supabase:", SUPABASE_URL);
    } else {
      console.warn(
        "[db] Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      );
    }
  }

  private sb(): SupabaseClient {
    if (!this.client) throw new Error("Supabase no está configurado");
    return this.client;
  }

  // ==================== Products ====================
  async getProducts(filters: ProductFilters = {}): Promise<Product[]> {
    let query = this.sb().from("products").select("*");

    if (filters.search) {
      query = query.or(
        `name.ilike.%${filters.search}%,brand.ilike.%${filters.search}%,short_description.ilike.%${filters.search}%`
      );
    }
    if (filters.category) query = query.eq("category", filters.category);
    if (filters.collection) query = query.eq("collection", filters.collection);
    if (filters.minPrice !== undefined) query = query.gte("price", filters.minPrice);
    if (filters.maxPrice !== undefined) query = query.lte("price", filters.maxPrice);
    if (filters.featured !== undefined) query = query.eq("featured", filters.featured);

    switch (filters.sort) {
      case "price_asc":
        query = query.order("price", { ascending: true });
        break;
      case "price_desc":
        query = query.order("price", { ascending: false });
        break;
      case "name_asc":
        query = query.order("name", { ascending: true });
        break;
      default:
        query = query.order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeProduct);
  }

  async getProductBySlug(slug: string): Promise<Product | null> {
    const { data, error } = await this.sb()
      .from("products")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    return data ? normalizeProduct(data) : null;
  }

  async createProduct(payload: Partial<Product>): Promise<Product> {
    const { data, error } = await this.sb()
      .from("products")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeProduct(data);
  }

  async updateProduct(id: string, patch: Partial<Product>): Promise<Product> {
    const clean = { ...patch };
    delete (clean as any).id;
    delete (clean as any).created_at;
    if (clean.price !== undefined) clean.price = toNumber(clean.price);
    if (clean.stock !== undefined) clean.stock = Math.trunc(toNumber(clean.stock));
    const { data, error } = await this.sb()
      .from("products")
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeProduct(data);
  }

  async deleteProduct(id: string): Promise<boolean> {
    const { error } = await this.sb().from("products").delete().eq("id", id);
    if (error) throw error;
    return true;
  }

  // ==================== Collections ====================
  async getCollections(): Promise<Collection[]> {
    const { data, error } = await this.sb()
      .from("collections")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async getCollectionById(id: string): Promise<Collection | null> {
    const { data, error } = await this.sb()
      .from("collections")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async createCollection(payload: Partial<Collection>): Promise<Collection> {
    const { data, error } = await this.sb()
      .from("collections")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async updateCollection(id: string, patch: Partial<Collection>): Promise<Collection> {
    const clean = { ...patch };
    delete (clean as any).id;
    delete (clean as any).created_at;
    const { data, error } = await this.sb()
      .from("collections")
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async deleteCollection(id: string): Promise<boolean> {
    const { error } = await this.sb().from("collections").delete().eq("id", id);
    if (error) throw error;
    return true;
  }

  // ==================== Orders ====================
  async createOrder(
    orderData: Partial<Order>,
    items: OrderItem[]
  ): Promise<Order> {
    // Resolve product names for items
    const ids = items.map((i) => i.product_id).filter(Boolean);
    let nameMap: Record<string, string> = {};
    if (ids.length) {
      const { data: prods } = await this.sb()
        .from("products")
        .select("id,name")
        .in("id", ids);
      (prods || []).forEach((p: any) => {
        nameMap[p.id] = p.name;
      });
    }

    const order_number = genNumber("ORD");
    const { data: order, error } = await this.sb()
      .from("orders")
      .insert({ ...orderData, order_number })
      .select("*")
      .single();
    if (error) throw error;

    if (items.length) {
      const rows = items.map((i) => ({
        order_id: order.id,
        product_id: i.product_id,
        product_name: nameMap[i.product_id] || i.product_name || "Producto",
        quantity: i.quantity,
        unit_price: i.unit_price,
      }));
      const { error: itemsErr } = await this.sb().from("order_items").insert(rows);
      if (itemsErr) throw itemsErr;
    }

    return { ...order, items };
  }

  async getOrders(): Promise<Order[]> {
    const { data, error } = await this.sb()
      .from("orders")
      .select("*, items:order_items(*)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((o: any) => ({
      ...o,
      total: toNumber(o.total),
      subtotal: toNumber(o.subtotal),
    }));
  }

  async getOrderByNumber(orderNumber: string): Promise<Order | null> {
    const { data, error } = await this.sb()
      .from("orders")
      .select("*, items:order_items(*)")
      .or(`order_number.eq.${orderNumber},id.eq.${orderNumber}`)
      .maybeSingle();
    if (error) {
      // fallback: try id only when order_number lookup malformed
      const { data: byId } = await this.sb()
        .from("orders")
        .select("*, items:order_items(*)")
        .eq("order_number", orderNumber)
        .maybeSingle();
      return byId || null;
    }
    return data || null;
  }

  async updateOrderStatus(id: string, status: string): Promise<Order> {
    const { data, error } = await this.sb()
      .from("orders")
      .update({ status })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  // ==================== Customers ====================
  async getCustomers(): Promise<Customer[]> {
    const { data, error } = await this.sb()
      .from("customers")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async updateCustomer(id: string, patch: Partial<Customer>): Promise<Customer> {
    const clean = { ...patch };
    delete (clean as any).id;
    delete (clean as any).created_at;
    const { data, error } = await this.sb()
      .from("customers")
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  // ==================== Service Requests ====================
  async createServiceRequest(
    payload: Partial<ServiceRequest>
  ): Promise<ServiceRequest> {
    const request_number = genNumber("ST");
    const { data, error } = await this.sb()
      .from("service_requests")
      .insert({ ...payload, request_number, status: "Pendiente" })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async getServiceRequests(): Promise<ServiceRequest[]> {
    const { data, error } = await this.sb()
      .from("service_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async getServiceRequestByNumber(
    requestNumber: string
  ): Promise<ServiceRequest | null> {
    const { data, error } = await this.sb()
      .from("service_requests")
      .select("*")
      .eq("request_number", requestNumber)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async updateServiceRequest(
    id: string,
    patch: Partial<ServiceRequest>
  ): Promise<ServiceRequest> {
    const clean = { ...patch };
    delete (clean as any).id;
    delete (clean as any).created_at;
    if (clean.estimated_price !== undefined && clean.estimated_price !== null)
      clean.estimated_price = toNumber(clean.estimated_price);
    const { data, error } = await this.sb()
      .from("service_requests")
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async deleteServiceRequest(id: string): Promise<boolean> {
    const { error } = await this.sb()
      .from("service_requests")
      .delete()
      .eq("id", id);
    if (error) throw error;
    return true;
  }

  // ==================== Admin ====================
  async verifyAdmin(username: string, passwordHash: string): Promise<boolean> {
    const { data, error } = await this.sb()
      .from("admin_users")
      .select("username,password_hash")
      .eq("username", username)
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    return data.password_hash === passwordHash;
  }
}

export const db = new Database();
