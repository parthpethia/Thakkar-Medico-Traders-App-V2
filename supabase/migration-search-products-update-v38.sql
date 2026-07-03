-- =============================================================================
-- Thakkar Medico — V38: Update search_products RPC
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v3.sql
-- =============================================================================

BEGIN;

-- Drop the old search_products function so that we can change the signature
DROP FUNCTION IF EXISTS public.search_products(text, int, int);

-- Recreate search_products with parameters for category filtering and out-of-stock visibility
CREATE OR REPLACE FUNCTION public.search_products(
  p_query              text    DEFAULT NULL,
  p_cursor             int     DEFAULT NULL,
  p_page_size          int     DEFAULT 20,
  p_category           text    DEFAULT NULL,
  p_hide_out_of_stock  boolean DEFAULT true
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
BEGIN
  IF p_query IS NULL OR trim(p_query) = '' THEN
    -- No search term: return all active products ordered by name
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
         AND (p_category IS NULL OR p.category = p_category)
         AND (p_cursor IS NULL OR p.id > (
           SELECT p2.id FROM public.products p2
           WHERE p2.is_active = true 
             AND (NOT p_hide_out_of_stock OR p2.stock_quantity > 0)
             AND (p_category IS NULL OR p2.category = p_category)
           ORDER BY p2.name ASC
           OFFSET p_cursor - 1 LIMIT 1
         ))
       ORDER BY p.name ASC
       LIMIT p_page_size;
  ELSE
    -- Full-text search with ts_rank scoring
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
         AND (p_category IS NULL OR p.category = p_category)
         AND p.search_vector @@ plainto_tsquery('english', p_query)
       ORDER BY ts_rank(p.search_vector, plainto_tsquery('english', p_query)) DESC,
                p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.search_products(text, int, int, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_products(text, int, int, text, boolean) TO authenticated;

COMMIT;
