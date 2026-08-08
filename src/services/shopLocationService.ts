import { supabase } from './supabase';
import {
  buildFullAddress,
  formatDeliveryWindow,
} from '../constants/shopLocation';
import type {
  OrderDeliveryPayload,
  RetailerShopLocation,
  ShopLocationDraft,
} from '../types/shopLocation';

export function sortShopLocations(list: RetailerShopLocation[]): RetailerShopLocation[] {
  return [...list].sort((a, b) => {
    if (a.is_verified !== b.is_verified) return a.is_verified ? -1 : 1;
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export async function fetchShopLocations(
  retailerId: string,
): Promise<RetailerShopLocation[]> {
  const { data, error } = await supabase
    .from('retailer_shop_locations')
    .select('*')
    .eq('retailer_account_id', retailerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return sortShopLocations((data || []) as RetailerShopLocation[]);
}

export async function saveShopLocation(
  retailerId: string,
  draft: ShopLocationDraft,
  existingId?: string,
): Promise<RetailerShopLocation> {
  const row = {
    retailer_account_id: retailerId,
    added_by: 'retailer' as const,
    branch_label: draft.branch_label,
    custom_label: draft.branch_label === 'custom' ? draft.custom_label || null : null,
    shop_name: draft.shop_name.trim(),
    gstin: draft.gstin.trim() || null,
    lat: draft.lat,
    lng: draft.lng,
    formatted_address: draft.formatted_address || null,
    shop_no: draft.shop_no.trim(),
    building: draft.building.trim(),
    street: draft.street.trim() || null,
    landmark: draft.landmark.trim(),
    area: draft.area.trim(),
    city: draft.city.trim(),
    state: draft.state.trim(),
    pincode: draft.pincode.trim(),
    best_delivery_time_start: draft.best_delivery_time_start || null,
    best_delivery_time_end: draft.best_delivery_time_end || null,
    entry_notes: draft.entry_notes.trim() || null,
    parking: draft.parking || null,
    receiver_name: draft.receiver_name.trim(),
    receiver_phone: draft.receiver_phone.trim(),
    alternate_phone: draft.alternate_phone.trim() || null,
  };

  if (existingId) {
    // Check if location is verified or locked by admin
    const { data: existing } = await supabase
      .from('retailer_shop_locations')
      .select('is_verified, is_locked_by_admin')
      .eq('id', existingId)
      .maybeSingle();

    if (existing?.is_verified || existing?.is_locked_by_admin) {
      // For verified/locked locations, non-admins can only update operational fields
      const operationalRow = {
        receiver_name: draft.receiver_name.trim(),
        receiver_phone: draft.receiver_phone.trim(),
        alternate_phone: draft.alternate_phone.trim() || null,
        entry_notes: draft.entry_notes.trim() || null,
        best_delivery_time_start: draft.best_delivery_time_start || null,
        best_delivery_time_end: draft.best_delivery_time_end || null,
      };

      const { data, error } = await supabase
        .from('retailer_shop_locations')
        .update(operationalRow)
        .eq('id', existingId)
        .eq('retailer_account_id', retailerId)
        .select('*')
        .single();

      if (error) {
        throw new Error('This delivery address has been verified by our team. Contact support to request a change.');
      }
      return data as RetailerShopLocation;
    }

    const { data, error } = await supabase
      .from('retailer_shop_locations')
      .update(row)
      .eq('id', existingId)
      .eq('retailer_account_id', retailerId)
      .select('*')
      .single();

    if (error) {
      if (error.message?.includes('locked') || error.message?.includes('verified') || error.code === '42501') {
        throw new Error('This delivery address has been verified by our team. Contact support to request a change.');
      }
      throw error;
    }
    return data as RetailerShopLocation;
  }

  const { count } = await supabase
    .from('retailer_shop_locations')
    .select('*', { count: 'exact', head: true })
    .eq('retailer_account_id', retailerId);

  const isFirst = (count ?? 0) === 0;

  const { data, error } = await supabase
    .from('retailer_shop_locations')
    .insert({ ...row, is_default: isFirst })
    .select('*')
    .single();

  if (error) throw error;
  return data as RetailerShopLocation;
}

export async function deleteShopLocation(id: string): Promise<void> {
  const { error } = await supabase.from('retailer_shop_locations').delete().eq('id', id);
  if (error) throw error;
}

export async function setDefaultShopLocation(id: string): Promise<void> {
  const { error } = await supabase.rpc('set_default_shop_location', { p_location_id: id });
  if (error) throw error;
}

export function toOrderDeliveryPayload(loc: RetailerShopLocation): OrderDeliveryPayload {
  const window = formatDeliveryWindow(
    loc.best_delivery_time_start,
    loc.best_delivery_time_end,
  );
  return {
    delivery_address_id: loc.id,
    shop_name: loc.shop_name,
    lat: loc.lat,
    lng: loc.lng,
    full_address: buildFullAddress(loc),
    landmark: loc.landmark,
    entry_notes: loc.entry_notes || '',
    receiver_name: loc.receiver_name,
    receiver_phone: loc.receiver_phone,
    best_delivery_window: window,
    branch_label: loc.branch_label,
    custom_label: loc.custom_label || undefined,
  };
}

export function draftFromLocation(loc: RetailerShopLocation): ShopLocationDraft {
  return {
    lat: loc.lat,
    lng: loc.lng,
    formatted_address: loc.formatted_address || '',
    shop_no: loc.shop_no,
    building: loc.building,
    street: loc.street || '',
    landmark: loc.landmark,
    area: loc.area,
    city: loc.city,
    state: loc.state,
    pincode: loc.pincode,
    shop_name: loc.shop_name,
    branch_label: loc.branch_label,
    custom_label: loc.custom_label || '',
    gstin: loc.gstin || '',
    best_delivery_time_start: loc.best_delivery_time_start?.slice(0, 5) || '',
    best_delivery_time_end: loc.best_delivery_time_end?.slice(0, 5) || '',
    entry_notes: loc.entry_notes || '',
    parking: loc.parking || '',
    receiver_name: loc.receiver_name,
    receiver_phone: loc.receiver_phone,
    alternate_phone: loc.alternate_phone || '',
  };
}

export function emptyDraft(partial?: Partial<ShopLocationDraft>): ShopLocationDraft {
  return {
    lat: 20.5937,
    lng: 78.9629,
    formatted_address: '',
    shop_no: '',
    building: '',
    street: '',
    landmark: '',
    area: '',
    city: '',
    state: '',
    pincode: '',
    shop_name: '',
    branch_label: 'main_shop',
    custom_label: '',
    gstin: '',
    best_delivery_time_start: '',
    best_delivery_time_end: '',
    entry_notes: '',
    parking: '',
    receiver_name: '',
    receiver_phone: '',
    alternate_phone: '',
    ...partial,
  };
}
