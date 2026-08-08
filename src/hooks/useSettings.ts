import { useQuery } from '@tanstack/react-query';
import { supabase } from '../services/supabase';
import { AppSettings } from '../types';
import { executeSupabaseQuery } from '../utils/supabaseQuery';
import { isTransientNetworkError } from '../utils/networkErrors';

export const DEFAULT_SETTINGS: AppSettings = {
  features: {
    gst_enabled: true,
    credit_enabled: true,
    loyalty_enabled: true,
    delivery_enabled: true,
    notifications_enabled: true,
    show_prices_to_unverified: true,
  },
  business: {
    min_order_value: 500,
    delivery_charge: 50,
    free_delivery_above: 2000,
    points_per_rupee: 0.1,
    point_value_in_rupees: 0.5,
    points_expiry_days: 365,
    max_points_redemption_percent: 50,
    payment_modes_enabled: ['cod'],
    pickup_enabled: false,
    pickup_address: '',
    pickup_hours: '',
    loyalty_redemption_rate: 0.5,
    max_redemption_percent: 20,
  },
  branding: {
    company_name: 'Thakkar Medico Traders',
    tagline: 'Your Trusted Pharma Partner',
    primary_color: '#4C51C9',
    secondary_color: '#43A047',
    gstin: '',
    pan: '',
    address: '',
    phone: '',
    email: '',
    website: '',
  },
};

export function parseMinOrderValueFromRow(data: Record<string, unknown>): number {
  const raw = data.min_order_value;
  if (raw == null) return DEFAULT_SETTINGS.business.min_order_value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.business.min_order_value;
}

export async function fetchSettingsData(): Promise<AppSettings> {
  const { data, error } = await executeSupabaseQuery(() =>
    supabase.from('settings').select('*').limit(1).maybeSingle(),
  );

  if (error && !isTransientNetworkError(error) && error.code !== 'PGRST116') {
    console.warn('Settings fetch issue, using defaults:', error.message);
  }

  if (!data) {
    return DEFAULT_SETTINGS;
  }

  return {
    features: {
      gst_enabled: data.gst_enabled ?? DEFAULT_SETTINGS.features.gst_enabled,
      credit_enabled: data.credit_enabled ?? DEFAULT_SETTINGS.features.credit_enabled,
      loyalty_enabled: data.loyalty_enabled ?? DEFAULT_SETTINGS.features.loyalty_enabled,
      delivery_enabled: data.delivery_enabled ?? DEFAULT_SETTINGS.features.delivery_enabled,
      notifications_enabled: DEFAULT_SETTINGS.features.notifications_enabled,
      show_prices_to_unverified: data.show_prices_to_unverified ?? DEFAULT_SETTINGS.features.show_prices_to_unverified,
    },
    business: {
      ...DEFAULT_SETTINGS.business,
      min_order_value: parseMinOrderValueFromRow(data as Record<string, unknown>),
      payment_modes_enabled: Array.isArray(data.payment_modes_enabled)
        ? data.payment_modes_enabled
        : DEFAULT_SETTINGS.business.payment_modes_enabled,
      pickup_enabled: data.pickup_enabled ?? DEFAULT_SETTINGS.business.pickup_enabled,
      pickup_address: (data as any).pickup_address ?? DEFAULT_SETTINGS.business.pickup_address,
      pickup_hours: (data as any).pickup_hours ?? DEFAULT_SETTINGS.business.pickup_hours,
      loyalty_redemption_rate: (data as any).loyalty_redemption_rate ?? DEFAULT_SETTINGS.business.loyalty_redemption_rate,
      max_redemption_percent: (data as any).max_redemption_percent ?? DEFAULT_SETTINGS.business.max_redemption_percent,
    },
    branding: {
      ...DEFAULT_SETTINGS.branding,
      phone: (data as { support_phone?: string | null }).support_phone?.trim()
        || DEFAULT_SETTINGS.branding.phone,
    },
  };
}

export function useSettingsQuery() {
  return useQuery<AppSettings>({
    queryKey: ['app-settings'],
    queryFn: fetchSettingsData,
    staleTime: 5 * 60 * 1000, // 5 minutes fresh
  });
}
