// PA: CRIT-2 — Clear SecureStore biometric credentials on logout
import { create } from 'zustand';
import { supabase, supabaseConfigError, migrateLegacyAuthStorage } from '../services/supabase';
import { clearCredentials } from '../hooks/useBiometric';
import { captureError } from '../utils/errorReporting';
import { withTimeout } from '../utils/withTimeout';
import { isTransientNetworkError, supabaseErrorMessage } from '../utils/networkErrors';
import { executeSupabaseQuery } from '../utils/supabaseQuery';
import { normalizeEmail, isValidEmail } from '../utils/email';
import { formatPhoneE164 } from '../utils/phone';
import { coalesce, clearAll } from '../lib/queryCoalescer';
import { useHomeCache } from './homeStore';

const AUTH_INIT_TIMEOUT_MS = 25000;

type RegErrLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

export function mapRegistrationError(err: unknown): string {
  const e = (err ?? {}) as RegErrLike;
  const text = [e.message, e.details, e.hint, e.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const raw = e.message?.trim() || 'Registration failed. Please try again.';

  const isDuplicate =
    /duplicate key|unique constraint|23505|already registered|already been registered|user already exists|user_already_registered|database error saving new user/.test(
      text,
    ) || /duplicate key|unique constraint|already registered|database error saving new user/i.test(raw);

  if (e.code === 'user_already_registered' || /user already registered/i.test(raw)) {
    return 'This email address is already registered. Please sign in instead.';
  }

  if (!isDuplicate) {
    if (/invalid email|email address invalid/i.test(text)) {
      return 'Please enter a valid email address.';
    }
    if (/password/i.test(text) && /short|least|weak/i.test(text)) {
      return 'Password must be at least 6 characters.';
    }
    if (/network|fetch failed|timeout/i.test(text)) {
      return 'Network error. Check your connection and try again.';
    }
    return raw;
  }

  const emailHit =
    /idx_profiles_email|profiles.*email|duplicate.*email|email.*already|users_email|email_address|\bemail\b/.test(
      text,
    );
  const phoneHit =
    /idx_profiles_phone|profiles.*phone|duplicate.*phone|phone.*already|\bphone\b/.test(text);

  if (emailHit && !phoneHit) {
    return 'This email address is already registered. Please sign in or use a different email.';
  }
  if (phoneHit && !emailHit) {
    return 'This phone number is already linked to another account. Use a different number or sign in.';
  }

  return 'An account with this email or phone number already exists. Please sign in or use different details.';
}

let initInFlight: Promise<void> | null = null;
let resolveUserInFlight: Promise<AppUser | null> | null = null;
let fetchUserInFlight: Promise<void> | null = null;

/* ======================================================
   ROLE NORMALIZATION
====================================================== */

const normalizeRole = (role?: string | null) => {
  const value = (role || '').toLowerCase().trim();
  if (value === 'admin') return 'admin' as const;
  if (value === 'delivery') return 'delivery' as const;
  return 'retailer' as const;
};

/* ======================================================
   TYPES
====================================================== */

export type AppUser = {
  id: string;
  email: string;
  phone?: string | null;
  role: 'admin' | 'retailer' | 'delivery';
  approved: boolean;
  name?: string;
  business_name?: string | null;
  gstin?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  loyalty_points?: number;
  credit_limit?: number;
  credit_used?: number;
  retailer_type?: string | null;
  retailer_code?: string | null;
};

type AuthState = {
  user: AppUser | null;
  /** True once startup session check has finished (success or failure). */
  authReady: boolean;
  isLoading: boolean;
  error: string | null;
  initError: string | null;

  initAuth: () => Promise<void>;
  fetchUser: (options?: { silent?: boolean }) => Promise<void>;
  login: (identifier: string, password: string) => Promise<boolean>;
  requestPasswordResetOtp: (email: string) => Promise<boolean>;
  verifyPasswordResetOtp: (email: string, token: string) => Promise<boolean>;
  setNewPasswordAfterReset: (password: string) => Promise<boolean>;
  register: (data: any) => Promise<boolean>;
  updateProfile: (data: Partial<AppUser>) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
};

/* ======================================================
   PROFILE SELECT FIELDS (single source of truth)
====================================================== */

const PROFILE_FIELDS =
  'approved, role, name, email, phone, business_name, gstin, address, city, state, pincode, loyalty_points, credit_limit, credit_used, retailer_type, retailer_code';

/** Build AppUser from Supabase auth user + profile row */
function buildAppUser(
  authUser: { id: string; email?: string | null; phone?: string | null; user_metadata?: any; app_metadata?: any },
  profile: Record<string, any> | null,
): AppUser {
  const resolvedRole = normalizeRole(
    profile?.role || authUser.app_metadata?.role,
  );

  return {
    id: authUser.id,
    email: profile?.email || authUser.email || '',
    phone: profile?.phone || authUser.user_metadata?.phone || null,
    role: resolvedRole,
    approved: profile?.approved ?? false,
    name: profile?.name || authUser.user_metadata?.name,
    business_name: profile?.business_name || null,
    gstin: profile?.gstin || null,
    address: profile?.address || null,
    city: profile?.city || null,
    state: profile?.state || null,
    pincode: profile?.pincode || null,
    loyalty_points: profile?.loyalty_points ?? 0,
    credit_limit: profile?.credit_limit ?? 0,
    credit_used: profile?.credit_used ?? 0,
    retailer_type: profile?.retailer_type || null,
    retailer_code: profile?.retailer_code || null,
  };
}

async function loadProfileForUser(userId: string) {
  try {
    const { data: profile, error } = await executeSupabaseQuery(() =>
      supabase
        .from('profiles')
        .select(PROFILE_FIELDS)
        .eq('id', userId)
        .maybeSingle(),
    );

    if (error) {
      const msg = supabaseErrorMessage(error);
      if (msg.includes('does not exist') || error.code === '42P01') {
        console.warn('profiles table missing — run supabase/setup.sql in Supabase SQL Editor');
        return null;
      }
      if (!isTransientNetworkError(error)) {
        console.log('Profile fetch error:', msg || error.code || 'unknown');
      }
      return null;
    }
    return profile;
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      console.log('Profile fetch failed:', supabaseErrorMessage(err));
    }
    return null;
  }
}

