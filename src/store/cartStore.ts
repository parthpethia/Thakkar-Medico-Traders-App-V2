import { create } from 'zustand';
import { supabase } from '../services/supabase';

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

/* ================= STORE ================= */

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  loading: false,

  /* -------- FETCH CART -------- */
  fetchCart: async () => {
  set({ loading: true });

  const { data, error } = await supabase
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
    `);

  if (error) {
    console.error('Fetch cart error:', error);
    set({ loading: false });
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

  set({ items, loading: false });
},



  /* -------- ADD -------- */
  addToCart: async (productId, qty = 1) => {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const { error } = await supabase.from('cart_items').insert({
    user_id: user.id,
    product_id: productId,
    quantity: qty,
  });

  if (error) {
    console.error('Add to cart error:', error);
    return;
  }

  get().fetchCart();
},

  /* -------- UPDATE QUANTITY -------- */
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
      console.error('Update quantity error:', error);
      return;
    }

    await get().fetchCart();
  },

  /* -------- REMOVE -------- */
  removeFromCart: async (cartItemId) => {
    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', cartItemId);

    if (error) {
      console.error('Remove cart item error:', error);
      return;
    }

    await get().fetchCart();
  },

  /* -------- CLEAR -------- */
  clearCart: async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return;

    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('user_id', user.id);

    if (error) {
      console.error('Clear cart error:', error);
      return;
    }

    set({ items: [] });
  },
}));
