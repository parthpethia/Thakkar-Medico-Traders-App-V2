import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

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

const STORAGE_TIMEOUT_MS = 8000;

async function storageWithTimeout<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((resolve) =>
        setTimeout(() => resolve(fallback), STORAGE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return fallback;
  }
}

const ExpoStorage = {
  getItem: (key: string) =>
    storageWithTimeout(() => SecureStore.getItemAsync(key), null),
  setItem: (key: string, value: string) =>
    storageWithTimeout(() => SecureStore.setItemAsync(key, value), undefined),
  removeItem: (key: string) =>
    storageWithTimeout(() => SecureStore.deleteItemAsync(key), undefined),
};

function buildClient(): SupabaseClient {
  return createClient(supabaseUrl, supabaseKey, {
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
              `Unable to reach Supabase (${supabaseHost}). Check internet and EXPO_PUBLIC_SUPABASE_URL on this device.`,
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
