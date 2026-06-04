import { create } from 'zustand';
import { supabase, supabaseConfigError } from '../services/supabase';
import { withTimeout } from '../utils/withTimeout';
import { normalizeEmail, isValidEmail } from '../utils/email';
import { formatPhoneE164 } from '../utils/phone';

const AUTH_INIT_TIMEOUT_MS = 12000;
const PROFILE_FETCH_TIMEOUT_MS = 8000;

let initInFlight: Promise<void> | null = null;

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
  'approved, role, name, email, phone, business_name, gstin, address, city, state, pincode, loyalty_points, credit_limit, credit_used';

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
  };
}

async function loadProfileForUser(userId: string) {
  try {
    const { data: profile, error } = await withTimeout(
      supabase
        .from('profiles')
        .select(PROFILE_FIELDS)
        .eq('id', userId)
        .maybeSingle(),
      PROFILE_FETCH_TIMEOUT_MS,
      'Profile fetch',
    );
    if (error) {
      const msg = String(error.message || '');
      if (msg.includes('does not exist') || error.code === '42P01') {
        console.warn('profiles table missing — run supabase/setup.sql in Supabase SQL Editor');
        return null;
      }
      console.log('Profile fetch error:', error.message);
      return null;
    }
    return profile;
  } catch (err) {
    console.log('Profile fetch failed:', err);
    return null;
  }
}

async function resolveUserFromSession(): Promise<AppUser | null> {
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

  try {
    const profile = await loadProfileForUser(authUser.id);
    return buildAppUser(authUser, profile);
  } catch (err) {
    console.log('Profile load failed, using session only:', err);
    return buildAppUser(authUser, null);
  }
}

/* ======================================================
   HELPER: resolve phone number to email via RPC
====================================================== */

async function resolvePhoneToEmail(phone: string): Promise<string | null> {
  try {
    const e164 = formatPhoneE164(phone);
    const { data, error } = await supabase.rpc('get_email_by_phone', {
      p_phone: e164,
    });
    if (error) {
      console.log('Phone-to-email lookup error:', error.message);
      return null;
    }
    return data as string | null;
  } catch (err) {
    console.log('Phone-to-email lookup failed:', err);
    return null;
  }
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
  authReady: true,
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
      set({ initError: null });

      if (supabaseConfigError) {
        set({
          user: null,
          authReady: true,
          isLoading: false,
          initError: supabaseConfigError,
        });
        return;
      }

      try {
        const user = await resolveUserFromSession();
        set({ user, authReady: true, isLoading: false, initError: null });
      } catch (err: any) {
        console.log('Init auth error:', err);
        set({
          user: null,
          authReady: true,
          isLoading: false,
          initError: err?.message || 'Could not connect. Check internet and try again.',
        });
      } finally {
        initInFlight = null;
        if (!useAuthStore.getState().authReady) {
          set({ authReady: true, user: null, isLoading: false });
        }
      }
    })();

    return initInFlight;
  },

  /* ===== REFRESH SESSION (after sign-in / token refresh) ===== */
  fetchUser: async (options) => {
    const silent = options?.silent ?? false;

    try {
      if (!silent) {
        set({ isLoading: true });
      }

      const user = await resolveUserFromSession();
      set({ user, isLoading: false, initError: null });
    } catch (err) {
      console.log('Fetch user error:', err);
      set({ user: null, isLoading: false });
    }
  },

  /* ===== LOGIN (email or phone + password) ===== */
  login: async (identifier, password) => {
    try {
      set({ isLoading: true, error: null });

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
        throw new Error('Please enter a valid email or 10-digit phone number');
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      const u = data.user;

      const { data: profile } = await supabase
        .from('profiles')
        .select(PROFILE_FIELDS)
        .eq('id', u.id)
        .single();

      set({ user: buildAppUser(u, profile), isLoading: false });
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Login failed', isLoading: false });
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
      const { data: authData, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          data: {
            name: profile.name,
            phone: formattedPhone,
          },
        },
      });

      if (error) throw error;

      if (authData.user) {
        // Upsert profile with all fields (trigger creates a basic row,
        // but we upsert here to include business details)
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

        if (profileError) throw profileError;
      }

      set({ isLoading: false });
      return true;
    } catch (err: any) {
      set({ error: err.message || 'Registration failed', isLoading: false });
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
    set({ user: null, isLoading: false, authReady: true });
  },
}));
