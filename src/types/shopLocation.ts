export type BranchLabel = 'main_shop' | 'warehouse' | 'branch' | 'godown' | 'custom';
export type ParkingOption = 'yes' | 'no' | 'street';
export type AddedBy = 'retailer' | 'admin';

export interface RetailerShopLocation {
  id: string;
  retailer_account_id: string;
  added_by: AddedBy;
  is_locked_by_admin: boolean;
  is_verified: boolean;
  is_default: boolean;
  visible_to_group: boolean;

  branch_label: BranchLabel;
  custom_label?: string | null;
  shop_name: string;
  gstin?: string | null;

  lat: number;
  lng: number;
  formatted_address?: string | null;
  shop_no: string;
  building: string;
  street?: string | null;
  landmark: string;
  area: string;
  city: string;
  state: string;
  pincode: string;

  best_delivery_time_start?: string | null;
  best_delivery_time_end?: string | null;
  entry_notes?: string | null;
  parking?: ParkingOption | null;

  receiver_name: string;
  receiver_phone: string;
  alternate_phone?: string | null;

  admin_internal_notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopLocationDraft {
  lat: number;
  lng: number;
  formatted_address?: string;
  shop_no: string;
  building: string;
  street: string;
  landmark: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  shop_name: string;
  branch_label: BranchLabel;
  custom_label: string;
  gstin: string;
  best_delivery_time_start: string;
  best_delivery_time_end: string;
  entry_notes: string;
  parking: ParkingOption | '';
  receiver_name: string;
  receiver_phone: string;
  alternate_phone: string;
}

export interface OrderDeliveryPayload {
  delivery_address_id: string;
  shop_name: string;
  lat: number;
  lng: number;
  full_address: string;
  landmark: string;
  entry_notes: string;
  receiver_name: string;
  receiver_phone: string;
  best_delivery_window: string;
  branch_label: BranchLabel;
  custom_label?: string;
}

export type DeliveryFlowStage =
  | 'select'
  | 'location_entry'
  | 'map_pin'
  | 'details'
  | 'address_book';
