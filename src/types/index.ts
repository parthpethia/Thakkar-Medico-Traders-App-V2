/* ======================================================
   USERS / PROFILES
====================================================== */

/* ================= USER / AUTH ================= */

export type UserRole =
  | 'admin'
  | 'verified_retailer'
  | 'unverified_retailer';

export interface User {
  id: string;
  phone: string;
  email?: string;

  name?: string;
  business_name?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;

  role: UserRole;
  approved: boolean;

  credit_limit: number;
  credit_used: number;
  loyalty_points: number;

  created_at: string;
  updated_at: string;
}


/* ======================================================
   PRODUCTS
====================================================== */

export interface Product {
  id: string;
  name: string;
  company?: string | null;
  sku: string;
  pack_size?: string | null; // e.g. "10 Strips", "100ml Vial", "5 Inj"

  mrp: number;
  selling_price: number;
  gst_percent: number;

  stock_quantity: number;
  is_active: boolean;

  created_at: string;
}

/* ======================================================
   CART
====================================================== */

export interface CartItem {
  id: string;
  user_id: string;
  product_id: string;
  quantity: number;
  created_at: string;

  // joined product (optional)
  product?: {
    name: string;
    selling_price: number;
  };
}

/* ======================================================
   ORDERS
====================================================== */

export type OrderStatus =
  | 'pending'
  | 'approved'
  | 'packed'
  | 'dispatched'
  | 'delivered'
  | 'cancelled';

export interface Order {
  id: string;
  order_number: string;

  user_id: string;
  user_name: string;
  user_phone: string;

  items: any; // jsonb (order items)
  status: OrderStatus;
  subtotal: number;
  gst: number;
  grand_total: number;
  delivery_address: string;
  delivery_type: string;
  payment_mode: string;
  notes?: string;

  created_at: string;
}

/* ======================================================
   DASHBOARD (derived)
====================================================== */

export interface AdminDashboard {
  today_orders: number;
  today_revenue: number;
  pending_orders: number;
  total_users: number;
  unapproved_users: number;
  low_stock_products: number;
  total_products: number;
}
