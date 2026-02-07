import { create } from 'zustand';
import api, { setToken, removeToken, getToken } from '../services/api';
import { User } from '../types';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  
  login: (phone: string, password: string) => Promise<boolean>;
  register: (data: RegisterData) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<boolean>;
  clearError: () => void;
}

interface RegisterData {
  phone: string;
  password: string;
  name: string;
  email?: string;
  business_name?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  error: null,

  login: async (phone: string, password: string) => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.post('/auth/login', { phone, password });
      await setToken(response.data.token);
      set({ user: response.data.user, isAuthenticated: true, isLoading: false });
      return true;
    } catch (error: any) {
      set({ 
        error: error.response?.data?.detail || 'Login failed', 
        isLoading: false 
      });
      return false;
    }
  },

  register: async (data: RegisterData) => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.post('/auth/register', data);
      await setToken(response.data.token);
      set({ user: response.data.user, isAuthenticated: true, isLoading: false });
      return true;
    } catch (error: any) {
      set({ 
        error: error.response?.data?.detail || 'Registration failed', 
        isLoading: false 
      });
      return false;
    }
  },

  logout: async () => {
    await removeToken();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    try {
      const token = await getToken();
      if (!token) {
        set({ isLoading: false, isAuthenticated: false });
        return;
      }
      const response = await api.get('/auth/me');
      set({ user: response.data, isAuthenticated: true, isLoading: false });
    } catch {
      await removeToken();
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  updateProfile: async (data: Partial<User>) => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.put('/auth/profile', data);
      set({ user: response.data, isLoading: false });
      return true;
    } catch (error: any) {
      set({ 
        error: error.response?.data?.detail || 'Update failed', 
        isLoading: false 
      });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
