import { create } from 'zustand';
import { supabase } from '../services/supabase';
import { AppSettings } from '../types';

interface SettingsState {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;

  fetchSettings: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
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

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  isLoading: false,
  error: null,

  /* ===== FETCH SETTINGS ===== */
  fetchSettings: async () => {
    try {
      set({ isLoading: true, error: null });

      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .limit(1)
        .single();

      if (error || !data) {
        console.warn('Settings not found, using defaults');
        set({ settings: defaultSettings });
      } else {
        set({
          settings: {
            features: data.features ?? defaultSettings.features,
            business: data.business ?? defaultSettings.business,
            branding: data.branding ?? defaultSettings.branding,
          },
        });
      }
    } catch (err: any) {
      console.error('fetchSettings error:', err.message);
      set({ settings: defaultSettings, error: err.message });
    } finally {
      set({ isLoading: false });
    }
  },

  /* ===== UPDATE SETTINGS ===== */
  updateSettings: async (settings: AppSettings) => {
    try {
      set({ isLoading: true, error: null });

      const { error } = await supabase
        .from('settings')
        .upsert(
          {
            id: 1, // single-row settings pattern
            features: settings.features,
            business: settings.business,
            branding: settings.branding,
          },
          { onConflict: 'id' }
        );

      if (error) throw error;

      set({ settings });
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
