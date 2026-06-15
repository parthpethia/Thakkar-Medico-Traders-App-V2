-- ============================================================================
-- Migration v8: Barcode / SKU Support
-- ============================================================================
-- Adds barcode_sku column to products and a lookup function for scanning.
-- All statements are idempotent — safe to re-run.
-- ============================================================================

-- 1. Add barcode_sku column to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_sku text;

-- 2. Unique index on barcode_sku (partial — only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_sku_idx
  ON products(barcode_sku)
  WHERE barcode_sku IS NOT NULL;

-- 3. Lookup function: find active product by barcode/SKU
CREATE OR REPLACE FUNCTION public.get_product_by_sku(p_sku text)
RETURNS SETOF public.products
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.products
  WHERE barcode_sku = p_sku
    AND is_active = true;
$$;

REVOKE ALL ON FUNCTION public.get_product_by_sku(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_by_sku(text) TO authenticated;
