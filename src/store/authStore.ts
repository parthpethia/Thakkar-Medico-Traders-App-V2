import { create } from 'zustand';
import { supabase } from '../services/supabase';

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
  phone: string;
  role: 'admin' | 'retailer' | 'delivery';
  approved: boolean;
  name?: string;
  email?: string | null;
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
  isLoading: boolean;
  error: string | null;

  fetchUser: () => Promise<void>;
  login: (phone: string, password: string) => Promise<boolean>;
  register: (data: any) => Promise<boolean>;
  updateProfile: (data: Partial<AppUser>) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
};

/* ======================================================
   PROFILE SELECT FIELDS (single source of truth)
====================================================== */

const PROFILE_FIELDS =
  'approved, role, name, email, business_name, gstin, address, city, state, pincode, loyalty_points, credit_limit, credit_used';

/** Build AppUser from Supabase auth user + profile row */
function buildAppUser(
  authUser: { id: string; phone?: string | null; user_metadata?: any; app_metadata?: any },
  profile: Record<string, any> | null,
): AppUser {
  const resolvedRole = normalizeRole(
    profile?.role || authUser.app_metadata?.role,
  );

  return {
    id: authUser.id,
    phone: authUser.phone || '',
    role: resolvedRole,
    approved: profile?.approved ?? false,
    name: profile?.name || authUser.user_metadata?.name,
    email: profile?.email || null,
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

/* ======================================================
   STORE
====================================================== */

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  /* ===== RESTORE SESSION ===== */
  fetchUser: async () => {
    try {
      set({ isLoading: true });

      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        set({ user: null, isLoading: false });
        return;
      }

      const u = data.user;

      const { data: profile } = await supabase
        .from('profiles')
        .select(PROFILE_FIELDS)
        .eq('id', u.id)
        .single();

      set({ user: buildAppUser(u, profile), isLoading: false });
    } catch (err) {
      console.log('Fetch user error:', err);
      set({ user: null, isLoading: false });
    }
  },

  /* ===== LOGIN ===== */
  login: async (phone, password) => {
    try {
      set({ isLoading: true, error: null });

      const { data, error } = await supabase.auth.signInWithPassword({
        phone,
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

  /* ===== REGISTER ===== */
  register: async (data) => {
    try {
      set({ isLoading: true, error: null });

      const { phone, password, ...profile } = data;

      const { data: authData, error } = await supabase.auth.signUp({
        phone,
        password,
        options: { data: { name: profile.name } },
      });

      if (error) throw error;

      if (authData.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert(
            {
              id: authData.user.id,
              phone,
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
    set({ user: null });
  },
}));
