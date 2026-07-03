import { create } from 'zustand';
import { supabase } from '../services/supabase';
import { AppSettings } from '../types';
import { executeSupabaseQuery } from '../utils/supabaseQuery';
import { isTransientNetworkError, supabaseErrorMessage } from '../utils/networkErrors';

interface SettingsState {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;
  lastFetched: number | null;

  fetchSettings: (force?: boolean) => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
}

/* ===== CACHE TTL: 5 minutes ===== */
const CACHE_TTL_MS = 5 * 60 * 1000;

function parseMinOrderValueFromRow(data: Record<string, unknown>): number {
  const raw = data.min_order_value;
  if (raw == null) return defaultSettings.business.min_order_value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : defaultSettings.business.min_order_value;
}

/** Zustand selector — minimum order value (₹ subtotal before GST). */
export function selectMinOrderValue(state: Pick<SettingsState, 'settings'>): number {
  return state.settings?.business.min_order_value ?? defaultSettings.business.min_order_value;
}

/** Read current min order value outside React (e.g. guards). */
export function getMinOrderValue(): number {
  return selectMinOrderValue(useSettingsStore.getState());
}

/* ===== DEFAULT FALLBACK SETTINGS ===== */

const defaultSettings: AppSettings = {
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,
  lastFetched: null,

  /* ===== FETCH SETTINGS (with cache TTL) ===== */
  fetchSettings: async (force = false) => {
    const { lastFetched, isLoading } = get();

    // Skip if already loading
    if (isLoading) return;

    // Skip if recently fetched (within TTL) unless forced
    if (
      !force &&
      lastFetched &&
      Date.now() - lastFetched < CACHE_TTL_MS
    ) {
      return;
    }

    try {
      set({ isLoading: true, error: null });

      const { data, error } = await executeSupabaseQuery(() =>
        supabase.from('settings').select('*').limit(1).maybeSingle(),
      );

      if (error && !isTransientNetworkError(error) && error.code !== 'PGRST116') {
        console.warn('Settings fetch issue, using defaults:', supabaseErrorMessage(error));
      }

      if (!data) {
        set({ settings: defaultSettings, lastFetched: Date.now(), error: null });
      } else {
        set({
          settings: {
            features: {
              gst_enabled: data.gst_enabled ?? defaultSettings.features.gst_enabled,
              credit_enabled: data.credit_enabled ?? defaultSettings.features.credit_enabled,
              loyalty_enabled: data.loyalty_enabled ?? defaultSettings.features.loyalty_enabled,
              delivery_enabled: data.delivery_enabled ?? defaultSettings.features.delivery_enabled,
              notifications_enabled: defaultSettings.features.notifications_enabled,
              show_prices_to_unverified: data.show_prices_to_unverified ?? defaultSettings.features.show_prices_to_unverified,
            },
            business: {
              ...defaultSettings.business,
              min_order_value: parseMinOrderValueFromRow(data as Record<string, unknown>),
            },
            branding: {
              ...defaultSettings.branding,
              phone: (data as { support_phone?: string | null }).support_phone?.trim()
                || defaultSettings.branding.phone,
            },
          },
          lastFetched: Date.now(),
        });
      }
    } catch (err: unknown) {
      if (!isTransientNetworkError(err)) {
        console.error('fetchSettings error:', (err as Error)?.message || err);
      }
      set({ settings: defaultSettings, error: (err as Error)?.message, lastFetched: Date.now() });
    } finally {
      set({ isLoading: false });
    }
  },

  /* ===== UPDATE SETTINGS ===== */
  updateSettings: async (settings: AppSettings) => {
    try {
      set({ isLoading: true, error: null });

      // Fetch the existing record to obtain the primary UUID key
      const { data: current, error: fetchErr } = await supabase
        .from('settings')
        .select('id')
        .limit(1)
        .single();

      if (fetchErr || !current) {
        throw new Error(fetchErr?.message || 'No settings record found to update');
      }

      const { error } = await supabase
        .from('settings')
        .update({
          gst_enabled: settings.features.gst_enabled,
          credit_enabled: settings.features.credit_enabled,
          loyalty_enabled: settings.features.loyalty_enabled,
          delivery_enabled: settings.features.delivery_enabled,
          show_prices_to_unverified: settings.features.show_prices_to_unverified,
        })
        .eq('id', current.id);

      if (error) throw error;

      set({ settings, lastFetched: Date.now() });
      return true;
    } catch (err: any) {
      console.error('updateSettings error:', err.message);
      set({ error: err.message });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },
}));
