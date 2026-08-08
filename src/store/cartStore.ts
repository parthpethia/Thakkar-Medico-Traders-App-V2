import { create } from 'zustand';
import { supabase } from '../services/supabase';
import { useAuthStore } from './authStore';
import { isTransientNetworkError, supabaseErrorMessage } from '../utils/networkErrors';
import { executeSupabaseQuery } from '../utils/supabaseQuery';
import { handleSessionExpired } from '../utils/sessionExpired';

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

  // packaging context (local only — not persisted in cart_items table)
  packaging_level_id?: string | null;
  packaging_level_name?: string | null;
  units_per_level: number;
  min_order_qty: number;
  increment_step: number;
}

export type AddToCartResult = true | false | { error: string };

interface CartState {
  items: CartItem[];
  loading: boolean;
  cartSyncError: boolean;

  fetchCart: () => Promise<void>;
  addToCart: (productId: string, qty?: number, packaging?: {
    packaging_level_id?: string;
    packaging_level_name?: string;
    units_per_level?: number;
    min_order_qty?: number;
    increment_step?: number;
  }) => Promise<AddToCartResult>;
  updateQuantity: (cartItemId: string, qty: number) => Promise<void>;
  removeFromCart: (cartItemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
}

/* ================= HELPERS ================= */

/**
 * OPT-1: Reads user ID from Zustand store synchronously.
 * Previously called supabase.auth.getSession() on every cart operation,
 * adding ~50-100 unnecessary network requests per hour.
 */
function getCartUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

function isPermissionDenied(err: unknown): boolean {
  const msg = supabaseErrorMessage(err).toLowerCase();
  return msg.includes('42501') || msg.includes('permission denied');
}

let fetchCartInFlight: Promise<void> | null = null;

/* ================= STORE ================= */

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  loading: false,
  cartSyncError: false,

  fetchCart: async () => {
    const { authReady } = useAuthStore.getState();
    if (!authReady) return;

    const userId = getCartUserId();
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
          if (isPermissionDenied(error)) {
            await supabase.auth.refreshSession().catch(() => {});
            const retryUserId = await getCartUserId();
            if (retryUserId) {
              const retry = await executeSupabaseQuery(() =>
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
                  .eq('user_id', retryUserId),
              );
              if (!retry.error && retry.data) {
                const items =
                  retry.data?.map((row: any) => ({
                    id: row.id,
                    product_id: row.product_id,
                    quantity: row.quantity,
                    name: row.products?.name ?? '',
                    selling_price: row.products?.selling_price ?? 0,
                    gst_percent: row.products?.gst_percent ?? 0,
                    units_per_level: 1,
                    min_order_qty: 1,
                    increment_step: 1,
                  })) ?? [];
                set({ items, cartSyncError: false });
                return;
              }
            }
          }
          if (!isTransientNetworkError(error)) {
            console.log('Fetch cart error:', supabaseErrorMessage(error));
          }
          if (isPermissionDenied(error)) {
            // H2: JWT expired and refresh failed — force clean sign-out
            handleSessionExpired();
          }
          set({ cartSyncError: isPermissionDenied(error) });
          return;
        }

        set({ cartSyncError: false });

        const items =
          data?.map((row: any) => ({
            id: row.id,
            product_id: row.product_id,
            quantity: row.quantity,
            name: row.products?.name ?? '',
            selling_price: row.products?.selling_price ?? 0,
            gst_percent: row.products?.gst_percent ?? 0,
            units_per_level: 1,
            min_order_qty: 1,
            increment_step: 1,
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

  addToCart: async (productId, qty = 1, packaging) => {
    const userId = getCartUserId();
    if (!userId) return false;

    if (get().loading) return false;
    set({ loading: true });

    try {
      const { data: productRow, error: productError } = await supabase
        .from('products')
        .select('stock_quantity, name, selling_price, gst_percent')
        .eq('id', productId)
        .maybeSingle();

      if (productError || productRow == null) {
        set({ loading: false });
        return false;
      }

      if (productRow.stock_quantity <= 0 || (productRow.selling_price ?? 0) <= 0) {
        set({ loading: false });
        return { error: 'This product is currently out of stock or unavailable.' };
      }

      const existingLevelId = packaging?.packaging_level_id ?? null;
      const existing = get().items.find(
        (i) => i.product_id === productId
          && (i.packaging_level_id ?? null) === existingLevelId,
      );

      if (existing) {
        const newQty = existing.quantity + qty;
        const { error } = await supabase
          .from('cart_items')
          .update({ quantity: newQty })
          .eq('id', existing.id);
        if (error) {
          if (!isTransientNetworkError(error)) {
            console.error('Add to cart error:', supabaseErrorMessage(error));
          }
          set({ loading: false });
          return false;
        }
        // OPT-2: Optimistic local update — no refetch needed
        set({
          items: get().items.map((i) =>
            i.id === existing.id ? { ...i, quantity: newQty } : i
          ),
          loading: false,
        });
        return true;
      } else {
        const { data: inserted, error } = await supabase
          .from('cart_items')
          .insert({
            user_id: userId,
            product_id: productId,
            quantity: qty,
          })
          .select('id')
          .single();
        if (error) {
          if (!isTransientNetworkError(error)) {
            console.error('Add to cart error:', supabaseErrorMessage(error));
          }
          set({ loading: false });
          return false;
        }
        // OPT-2: Optimistic local splice — no refetch needed
        const newItem: CartItem = {
          id: inserted?.id ?? `temp-${Date.now()}`,
          product_id: productId,
          quantity: qty,
          name: productRow.name ?? '',
          selling_price: productRow.selling_price ?? 0,
          gst_percent: productRow.gst_percent ?? 0,
          packaging_level_id: packaging?.packaging_level_id ?? null,
          packaging_level_name: packaging?.packaging_level_name ?? null,
          units_per_level: packaging?.units_per_level ?? 1,
          min_order_qty: packaging?.min_order_qty ?? 1,
          increment_step: packaging?.increment_step ?? 1,
        };
        set({
          items: [...get().items, newItem],
          loading: false,
        });
        return true;
      }
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        console.error('Add to cart error:', error);
      }
      set({ loading: false });
      return false;
    }
  },

  updateQuantity: async (cartItemId, qty) => {
    if (qty < 1) {
      void get().removeFromCart(cartItemId);
      return;
    }

    const originalItems = get().items;

    set({
      items: originalItems.map((item) =>
        item.id === cartItemId ? { ...item, quantity: qty } : item
      ),
    });

    (async () => {
      try {
        const { error } = await supabase
          .from('cart_items')
          .update({ quantity: qty })
          .eq('id', cartItemId);

        if (error) {
          throw error;
        }

        set({ cartSyncError: false });
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          console.error('Update quantity error:', err);
        }
        set({ items: originalItems, cartSyncError: true });
        await get().fetchCart();
      }
    })();
  },

  removeFromCart: async (cartItemId) => {
    const originalItems = get().items;

    set({
      items: originalItems.filter((item) => item.id !== cartItemId),
    });

    (async () => {
      try {
        const { error } = await supabase
          .from('cart_items')
          .delete()
          .eq('id', cartItemId);

        if (error) {
          throw error;
        }

        set({ cartSyncError: false });
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          console.error('Remove cart item error:', err);
        }
        set({ items: originalItems, cartSyncError: true });
        await get().fetchCart();
      }
    })();
  },

  clearCart: async () => {
    const userId = getCartUserId();
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
