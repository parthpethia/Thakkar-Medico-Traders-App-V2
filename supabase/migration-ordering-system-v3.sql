-- =============================================================================
-- Thakkar Medico — Ordering System V3 (P1) Migration
-- Keyset pagination, full-text search, order timeline, constraint guards
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v2.sql must have been run first
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: FIX C — Full-text search on products
-- =============================================================================

-- 1a. Generated tsvector column for product name + category search
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(name, '') || ' ' || coalesce(company, ''))
    ) STORED;

-- 1b. GIN index for fast full-text queries
CREATE INDEX IF NOT EXISTS products_search_idx
  ON public.products USING GIN (search_vector);


-- =============================================================================
-- SECTION 2: FIX A + B — get_orders_page (keyset pagination + filters)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_orders_page(
  p_role        text,
  p_user_id     uuid,
  p_status      text           DEFAULT NULL,
  p_cursor      timestamptz    DEFAULT NULL,
  p_cursor_id   uuid           DEFAULT NULL,
  p_page_size   int            DEFAULT 20,
  p_from_date   timestamptz    DEFAULT NULL,
  p_to_date     timestamptz    DEFAULT NULL
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT o.*
      FROM public.orders o
     WHERE
       -- Role-based visibility: retailers see only their own orders
       (p_role IN ('admin', 'delivery') OR o.user_id = p_user_id)

       -- Status filter
       AND (p_status IS NULL OR o.status = p_status)

       -- Date range filters
       AND (p_from_date IS NULL OR o.created_at >= p_from_date)
       AND (p_to_date   IS NULL OR o.created_at <= p_to_date)

       -- Keyset cursor: fetch rows strictly before the last-seen (created_at, id)
       AND (
         p_cursor IS NULL
         OR (o.created_at, o.id) < (p_cursor, p_cursor_id)
       )

     ORDER BY o.created_at DESC, o.id DESC
     LIMIT p_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz) TO authenticated;


-- =============================================================================
-- SECTION 3: FIX C — search_products (paginated product search)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.search_products(
  p_query      text    DEFAULT NULL,
  p_cursor     int     DEFAULT NULL,
  p_page_size  int     DEFAULT 20
)
RETURNS TABLE (
  id              uuid,
  name            text,
  company         text,
  selling_price   numeric,
  gst_percent     numeric,
  stock_quantity  int,
  unit            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_query IS NULL OR trim(p_query) = '' THEN
    -- No search term: return all active in-stock products ordered by name
    RETURN QUERY
      SELECT p.id, p.name, p.company,
             p.selling_price, p.gst_percent,
             p.stock_quantity, p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND p.stock_quantity > 0
         AND (p_cursor IS NULL OR p.id > (
           SELECT p2.id FROM public.products p2
           WHERE p2.is_active = true AND p2.stock_quantity > 0
           ORDER BY p2.name ASC
           OFFSET p_cursor - 1 LIMIT 1
         ))
       ORDER BY p.name ASC
       LIMIT p_page_size;
  ELSE
    -- Full-text search with ts_rank scoring
    RETURN QUERY
      SELECT p.id, p.name, p.company,
             p.selling_price, p.gst_percent,
             p.stock_quantity, p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND p.stock_quantity > 0
         AND p.search_vector @@ plainto_tsquery('english', p_query)
       ORDER BY ts_rank(p.search_vector, plainto_tsquery('english', p_query)) DESC,
                p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.search_products(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_products(text, int, int) TO authenticated;


-- =============================================================================
-- SECTION 4: FIX D — get_order_timeline (audit log for order detail)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_order_timeline(p_order_id uuid)
RETURNS TABLE (
  from_status  text,
  to_status    text,
  actor_name   text,
  created_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT e.from_status,
           e.to_status,
           COALESCE(pr.name, pr.business_name, 'System') AS actor_name,
           e.created_at
      FROM public.order_status_events e
      LEFT JOIN public.profiles pr ON pr.id = e.actor_id
     WHERE e.order_id = p_order_id
     ORDER BY e.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_order_timeline(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_timeline(uuid) TO authenticated;


-- =============================================================================
-- SECTION 5: FIX E — Constraint guards (idempotent, safe to re-run)
-- =============================================================================

-- 5a. UNIQUE on order_number (already created in V2, but confirm)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_order_number_unique'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);
  END IF;
END $$;

-- 5b. Composite index for keyset pagination queries
CREATE INDEX IF NOT EXISTS idx_orders_created_at_id
  ON public.orders (created_at DESC, id DESC);


COMMIT;
