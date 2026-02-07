// User Types
export type UserRole = 'admin' | 'verified_retailer' | 'unverified_retailer';

export interface User {
  id: string;
  email?: string;
  phone: string;
  name: string;
  business_name?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  role: UserRole;
  is_active: boolean;
  credit_limit: number;
  credit_used: number;
  loyalty_points: number;
  created_at: string;
  updated_at: string;
}

// Category & Brand
export interface Category {
  id: string;
  name: string;
  description?: string;
  image?: string;
  is_active: boolean;
  created_at: string;
}

export interface Brand {
  id: string;
  name: string;
  logo?: string;
  is_active: boolean;
  created_at: string;
}

// Product
export interface Product {
  id: string;
  name: string;
  sku: string;
  description?: string;
  category_id: string;
  brand_id?: string;
  mrp: number;
  selling_price: number;
  gst_percent: number;
  stock_quantity: number;
  min_order_quantity: number;
  expiry_date?: string;
  image?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Cart
export interface CartItem {
  id: string;
  user_id: string;
  product_id: string;
  quantity: number;
  product_name: string;
  product_image?: string;
  mrp: number;
  selling_price: number;
  gst_percent: number;
  created_at: string;
}

// Order
export type OrderStatus = 'pending' | 'approved' | 'packed' | 'dispatched' | 'delivered' | 'cancelled';
export type DeliveryType = 'pickup' | 'delivery';
export type PaymentMode = 'cod' | 'upi' | 'bank_transfer' | 'credit';

export interface OrderItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  mrp: number;
  selling_price: number;
  gst_percent: number;
  subtotal: number;
  gst_amount: number;
  total: number;
}

export interface Order {
  id: string;
  order_number: string;
  user_id: string;
  user_name: string;
  user_phone: string;
  items: OrderItem[];
  delivery_type: DeliveryType;
  delivery_address?: string;
  payment_mode: PaymentMode;
  subtotal: number;
  total_gst: number;
  cgst: number;
  sgst: number;
  delivery_charge: number;
  points_redeemed: number;
  points_discount: number;
  grand_total: number;
  status: OrderStatus;
  notes?: string;
  created_at: string;
  updated_at: string;
}

// Settings
export interface FeatureToggles {
  gst_enabled: boolean;
  credit_enabled: boolean;
  loyalty_enabled: boolean;
  delivery_enabled: boolean;
  notifications_enabled: boolean;
  show_prices_to_unverified: boolean;
}

export interface BusinessSettings {
  min_order_value: number;
  delivery_charge: number;
  free_delivery_above: number;
  points_per_rupee: number;
  point_value_in_rupees: number;
  points_expiry_days: number;
  max_points_redemption_percent: number;
}

export interface BrandingSettings {
  company_name: string;
  tagline: string;
  logo?: string;
  primary_color: string;
  secondary_color: string;
  gstin: string;
  pan: string;
  address: string;
  phone: string;
  email: string;
  website: string;
}

export interface AppSettings {
  features: FeatureToggles;
  business: BusinessSettings;
  branding: BrandingSettings;
}

// Dashboard
export interface AdminDashboard {
  today_orders: number;
  today_revenue: number;
  pending_orders: number;
  total_users: number;
  unverified_users: number;
  low_stock_products: number;
  total_products: number;
}

// Transactions
export interface LoyaltyTransaction {
  id: string;
  user_id: string;
  points: number;
  transaction_type: string;
  order_id?: string;
  description: string;
  created_at: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  transaction_type: string;
  order_id?: string;
  description: string;
  created_at: string;
}
