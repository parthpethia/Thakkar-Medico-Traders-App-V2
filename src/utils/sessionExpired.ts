import { supabase } from '../services/supabase';
import { clearAll } from '../lib/queryCoalescer';

/**
 * Centralized handler for unrecoverable session expiry.
 *
 * Signs out via Supabase which fires SIGNED_OUT on onAuthStateChange.
 * The root layout listener handles Zustand cleanup and navigation.
 *
 * Guarded so concurrent callers don't race each other.
 */
let expiring = false;

export async function handleSessionExpired(): Promise<void> {
  if (expiring) return;
  expiring = true;
  try {
    clearAll();
    await supabase.auth.signOut();
  } finally {
    expiring = false;
  }
}
