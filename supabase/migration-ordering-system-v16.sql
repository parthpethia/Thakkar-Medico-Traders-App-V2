-- ============================================================================
-- Migration v16: Drop duplicate index on cart_items
-- ============================================================================
-- Advisor: cart_items_user_id_product_id_key and cart_unique_product are identical.
-- Keep the constraint index from setup.sql UNIQUE (user_id, product_id).
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_unique_product;

DROP INDEX IF EXISTS public.cart_unique_product;
DROP INDEX IF EXISTS public.idx_cart_items_user_id_product_id;
DROP INDEX IF EXISTS public.cart_items_user_id_product_id_idx;
