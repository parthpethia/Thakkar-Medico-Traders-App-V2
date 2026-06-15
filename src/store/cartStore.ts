import { create } from 'zustand';
import { supabase } from '../services/supabase';
import { useAuthStore } from './authStore';
import { isTransientNetworkError, supabaseErrorMessage } from '../utils/networkErrors';
import { executeSupabaseQuery } from '../utils/supabaseQuery';

/* ================= TYPES ================= */

export interface CartItem {
  id: string;
  product_id: string;
  quantity: number;

  // joined from products
  name: string;
  selling_price: number;
  gst_percent: number;
  image?: string | null;
}

interface CartState {
  items: CartItem[];
  loading: boolean;

  fetchCart: () => Promise<void>;
  addToCart: (productId: string, qty?: number) => Promise<void>;
  updateQuantity: (cartItemId: string, qty: number) => Promise<void>;
  removeFromCart: (cartItemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
}

/* ================= HELPERS ================= */

function getCurrentUserId(): string | null {
  return useAuthStore.getState().user?.id || null;
}

let fetchCartInFlight: Promise<void> | null = null;

/* ================= STORE ================= */

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  loading: false,

  fetchCart: async () => {
    const userId = getCurrentUserId();
    if (!userId) {
      set({ items: [], loading: false });
      return;
    }

    if (fetchCartInFlight) {
      return fetchCartInFlight;
    }

    fetchCartInFlight = (async () => {
      set({ loading: true });

      try {
        const { data, error } = await executeSupabaseQuery(() =>
          supabase
            .from('cart_items')
            .select(`
            id,
            product_id,
            quantity,
            products (
              name,
              selling_price,
              gst_percent
            )
          `)
            .eq('user_id', userId),
        );

        if (error) {
          if (!isTransientNetworkError(error)) {
            console.log('Fetch cart error:', supabaseErrorMessage(error));
          }
          return;
        }

        const items =
          data?.map((row: any) => ({
            id: row.id,
            product_id: row.product_id,
            quantity: row.quantity,
            name: row.products?.name ?? '',
            selling_price: row.products?.selling_price ?? 0,
            gst_percent: row.products?.gst_percent ?? 0,
          })) ?? [];

        set({ items });
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          console.log('Fetch cart error:', supabaseErrorMessage(err));
        }
      } finally {
        set({ loading: false });
        fetchCartInFlight = null;
      }
    })();

    return fetchCartInFlight;
  },

  addToCart: async (productId, qty = 1) => {
    const userId = getCurrentUserId();
    if (!userId) return;

    if (get().loading) return;
    set({ loading: true });

    try {
      const existing = get().items.find((i) => i.product_id === productId);

      if (existing) {
        await supabase
          .from('cart_items')
          .update({ quantity: existing.quantity + qty })
          .eq('id', existing.id);
      } else {
        await supabase.from('cart_items').insert({
          user_id: userId,
          product_id: productId,
          quantity: qty,
        });
      }
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        console.error('Add to cart error:', error);
      }
    }

    await get().fetchCart();
  },

  updateQuantity: async (cartItemId, qty) => {
    if (qty < 1) {
      await get().removeFromCart(cartItemId);
      return;
    }

    const { error } = await supabase
      .from('cart_items')
      .update({ quantity: qty })
      .eq('id', cartItemId);

    if (error) {
      if (!isTransientNetworkError(error)) {
        console.error('Update quantity error:', error);
      }
      return;
    }

    await get().fetchCart();
  },

  removeFromCart: async (cartItemId) => {
    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', cartItemId);

    if (error) {
      if (!isTransientNetworkError(error)) {
        console.error('Remove cart item error:', error);
      }
      return;
    }

    await get().fetchCart();
  },

  clearCart: async () => {
    const userId = getCurrentUserId();
    if (!userId) return;

    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);

    if (error) {
      if (!isTransientNetworkError(error)) {
        console.error('Clear cart error:', error);
      }
      return;
    }

    set({ items: [] });
  },
}));
