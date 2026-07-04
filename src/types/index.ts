/* ======================================================
   USERS / PROFILES
====================================================== */

export type UserRole =
  | 'admin'
  | 'delivery'
  | 'retailer'
  | 'verified_retailer'
  | 'unverified_retailer';

export interface User {
  id: string;
  phone: string;
  email: string;

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
  category?: string | null;
  sku: string;
  pack_size?: string | null;
  image?: string | null;

  mrp: number;
  selling_price: number;
  gst_percent: number;

  stock_quantity: number;
  is_active: boolean;

  created_at: string;

  // Joined packaging levels (optional — populated when fetched with join)
  product_packaging_levels?: PackagingLevel[];
}

/* ======================================================
   PACKAGING LEVELS
====================================================== */

export interface PackagingLevel {
  id: string;
  product_id: string;
  level_name: string;
  units_per_level: number;
  is_base: boolean;
  min_order_qty: number;
  increment_step: number;
  display_order: number;
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
  | 'pending_payment'
  | 'payment_failed'
  | 'assigned'
  | 'accepted'
  | 'approved'
  | 'packed'
  | 'picked_up'
  | 'dispatched'
  | 'delivered'
  | 'cancelled'
  | 'rejected'
  | 'delivery_failed';

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
  discount_amount: number;
  delivery_address: string;
  delivery_type: string;
  fulfillment_mode: string;
  payment_mode: string;
  notes?: string;

  cancellation_requested?: boolean;
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  rejection_reason?: string;

  assigned_to?: string | null;
  assigned_at?: string | null;
  assigned_by?: string | null;
  status_before_assignment?: string | null;
  delivery_address_id?: string | null;
  delivery_snapshot?: Record<string, unknown> | null;

  /* Phase 1 — delivery ops */
  delivery_failure_reason?: string | null;
  items_adjusted?: boolean;
  adjustment_accepted_at?: string | null;
  original_grand_total?: number | null;

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

/* ======================================================
   APP SETTINGS
====================================================== */

export interface AppSettings {
  features: {
    gst_enabled: boolean;
    credit_enabled: boolean;
    loyalty_enabled: boolean;
    delivery_enabled: boolean;
    notifications_enabled: boolean;
    show_prices_to_unverified: boolean;
  };
  business: {
    min_order_value: number;
    delivery_charge: number;
    free_delivery_above: number;
    points_per_rupee: number;
    point_value_in_rupees: number;
    points_expiry_days: number;
    max_points_redemption_percent: number;
  };
  branding: {
    company_name: string;
    tagline: string;
    primary_color: string;
    secondary_color: string;
    gstin: string;
    pan: string;
    address: string;
    phone: string;
    email: string;
    website: string;
  };
}

/* ======================================================
   PRICE VISIBILITY HELPER
====================================================== */

/**
 * Centralized logic to determine if prices should be shown.
 * Use this everywhere instead of ad-hoc checks.
 */
export function shouldShowPrices(
  user: { role?: string; approved?: boolean } | null | undefined,
  settings: AppSettings | null | undefined,
): boolean {
  if (!user) return settings?.features?.show_prices_to_unverified ?? false;
  if (user.role === 'admin') return true;
  if (user.approved) return true;
  return settings?.features?.show_prices_to_unverified ?? false;
}

/** Whether the user may add items to cart (matches checkout / place_order approval rules). */
export function canAddToCart(
  user: { role?: string; approved?: boolean } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.approved === true;
}

/** Columns safe to load on retailer-facing product lists. */
export const PRODUCT_LIST_SELECT =
  'id, name, company, category, sku, pack_size, image, mrp, selling_price, gst_percent, stock_quantity, is_active, created_at';

/** Supabase select string for product + packaging levels join. */
export const PRODUCT_WITH_PACKAGING_SELECT =
  '*, product_packaging_levels(id, product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order)';
