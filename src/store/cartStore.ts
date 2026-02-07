import { create } from 'zustand';
import api from '../services/api';
import { CartItem } from '../types';

interface CartState {
  items: CartItem[];
  isLoading: boolean;
  error: string | null;
  
  fetchCart: () => Promise<void>;
  addToCart: (productId: string, quantity: number) => Promise<boolean>;
  updateQuantity: (itemId: string, quantity: number) => Promise<boolean>;
  removeItem: (itemId: string) => Promise<boolean>;
  clearCart: () => Promise<void>;
  getTotal: () => { subtotal: number; itemCount: number };
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  isLoading: false,
  error: null,

  fetchCart: async () => {
    try {
      set({ isLoading: true, error: null });
      const response = await api.get('/cart');
      set({ items: response.data, isLoading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to fetch cart', isLoading: false });
    }
  },

  addToCart: async (productId: string, quantity: number) => {
    try {
      set({ isLoading: true, error: null });
      await api.post('/cart', { product_id: productId, quantity });
      await get().fetchCart();
      return true;
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to add to cart', isLoading: false });
      return false;
    }
  },

  updateQuantity: async (itemId: string, quantity: number) => {
    try {
      await api.put(`/cart/${itemId}?quantity=${quantity}`);
      await get().fetchCart();
      return true;
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to update cart' });
      return false;
    }
  },

  removeItem: async (itemId: string) => {
    try {
      await api.delete(`/cart/${itemId}`);
      await get().fetchCart();
      return true;
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to remove item' });
      return false;
    }
  },

  clearCart: async () => {
    try {
      await api.delete('/cart');
      set({ items: [] });
    } catch (error: any) {
      set({ error: error.response?.data?.detail || 'Failed to clear cart' });
    }
  },

  getTotal: () => {
    const items = get().items;
    const subtotal = items.reduce((sum, item) => sum + (item.selling_price * item.quantity), 0);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    return { subtotal, itemCount };
  },
}));