async function resolveUserFromSession(): Promise<AppUser | null> {
  if (resolveUserInFlight) {
    return resolveUserInFlight;
  }

  resolveUserInFlight = (async () => {
    try {
      const { data: sessionData, error: sessionError } = await withTimeout(
        supabase.auth.getSession(),
        AUTH_INIT_TIMEOUT_MS,
        'Session read',
      );

      if (sessionError) {
        throw sessionError;
      }

      const authUser = sessionData.session?.user;
      if (!authUser) {
        return null;
      }

      const fetchProfile = () => loadProfileForUser(authUser.id);
      let profile: Record<string, any> | null = null;
      try {
        profile = await withTimeout(
          coalesce('user-profile', fetchProfile),
          AUTH_INIT_TIMEOUT_MS,
          'Profile load',
        );
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          console.log('Profile load skipped or timed out:', supabaseErrorMessage(err));
        }
      }
      return buildAppUser(authUser, profile);
    } finally {
      resolveUserInFlight = null;
    }
  })();

  return resolveUserInFlight;
}

/* ======================================================
   HELPER: resolve phone number to email via RPC
====================================================== */

async function resolvePhoneToEmail(phone: string): Promise<string | null> {
  try {
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return null;

    const e164 = formatPhoneE164(phone);
    const variants = [...new Set([e164, digits, `+91${digits}`, `91${digits}`])];

    for (const p_phone of variants) {
      const { data, error } = await supabase.rpc('get_email_by_phone', {
        p_phone,
      });
      if (error) {
        console.log('Phone-to-email lookup error:', error.message);
        continue;
      }
      if (data) return data as string;
    }
    return null;
  } catch (err) {
    console.log('Phone-to-email lookup failed:', err);
    return null;
  }
}

/* ======================================================
   HELPER: resolve retailer code to email via RPC
   ====================================================== */

async function resolveCodeToEmail(code: string): Promise<string | null> {
  try {
    const trimmed = code.trim();
    if (!trimmed) return null;

    const { data, error } = await supabase.rpc('get_email_by_retailer_code', {
      p_retailer_code: trimmed,
    });
    if (error) {
      console.log('Retailer code-to-email lookup error:', error.message);
      return null;
    }
    return data as string | null;
  } catch (err) {
    console.log('Retailer code-to-email lookup failed:', err);
    return null;
  }
}

