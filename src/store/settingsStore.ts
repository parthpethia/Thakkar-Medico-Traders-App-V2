import { create } from 'zustand';
import api from '../services/api';
import { AppSettings } from '../types';

interface SettingsState {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;
  
  fetchSettings: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
}

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
    primary_color: '#1E88E5',
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
  settings: defaultSettings,
  isLoading: false,
  error: null,

  fetchSettings: async () => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.get('/settings');
      set({ settings: response.data, isLoading: false });
    } catch (error: any) {
      set({ settings: defaultSettings, isLoading: false });
    }
  },

  updateSettings: async (settings: AppSettings) => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.put('/settings', settings);
      set({ settings: response.data, isLoading: false });
      return true;
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to update settings', isLoading: false });
      return false;
    }
  },
}));
