import { create } from 'zustand';
import { supabase } from '../services/supabase';
import { AppSettings } from '../types';
import { queryClient } from '../lib/queryClient';
import { fetchSettingsData, DEFAULT_SETTINGS } from '../hooks/useSettings';
import { supabaseErrorMessage } from '../utils/networkErrors';

interface SettingsState {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;
  lastFetched: number | null;

  fetchSettings: (force?: boolean) => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
}

/** Zustand selector — minimum order value (₹ subtotal before GST). */
export function selectMinOrderValue(state: Pick<SettingsState, 'settings'>): number {
  return state.settings?.business.min_order_value ?? DEFAULT_SETTINGS.business.min_order_value;
}

/** Read current min order value outside React (e.g. guards). */
export function getMinOrderValue(): number {
  return selectMinOrderValue(useSettingsStore.getState());
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,
  lastFetched: null,

  /* ===== FETCH SETTINGS (delegating to TanStack Query) ===== */
  fetchSettings: async (force = false) => {
    const { isLoading } = get();
    if (isLoading) return;

    try {
      set({ isLoading: true, error: null });

      const queryKey = ['app-settings'];
      if (force) {
        await queryClient.invalidateQueries({ queryKey });
      }

      const data = await queryClient.fetchQuery<AppSettings>({
        queryKey,
        queryFn: fetchSettingsData,
        staleTime: force ? 0 : 5 * 60 * 1000,
      });

      set({
        settings: data,
        lastFetched: Date.now(),
        error: null,
      });
    } catch (err: unknown) {
      console.error('fetchSettings error:', (err as Error)?.message || err);
      set({
        settings: DEFAULT_SETTINGS,
        error: (err as Error)?.message,
        lastFetched: Date.now(),
      });
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

      // Invalidate query cache to force reload on next access
      await queryClient.invalidateQueries({ queryKey: ['app-settings'] });

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

