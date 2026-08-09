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
  retailer_code?: string; // New field from wholesaler data

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
  | 'out_for_delivery'
  | 'in_transit'
  | 'arriving_soon'
  | 'processing'
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
  created_by?: string | null;
  status_before_assignment?: string | null;
  delivery_address_id?: string | null;
  delivery_snapshot?: Record<string, unknown> | null;

  /* Phase 1 — delivery ops */
  delivery_failure_reason?: string | null;
  items_adjusted?: boolean;
  adjustment_accepted_at?: string | null;
  original_grand_total?: number | null;

  /* Phase 2 — enterprise delivery */
  manifest_id?: string | null;
  sla_deadline?: string | null;
  priority?: 1 | 2 | 3;
  dispatch_verified_at?: string | null;
  dispatch_verified_by?: string | null;

  /* Phase 1 & 3 — live delivery tracking & failure hooks */
  dispatched_at?: string | null;
  delivered_at?: string | null;
  failed_at?: string | null;
  failed_reason?: string | null;
  delivery_status?:
    | 'pending'
    | 'dispatched'
    | 'in_transit'
    | 'arriving_soon'
    | 'signal_lost'
    | 'delivered'
    | 'failed'
    | null;

  created_at: string;
}

/* ======================================================
   DELIVERY TRACKING (per-order GPS)
====================================================== */

export type DeliveryTrackingStatus =
  | 'pending'
  | 'dispatched'
  | 'in_transit'
  | 'arriving_soon'
  | 'signal_lost'
  | 'delivered'
  | 'failed';

export interface DeliveryTracking {
  id: string;
  order_id: string;
  rider_id: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  battery_level: number | null;
  is_off_route?: boolean;
  geofence_arrived?: boolean;
  total_distance_covered?: number;
  updated_at: string;
}

export interface DeliveryLocationHistory {
  id?: string;
  order_id?: string;
  rider_id?: string | null;
  lat: number;
  lng: number;
  heading?: number | null;
  speed?: number | null;
  recorded_at: string;
}

export interface RouteResult {
  durationSeconds: number;
  distanceMeters: number;
  polylineCoords: [number, number][];
  source: 'osrm' | 'google_routes' | 'osrm_mirror' | 'direct_fallback' | 'interpolated';
}

export interface GeofenceStatus {
  isArrived: boolean;
  distanceMeters: number;
  thresholdMeters: number;
}

export interface DeliveryProofRecord {
  id: string;
  photo_url: string;
  captured_lat?: number | null;
  captured_lng?: number | null;
  captured_at: string;
  notes?: string | null;
}

export interface OrderTrackingBundle {
  order: Order;
  tracking: DeliveryTracking | null;
  history: DeliveryLocationHistory[];
  rider: {
    id: string;
    name: string;
    phone: string | null;
  } | null;
  proof?: DeliveryProofRecord | null;
  timeline: {
    placed_at: string | null;
    confirmed_at: string | null;
    dispatched_at: string | null;
    delivered_at: string | null;
    failed_at: string | null;
  };
}

/* ======================================================
   DELIVERY FAILURE REASONS
====================================================== */

export type DeliveryFailureReason =
  | 'shop_closed'
  | 'retailer_unreachable'
  | 'wrong_address'
  | 'refused_delivery'
  | 'partial_delivery'
  | 'damaged_goods'
  | 'expired_products'
  | 'payment_dispute'
  | 'other';

export const DELIVERY_FAILURE_LABELS: Record<DeliveryFailureReason, string> = {
  shop_closed: 'Shop Closed',
  retailer_unreachable: 'Retailer Unreachable',
  wrong_address: 'Wrong Address',
  refused_delivery: 'Refused Delivery',
  partial_delivery: 'Partial Delivery',
  damaged_goods: 'Damaged Goods',
  expired_products: 'Expired Products',
  payment_dispute: 'Payment Dispute',
  other: 'Other',
};

/* ======================================================
   DELIVERY EVENTS (audit log)
====================================================== */

