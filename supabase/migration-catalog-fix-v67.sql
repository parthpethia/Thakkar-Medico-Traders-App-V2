-- =============================================================================
-- Thakkar Medico — V67: Catalog Fix & 0 Rs Out-of-Stock Enforcement
--
-- 1. Marks all products with price <= 0 as out-of-stock (stock_quantity = 0)
-- 2. Creates a BEFORE INSERT OR UPDATE trigger to automatically enforce stock_quantity = 0 for 0 Rs products
-- 3. Updates search_products to treat 0 Rs products as out of stock
-- 4. Updates get_active_companies to return all active companies without 1000 limit
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Mark existing 0 Rs or null price products as out of stock
-- -----------------------------------------------------------------------------
UPDATE public.products
SET stock_quantity = 0,
    updated_at = now()
WHERE selling_price IS NULL
   OR selling_price <= 0
   OR mrp IS NULL
   OR mrp <= 0;

-- -----------------------------------------------------------------------------
-- 2. Trigger function to enforce 0 Rs products have stock_quantity = 0
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_zero_price_out_of_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.selling_price IS NULL OR NEW.selling_price <= 0 OR NEW.mrp IS NULL OR NEW.mrp <= 0 THEN
    NEW.stock_quantity := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zero_price_out_of_stock ON public.products;
CREATE TRIGGER trg_zero_price_out_of_stock
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.enforce_zero_price_out_of_stock();

-- -----------------------------------------------------------------------------
-- 3. Update get_active_companies to return all distinct companies without limit
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_active_companies()
RETURNS TABLE (
  name text,
  product_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company AS name, COUNT(*) AS product_count
  FROM public.products
  WHERE is_active = true
    AND company IS NOT NULL
    AND TRIM(company) != ''
  GROUP BY company
  ORDER BY company ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_companies() TO authenticated, anon;

-- -----------------------------------------------------------------------------
-- 4. Update search_products to respect 0 Rs as out of stock
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_products(
  p_query              text    DEFAULT NULL,
  p_cursor             int     DEFAULT NULL,
  p_page_size          int     DEFAULT 30,
  p_category           text    DEFAULT NULL,
  p_hide_out_of_stock  boolean DEFAULT false
)
RETURNS TABLE (
  id              uuid,
  name            text,
  company         text,
  category        text,
  sku             text,
  pack_size       text,
  image           text,
  mrp             numeric,
  selling_price   numeric,
  gst_percent     numeric,
  stock_quantity  int,
  is_active       boolean,
  created_at      timestamptz,
  unit            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text;
BEGIN
  v_query := COALESCE(trim(p_query), '');

  IF v_query = '' THEN
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR (p.stock_quantity > 0 AND p.selling_price > 0))
         AND (p_category IS NULL OR p.category = p_category)
       ORDER BY p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  ELSE
    RETURN QUERY
      SELECT s.id, s.name, s.company, s.category, s.sku, s.pack_size, s.image,
             s.mrp, s.selling_price, s.gst_percent, s.stock_quantity, s.is_active, s.created_at,
             s.unit
        FROM (
          -- Tier 1: Full-text search
          SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
                 p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
                 p.pack_size AS unit,
                 (1.0 + ts_rank(p.search_vector, plainto_tsquery('english', v_query))) AS rank
            FROM public.products p
           WHERE p.is_active = true
             AND (NOT p_hide_out_of_stock OR (p.stock_quantity > 0 AND p.selling_price > 0))
             AND (p_category IS NULL OR p.category = p_category)
             AND p.search_vector @@ plainto_tsquery('english', v_query)

          UNION ALL

          -- Tier 2: ILIKE fallback
          SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
                 p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
                 p.pack_size AS unit,
                 0.5 AS rank
            FROM public.products p
           WHERE p.is_active = true
             AND (NOT p_hide_out_of_stock OR (p.stock_quantity > 0 AND p.selling_price > 0))
             AND (p_category IS NULL OR p.category = p_category)
             AND (
               p.name ILIKE '%' || v_query || '%'
               OR p.company ILIKE '%' || v_query || '%'
               OR p.sku ILIKE '%' || v_query || '%'
             )
             AND NOT (p.search_vector @@ plainto_tsquery('english', v_query))
        ) s
       ORDER BY s.rank DESC, s.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_products(text, int, int, text, boolean) TO authenticated, anon;

COMMIT;
