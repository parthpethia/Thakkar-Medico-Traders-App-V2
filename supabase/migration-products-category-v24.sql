-- Admin product management (v7 upsert_product, list UI) expects products.category.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS idx_products_category
  ON public.products (category)
  WHERE category IS NOT NULL;

COMMENT ON COLUMN public.products.category IS 'Optional product category for admin catalog and filtering';