function mapLoginError(err: unknown): string {
  const e = (err ?? {}) as RegErrLike;
  const raw = e.message?.trim() || '';
  const lower = raw.toLowerCase();

  if (supabaseConfigError) return supabaseConfigError;

  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid credentials') ||
    e.code === 'invalid_credentials'
  ) {
    return 'Incorrect email, phone, retailer code, or password. Please try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email before signing in, or contact support.';
  }
  if (lower.includes('no account found for this phone')) {
    return 'No account found for this phone number. Try signing in with your email instead.';
  }
  if (lower.includes('valid email, phone number, or retailer code')) {
    return raw;
  }
  if (lower.includes('valid email or 10-digit')) {
    return 'Please enter a valid email, phone number, or retailer code';
  }
  if (/network|fetch failed|timeout|unable to reach supabase/i.test(lower)) {
    return 'Network error. Check your connection and try again.';
  }
  return raw || 'Login failed. Please try again.';
}

/** Check if the input looks like a phone number (all digits, 10 chars, no @) */
function looksLikePhone(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.includes('@')) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 10;
}

/* ======================================================
   STORE
====================================================== */

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  authReady: false,
  isLoading: false,
  error: null,
  initError: null,

  clearError: () => set({ error: null, initError: null }),

  /* ===== STARTUP (called once from root layout) ===== */
  initAuth: async () => {
    if (initInFlight) {
      return initInFlight;
    }

    initInFlight = (async () => {
      set({ authReady: false, isLoading: true, initError: null });

      if (supabaseConfigError) {
        set({
          user: null,
          authReady: true,
          isLoading: false,
          initError: supabaseConfigError,
        });
        return;
      }

      await migrateLegacyAuthStorage();

      try {
        const user = await resolveUserFromSession();
        set({ user, authReady: true, isLoading: false, initError: null });
      } catch (err: any) {
        if (isTransientNetworkError(err)) {
          console.log('Init auth slow or offline (session kept if any):', err?.message || err);
          set({
            authReady: true,
            isLoading: false,
            initError: 'Connection is slow. Pull to refresh or try again.',
          });
          return;
        }
        console.log('Init auth error:', err);
        set({
          user: null,
          authReady: true,
          isLoading: false,
          initError: err?.message || 'Could not connect. Check internet and try again.',
        });
      } finally {
        initInFlight = null;
      }
    })();

    return initInFlight;
  },

  /* ===== REFRESH SESSION (after sign-in / token refresh) ===== */
  fetchUser: async (options) => {
    const silent = options?.silent ?? false;

    if (fetchUserInFlight) {
      return fetchUserInFlight;
    }

    fetchUserInFlight = (async () => {
      try {
        if (!silent) {
          set({ isLoading: true });
        }

        const user = await resolveUserFromSession();
        set({ user, isLoading: false, initError: null });
      } catch (err) {
        if (isTransientNetworkError(err)) {
          console.log('Fetch user skipped (transient):', (err as Error)?.message || err);
          set({ isLoading: false });
          return;
        }
        console.log('Fetch user error:', err);
        if (!silent) {
          set({ user: null, isLoading: false });
        } else {
          set({ isLoading: false });
        }
      } finally {
        fetchUserInFlight = null;
      }
    })();

    return fetchUserInFlight;
  },

  /* ===== LOGIN (email or phone + password) ===== */
  login: async (identifier, password) => {
    try {
      set({ isLoading: true, error: null });

      if (supabaseConfigError) {
        throw new Error(supabaseConfigError);
      }

      const trimmed = identifier.trim();
      let email: string;

      if (looksLikePhone(trimmed)) {
        // Phone entered — resolve to email via RPC
        const resolved = await resolvePhoneToEmail(trimmed);
        if (!resolved) {
          throw new Error('No account found for this phone number');
        }
        email = resolved;
      } else if (isValidEmail(trimmed)) {
        email = normalizeEmail(trimmed);
      } else {
        // Try resolving as retailer_code
        const resolved = await resolveCodeToEmail(trimmed);
        if (!resolved) {
          throw new Error('Please enter a valid email, phone number, or retailer code');
        }
        email = resolved;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      const u = data.user;

      const fetchProfile = () => loadProfileForUser(u.id);
      const profile = await coalesce('user-profile', fetchProfile);

      set({ user: buildAppUser(u, profile), isLoading: false });
      return true;
    } catch (err: any) {
      set({ error: mapLoginError(err), isLoading: false });
      return false;
    }
  },

  /* ===== PASSWORD RESET (email OTP via resetPasswordForEmail) ===== */
  requestPasswordResetOtp: async (email) => {
    try {
      set({ isLoading: true, error: null });

      const normalized = normalizeEmail(email);

      const { error } = await supabase.auth.resetPasswordForEmail(normalized);

      if (error) throw error;

      set({ isLoading: false });
      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Could not send verification code',
        isLoading: false,
      });
      return false;
    }
  },

  verifyPasswordResetOtp: async (email, token) => {
    try {
      set({ isLoading: true, error: null });

      const normalized = normalizeEmail(email);

      const { error } = await supabase.auth.verifyOtp({
        email: normalized,
        token: token.trim(),
        type: 'recovery',
      });

      if (error) throw error;

      set({ isLoading: false });
      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Invalid or expired code',
        isLoading: false,
      });
      return false;
    }
  },

  setNewPasswordAfterReset: async (password) => {
    try {
      set({ isLoading: true, error: null });

      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      try {
        await supabase.rpc('log_password_reset_event', {
          p_event_type: 'password_changed',
        });
      } catch {
        /* optional audit */
      }

      await supabase.auth.signOut();
      useHomeCache.getState().clearHomeCache();
      set({ user: null, isLoading: false, authReady: true });
      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Could not update password',
        isLoading: false,
      });
      return false;
    }
  },

  /* ===== REGISTER (email-primary) ===== */
  register: async (data) => {
    try {
      set({ isLoading: true, error: null });

      const { email, password, phone, ...profile } = data;
      const normalizedEmail = normalizeEmail(email);
      const formattedPhone = phone ? formatPhoneE164(phone) : null;

      // Sign up with email + password (primary identity)
      // Pass ALL fields to raw_user_meta_data so the database trigger handles creation bypass RLS
      const { data: authData, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          data: {
            name: profile.name,
            phone: formattedPhone,
            business_name: profile.business_name || null,
            gstin: profile.gstin || null,
            address: profile.address || null,
            city: profile.city || null,
            state: profile.state || null,
            pincode: profile.pincode || null,
            retailer_code: profile.retailer_code || null,
          },
        },
      });

      if (error) throw error;

      // Only perform client-side upsert if we got a session back immediately (email confirm = OFF)
      if (authData.user && authData.session) {
        try {
          const { error: profileError } = await supabase
            .from('profiles')
            .upsert(
              {
                id: authData.user.id,
                email: normalizedEmail,
                phone: formattedPhone,
                ...profile,
                role: 'retailer',
                approved: false,
              },
              { onConflict: 'id' },
            );

          if (profileError) {
            console.log('Profile upsert warning (non-fatal):', profileError.message);
          }
        } catch (err) {
          console.log('Profile upsert caught warning (non-fatal):', err);
        }
      }

      if (authData.session?.user) {
        const appUser = await resolveUserFromSession();
        set({ user: appUser, isLoading: false });
      } else {
        set({ isLoading: false });
      }
      return true;
    } catch (err: any) {
      set({ error: mapRegistrationError(err), isLoading: false });
      return false;
    }
  },

  /* ===== UPDATE PROFILE ===== */
  updateProfile: async (data) => {
    try {
      set({ isLoading: true, error: null });

      const user = useAuthStore.getState().user;
      if (!user) throw new Error('Not logged in');

      const { error } = await supabase
        .from('profiles')
        .update(data)
        .eq('id', user.id);

      if (error) throw error;

      set({ user: { ...user, ...data }, isLoading: false });
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Update failed', isLoading: false });
      return false;
    }
  },

  /* ===== LOGOUT ===== */
  logout: async () => {
    await supabase.auth.signOut();
    try {
      await clearCredentials();
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), { phase: 'logout_clear_credentials' });
    }
    clearAll();
    useHomeCache.getState().clearHomeCache();
    set({ user: null, isLoading: false, authReady: true });
  },
}));
