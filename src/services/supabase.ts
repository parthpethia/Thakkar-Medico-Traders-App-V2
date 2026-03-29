import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const supabaseKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Supabase environment variables are missing. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env'
  );
}

const supabaseHost = (() => {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    throw new Error(
      'EXPO_PUBLIC_SUPABASE_URL is invalid. It must be a full https URL, e.g. https://<project-ref>.supabase.co'
    );
  }
})();

const ExpoStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        return await fetch(input, {
          ...init,
          signal: init?.signal ?? controller.signal,
        });
      } catch (error: any) {
        if (
          error instanceof TypeError &&
          String(error?.message || '').includes('Network request failed')
        ) {
          throw new Error(
            `Unable to reach Supabase (${supabaseHost}). Check EXPO_PUBLIC_SUPABASE_URL, internet, and DNS/network access from device.`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  },
  auth: {
    storage: ExpoStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
