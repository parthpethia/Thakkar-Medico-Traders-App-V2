import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

/**
 * Supabase auth sessions exceed SecureStore's ~2048 byte limit on Android.
 * AsyncStorage is the recommended Expo approach and persists the full JWT reliably.
 */
const AuthSessionStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

/** One-time move from SecureStore (2048-byte cap) so users stay signed in after the switch. */
export async function migrateLegacyAuthStorage(): Promise<void> {
  if (supabaseConfigError) return;
  try {
    const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
    const storageKey = `sb-${projectRef}-auth-token`;
    const inAsync = await AsyncStorage.getItem(storageKey);
    if (inAsync) return;
    const legacy = await SecureStore.getItemAsync(storageKey);
    if (!legacy) return;
    await AsyncStorage.setItem(storageKey, legacy);
    await SecureStore.deleteItemAsync(storageKey).catch(() => {});
  } catch {
    /* ignore */
  }
}

function toReachabilityError(cause: unknown): Error {
  const detail =
    cause instanceof Error && cause.message ? ` (${cause.message})` : '';
  const msg = `Unable to reach Supabase (${supabaseHost}). Check internet and EXPO_PUBLIC_SUPABASE_URL on this device.${detail}`;
  if (detail.includes('522')) {
    return new Error(
      `${msg} If this persists, open the Supabase dashboard for this project — the backend may be restarting or need support.`,
    );
  }
  return new Error(msg);
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504, 520, 521, 522, 524]);
const MAX_FETCH_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 1000;

function fetchRetryDelayMs(attempt: number): number {
  return FETCH_RETRY_BASE_MS * attempt;
}

async function supabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const nonJson = !contentType.includes('application/json');
        if (
          nonJson &&
          RETRYABLE_HTTP_STATUSES.has(response.status) &&
          attempt < MAX_FETCH_ATTEMPTS
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, fetchRetryDelayMs(attempt)),
          );
          continue;
        }
        if (nonJson) {
          throw new Error(
            `Server error (${response.status}). The service may be temporarily offline or restarting.`,
          );
        }
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS && isTransientNetworkError(error)) {
        await new Promise((resolve) =>
          setTimeout(resolve, fetchRetryDelayMs(attempt)),
        );
        continue;
      }
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
  }

  if (isTransientNetworkError(lastError)) {
    throw toReachabilityError(lastError);
  }
  throw lastError;
}

function buildClient(): SupabaseClient {
  return createClient(supabaseUrl, supabaseKey, {
    global: {
      fetch: supabaseFetch,
    },
    auth: {
      storage: AuthSessionStorage,
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
        storage: AuthSessionStorage,
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

// M4: Legacy auth migration runs once via initAuth() in authStore

if (__DEV__) {
  const originalChannel = supabase.channel.bind(supabase);
  supabase.channel = (...args: Parameters<typeof originalChannel>) => {
    const channel = originalChannel(...args);
    if (supabase.getChannels().length > 3) {
      console.warn('[supabase] channel count:', supabase.getChannels().length);
    }
    return channel;
  };
}

