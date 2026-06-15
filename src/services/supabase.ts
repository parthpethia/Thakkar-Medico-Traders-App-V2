import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { isTransientNetworkError } from '../utils/networkErrors';

const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const supabaseKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

function validateConfig(): string | null {
  if (!supabaseUrl || !supabaseKey) {
    return 'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env, then restart Expo with --clear.';
  }
  try {
    new URL(supabaseUrl);
    return null;
  } catch {
    return 'EXPO_PUBLIC_SUPABASE_URL is invalid. Use a full https URL from Supabase → Project Settings → API.';
  }
}

export const supabaseConfigError = validateConfig();

const supabaseHost = (() => {
  if (supabaseConfigError) return 'supabase';
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return 'supabase';
  }
})();

/** Do not race SecureStore reads — returning null early breaks auth session hydration. */
const ExpoStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

function toReachabilityError(cause: unknown): Error {
  const detail =
    cause instanceof Error && cause.message ? ` (${cause.message})` : '';
  return new Error(
    `Unable to reach Supabase (${supabaseHost}). Check internet and EXPO_PUBLIC_SUPABASE_URL on this device.${detail}`,
  );
}

function buildClient(): SupabaseClient {
  return createClient(supabaseUrl, supabaseKey, {
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await fetch(input, init);
        } catch (error: unknown) {
          if (isTransientNetworkError(error)) {
            throw toReachabilityError(error);
          }
          if (
            error instanceof TypeError &&
            String((error as Error).message || '').includes('Network request failed')
          ) {
            throw toReachabilityError(error);
          }
          throw error;
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
}

/** Placeholder client so a missing .env does not crash the app at import time. */
function buildPlaceholderClient(): SupabaseClient {
  return createClient(
    'https://placeholder.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIn0.x',
    {
      auth: {
        storage: ExpoStorage,
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

export const supabase = supabaseConfigError
  ? buildPlaceholderClient()
  : buildClient();
