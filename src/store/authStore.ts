import { create } from 'zustand';
import { supabase } from '../services/supabase';

export type AppUser = {
  id: string;
  phone: string;
  role: 'admin' | 'user';
  approved: boolean;
  name?: string;
  email?: string | null;
  business_name?: string | null;
  gstin?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
};

type AuthState = {
  user: AppUser | null;
  isLoading: boolean;
  error: string | null;

  fetchUser: () => Promise<void>;   // ✅ ADD THIS
  login: (phone: string, password: string) => Promise<boolean>;
  register: (data: any) => Promise<boolean>;
  updateProfile: (data: Partial<AppUser>) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  /* ✅ RESTORE SESSION */
  fetchUser: async () => {
    try {
      set({ isLoading: true });

      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        set({ user: null, isLoading: false });
        return;
      }

      const u = data.user;

      // Fetch approved status from profiles table (admin updates this)
      const { data: profile } = await supabase
        .from('profiles')
        .select('approved, name, email, business_name, gstin, address, city, state, pincode')
        .eq('id', u.id)
        .single();

      set({
        user: {
          id: u.id,
          phone: u.phone!,
          role: (u.app_metadata.role as any) || 'user',
          approved: profile?.approved ?? false,
          name: profile?.name || u.user_metadata?.name,
          email: profile?.email || null,
          business_name: profile?.business_name || null,
          gstin: profile?.gstin || null,
          address: profile?.address || null,
          city: profile?.city || null,
          state: profile?.state || null,
          pincode: profile?.pincode || null,
        },
        isLoading: false,
      });
    } catch (err) {
      console.log('Fetch user error:', err);
      set({ user: null, isLoading: false });
    }
  },

  login: async (phone, password) => {
    try {
      set({ isLoading: true, error: null });

      const { data, error } =
        await supabase.auth.signInWithPassword({
          phone,
          password,
        });

      if (error) throw error;

      const u = data.user;

      // Fetch approved status from profiles table
      const { data: profile } = await supabase
        .from('profiles')
        .select('approved, name, email, business_name, gstin, address, city, state, pincode')
        .eq('id', u.id)
        .single();

      set({
        user: {
          id: u.id,
          phone: u.phone!,
          role: (u.app_metadata.role as any) || 'user',
          approved: profile?.approved ?? false,
          name: profile?.name || u.user_metadata?.name,
          email: profile?.email || null,
          business_name: profile?.business_name || null,
          gstin: profile?.gstin || null,
          address: profile?.address || null,
          city: profile?.city || null,
          state: profile?.state || null,
          pincode: profile?.pincode || null,
        },
        isLoading: false,
      });

      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Login failed',
        isLoading: false,
      });
      return false;
    }
  },

  register: async (data) => {
    try {
      set({ isLoading: true, error: null });

      const { phone, password, ...profile } = data;

      const { data: authData, error } =
        await supabase.auth.signUp({
          phone,
          password,
          options: {
            data: {
              name: profile.name,
            },
          },
        });

      if (error) throw error;

      if (authData.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert({
            id: authData.user.id,
            phone,
            ...profile,
            role: 'retailer',
            approved: false,
          }, { onConflict: 'id' });

        if (profileError) throw profileError;
      }

      set({ isLoading: false });
      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Registration failed',
        isLoading: false,
      });
      return false;
    }
  },

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

      set({
        user: { ...user, ...data },
        isLoading: false,
      });

      return true;
    } catch (err: any) {
      set({
        error: err.message || 'Update failed',
        isLoading: false,
      });
      return false;
    }
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ user: null });
  },
}));