export type DeliveryEventType =
  | 'assigned' | 'accepted' | 'rejected' | 'picked_up' | 'dispatched'
  | 'arrived_at_stop' | 'delivery_attempted' | 'delivered' | 'delivery_failed'
  | 'collection_recorded' | 'return_reported'
  | 'manifest_created' | 'manifest_completed'
  | 'dispatch_verified' | 'photo_uploaded' | 'otp_verified'
  | 'gps_ping' | 'status_changed' | 'exception_reported'
  | 'vehicle_assigned' | 'shift_started' | 'shift_ended'
  | 'reconciliation_submitted' | 'reconciliation_approved';

export interface DeliveryEvent {
  id: string;
  order_id?: string | null;
  manifest_id?: string | null;
  event_type: DeliveryEventType;
  actor_id?: string | null;
  actor_role?: string | null;
  metadata: Record<string, unknown>;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy_m?: number | null;
  recorded_at: string;
}

/* ======================================================
   VEHICLES
====================================================== */

export type VehicleType = 'two_wheeler' | 'three_wheeler' | 'four_wheeler' | 'van' | 'truck';

export interface Vehicle {
  id: string;
  registration_no: string;
  vehicle_type: VehicleType;
  make_model?: string | null;
  is_active: boolean;
  notes?: string | null;
  created_at: string;
}

/* ======================================================
   DELIVERY MANIFESTS
====================================================== */

export type ManifestStatus = 'created' | 'dispatch_verified' | 'in_progress' | 'completed' | 'cancelled';

export interface DeliveryManifest {
  id: string;
  manifest_number: string;
  driver_id: string;
  vehicle_id?: string | null;
  status: ManifestStatus;
  total_orders: number;
  total_value: number;
  total_collected: number;
  dispatched_at?: string | null;
  completed_at?: string | null;
  created_by?: string | null;
  notes?: string | null;
  created_at: string;
}

/* ======================================================
   DELIVERY COLLECTIONS
====================================================== */

export type CollectionMethod = 'cash' | 'upi' | 'cheque' | 'credit' | 'neft' | 'prepaid';
export type CollectionStatus = 'pending' | 'verified' | 'disputed' | 'refunded';

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  cheque: 'Cheque',
  credit: 'Credit',
  neft: 'NEFT',
  prepaid: 'Prepaid',
};

export interface DeliveryCollection {
  id: string;
  order_id: string;
  manifest_id?: string | null;
  method: CollectionMethod;
  amount: number;
  reference_no?: string | null;
  bank_name?: string | null;
  collected_by: string;
  collected_at: string;
  verified_by?: string | null;
  verified_at?: string | null;
  status: CollectionStatus;
  notes?: string | null;
}

/* ======================================================
   DELIVERY RECONCILIATIONS
====================================================== */

export type ReconciliationStatus = 'pending' | 'approved' | 'disputed' | 'resolved';

export interface DeliveryReconciliation {
  id: string;
  driver_id: string;
  manifest_id?: string | null;
  shift_date: string;
  expected_cash: number;
  actual_cash: number;
  discrepancy: number;
  expected_upi: number;
  expected_cheque: number;
  total_collections: number;
  total_orders: number;
  status: ReconciliationStatus;
  driver_notes?: string | null;
  admin_notes?: string | null;
  reconciled_by?: string | null;
  reconciled_at?: string | null;
  created_at: string;
}

/* ======================================================
   DELIVERY PROOFS (enhanced)
====================================================== */

export interface DeliveryProof {
  id: string;
  order_id: string;
  otp_code?: string | null;
  otp_verified_at?: string | null;
  photo_url?: string | null;
  photo_uploaded_at?: string | null;
  receiver_name?: string | null;
  receiver_phone?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy_m?: number | null;
  delivered_at_gps?: string | null;
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
    /** OPT-3: Checkout fields — avoids a separate settings fetch */
    payment_modes_enabled: string[];
    pickup_enabled: boolean;
    pickup_address: string;
    pickup_hours: string;
    loyalty_redemption_rate: number;
    max_redemption_percent: number;
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
