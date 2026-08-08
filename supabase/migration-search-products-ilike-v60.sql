-- =============================================================================
-- Thakkar Medico — V60: Improve search_products with ILIKE fallback
--
-- The existing full-text search uses plainto_tsquery('english', ...) which only
-- matches complete stemmed English words. This fails on:
--   • Partial product names (e.g. "para" won't match "paracetamol")
--   • Medicine/pharma names that the English stemmer doesn't know
--   • Short abbreviations or codes
--
-- This migration replaces the search branch with a two-tier strategy:
--   1. Full-text search (ts_rank) for relevance-ranked results
--   2. ILIKE fallback for partial/fuzzy matches not caught by full-text
-- Both tiers are UNION'd and deduplicated so the user sees all matches.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.search_products(text, int, int, text, boolean);

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
DECLARE
  v_query text;
BEGIN
  v_query := COALESCE(trim(p_query), '');

  IF v_query = '' THEN
    -- No search term: return all active products ordered by name with offset pagination
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
         AND (p_category IS NULL OR p.category = p_category)
       ORDER BY p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  ELSE
    -- Two-tier search: full-text (high relevance) UNION ILIKE (partial matches)
    -- Full-text hits get rank 1.0+ts_rank; ILIKE-only hits get rank 0.5
    -- This ensures full-text matches appear first, ILIKE fills the gaps
    RETURN QUERY
      SELECT s.id, s.name, s.company, s.category, s.sku, s.pack_size, s.image,
             s.mrp, s.selling_price, s.gst_percent, s.stock_quantity, s.is_active, s.created_at,
             s.unit
        FROM (
          -- Tier 1: Full-text search (stemmed word matching)
          SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
                 p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
                 p.pack_size AS unit,
                 (1.0 + ts_rank(p.search_vector, plainto_tsquery('english', v_query))) AS rank
            FROM public.products p
           WHERE p.is_active = true
             AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
             AND (p_category IS NULL OR p.category = p_category)
             AND p.search_vector @@ plainto_tsquery('english', v_query)

          UNION ALL

          -- Tier 2: ILIKE fallback (partial name, company, or SKU match)
          SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
                 p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
                 p.pack_size AS unit,
                 0.5 AS rank
            FROM public.products p
           WHERE p.is_active = true
             AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
             AND (p_category IS NULL OR p.category = p_category)
             AND (
               p.name ILIKE '%' || v_query || '%'
               OR p.company ILIKE '%' || v_query || '%'
               OR p.sku ILIKE '%' || v_query || '%'
             )
             -- Exclude rows already matched by full-text to avoid duplicates
             AND NOT (p.search_vector @@ plainto_tsquery('english', v_query))
        ) s
       ORDER BY s.rank DESC, s.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_products(text, int, int, text, boolean) TO authenticated;

COMMIT;
