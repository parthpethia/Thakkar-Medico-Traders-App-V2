-- =============================================================================
-- Thakkar Medico — Ordering System V6 (P4) Migration
-- Analytics, Stock Management, Delivery Route Grouping, Performance Monitoring
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v5.sql (or prior) must have been run
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: FIX A — Analytics Functions (Admin Dashboard)
-- =============================================================================

-- 1a. get_sales_summary: returns summary metrics for a date range
CREATE OR REPLACE FUNCTION public.get_sales_summary(
  p_from_date timestamptz,
  p_to_date   timestamptz
)
RETURNS TABLE (
  total_orders              int,
  delivered_orders          int,
  cancelled_orders          int,
  gross_revenue             numeric,
  discount_given            numeric,
  net_revenue               numeric,
  avg_order_value           numeric,
  total_credit_outstanding  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access sales summary';
  END IF;

  RETURN QUERY
    WITH order_stats AS (
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS delivered_orders,
        COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_orders,
        COALESCE(SUM(o.grand_total) FILTER (WHERE o.status = 'delivered'), 0) AS gross_revenue,
        COALESCE(SUM(COALESCE(o.discount_amount, 0)) FILTER (WHERE o.status = 'delivered'), 0) AS discount_given
      FROM public.orders o
      WHERE o.created_at >= p_from_date
        AND o.created_at <= p_to_date
    ),
    credit_stats AS (
      SELECT COALESCE(SUM(p.credit_used), 0) AS total_credit_outstanding
      FROM public.profiles p
      WHERE p.role = 'retailer'
    )
    SELECT
      os.total_orders,
      os.delivered_orders,
      os.cancelled_orders,
      os.gross_revenue,
      os.discount_given,
      (os.gross_revenue - os.discount_given) AS net_revenue,
      CASE WHEN os.delivered_orders > 0
        THEN ROUND(os.gross_revenue / os.delivered_orders, 2)
        ELSE 0
      END AS avg_order_value,
      cs.total_credit_outstanding
    FROM order_stats os, credit_stats cs;
END;
$$;

REVOKE ALL ON FUNCTION public.get_sales_summary(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_summary(timestamptz, timestamptz) TO authenticated;


-- 1b. get_top_products: top selling products by revenue in a date range
CREATE OR REPLACE FUNCTION public.get_top_products(
  p_from_date timestamptz,
  p_to_date   timestamptz,
  p_limit     int DEFAULT 10
)
RETURNS TABLE (
  product_id      uuid,
  product_name    text,
  total_qty_sold  int,
  total_revenue   numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access top products';
  END IF;

  RETURN QUERY
    SELECT
      oi.product_id,
      pr.name AS product_name,
      SUM(oi.qty)::int AS total_qty_sold,
      SUM(oi.line_total) AS total_revenue
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.products pr ON pr.id = oi.product_id
    WHERE o.status = 'delivered'
      AND o.created_at >= p_from_date
      AND o.created_at <= p_to_date
    GROUP BY oi.product_id, pr.name
    ORDER BY total_revenue DESC
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_top_products(timestamptz, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_top_products(timestamptz, timestamptz, int) TO authenticated;


-- 1c. get_top_retailers: top retailers by order value in a date range
CREATE OR REPLACE FUNCTION public.get_top_retailers(
  p_from_date timestamptz,
  p_to_date   timestamptz,
  p_limit     int DEFAULT 10
)
RETURNS TABLE (
  retailer_id    uuid,
  retailer_name  text,
  order_count    int,
  total_value    numeric,
  credit_used    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access top retailers';
  END IF;

  RETURN QUERY
    SELECT
      o.user_id AS retailer_id,
      COALESCE(p.name, p.business_name, 'Unknown') AS retailer_name,
      COUNT(*)::int AS order_count,
      SUM(o.grand_total) AS total_value,
      COALESCE(p.credit_used, 0) AS credit_used
    FROM public.orders o
    JOIN public.profiles p ON p.id = o.user_id
    WHERE o.status = 'delivered'
      AND o.created_at >= p_from_date
      AND o.created_at <= p_to_date
    GROUP BY o.user_id, p.name, p.business_name, p.credit_used
    ORDER BY total_value DESC
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_top_retailers(timestamptz, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_top_retailers(timestamptz, timestamptz, int) TO authenticated;


-- 1d. get_daily_revenue: daily revenue breakdown for charting
CREATE OR REPLACE FUNCTION public.get_daily_revenue(
  p_from_date timestamptz,
  p_to_date   timestamptz
)
RETURNS TABLE (
  day      date,
  orders   int,
  revenue  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access daily revenue';
  END IF;

  RETURN QUERY
    SELECT
      DATE(o.created_at) AS day,
      COUNT(*)::int AS orders,
      COALESCE(SUM(o.grand_total), 0) AS revenue
    FROM public.orders o
    WHERE o.status = 'delivered'
      AND o.created_at >= p_from_date
      AND o.created_at <= p_to_date
    GROUP BY DATE(o.created_at)
    ORDER BY day ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_revenue(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_revenue(timestamptz, timestamptz) TO authenticated;


-- 1e. get_status_breakdown: order status distribution for a date range
CREATE OR REPLACE FUNCTION public.get_status_breakdown(
  p_from_date timestamptz,
  p_to_date   timestamptz
)
RETURNS TABLE (
  status   text,
  count    int,
  percent  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_total int;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access status breakdown';
  END IF;

  SELECT COUNT(*)::int INTO v_total
  FROM public.orders o
  WHERE o.created_at >= p_from_date
    AND o.created_at <= p_to_date;

  RETURN QUERY
    SELECT
      o.status,
      COUNT(*)::int AS count,
      CASE WHEN v_total > 0
        THEN ROUND((COUNT(*)::numeric / v_total) * 100, 1)
        ELSE 0
      END AS percent
    FROM public.orders o
    WHERE o.created_at >= p_from_date
      AND o.created_at <= p_to_date
    GROUP BY o.status
    ORDER BY count DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_status_breakdown(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_status_breakdown(timestamptz, timestamptz) TO authenticated;


-- =============================================================================
-- SECTION 2: FIX B — Stock Management
-- =============================================================================

-- 2a. Add low_stock_threshold to settings
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS low_stock_threshold int NOT NULL DEFAULT 10;

-- 2b. Add last_alerted_at to products (for low stock alert debounce)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;

-- 2c. stock_adjustments table
CREATE TABLE IF NOT EXISTS public.stock_adjustments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid        NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  quantity_delta int        NOT NULL,
  reason        text        NOT NULL CHECK (reason IN ('restock','writeoff','correction','return')),
  adjusted_by   uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product
  ON public.stock_adjustments (product_id, created_at DESC);

-- RLS for stock_adjustments
ALTER TABLE public.stock_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_adjustments_select_staff" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_select_staff" ON public.stock_adjustments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "stock_adjustments_insert_admin" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_insert_admin" ON public.stock_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- 2d. adjust_stock RPC — atomic stock adjustment
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_product_id uuid,
  p_delta      int,
  p_reason     text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          text;
  v_current_stock int;
  v_new_stock     int;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can adjust stock';
  END IF;

  IF p_reason NOT IN ('restock','writeoff','correction','return') THEN
    RAISE EXCEPTION 'invalid_reason' USING HINT = 'Reason must be restock, writeoff, correction, or return';
  END IF;

  -- Lock product row
  SELECT stock_quantity INTO v_current_stock
  FROM public.products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found' USING HINT = 'Product does not exist';
  END IF;

  v_new_stock := v_current_stock + p_delta;

  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'stock_below_zero'
      USING HINT = format('Cannot reduce stock below 0. Current: %s, delta: %s', v_current_stock, p_delta);
  END IF;

  -- Update product stock
  UPDATE public.products
  SET stock_quantity = v_new_stock
  WHERE id = p_product_id;

  -- Insert into stock_adjustments
  INSERT INTO public.stock_adjustments (product_id, quantity_delta, reason, adjusted_by)
  VALUES (p_product_id, p_delta, p_reason, auth.uid());

  -- Insert into stock_history
  INSERT INTO public.stock_history (product_id, change, reason)
  VALUES (p_product_id, p_delta, p_reason || ' (manual adjustment)');

  RETURN v_new_stock;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_stock(uuid, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, int, text) TO authenticated;


-- 2e. get_low_stock_products
CREATE OR REPLACE FUNCTION public.get_low_stock_products(
  p_threshold int DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  name            text,
  company         text,
  stock_quantity  int,
  threshold       int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_threshold int;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can access low stock products';
  END IF;

  IF p_threshold IS NOT NULL THEN
    v_threshold := p_threshold;
  ELSE
    SELECT COALESCE(s.low_stock_threshold, 10) INTO v_threshold
    FROM public.settings s
    LIMIT 1;
  END IF;

  RETURN QUERY
    SELECT
      p.id,
      p.name,
      p.company,
      p.stock_quantity,
      v_threshold AS threshold
    FROM public.products p
    WHERE p.stock_quantity <= v_threshold
      AND p.is_active = true
    ORDER BY p.stock_quantity ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_low_stock_products(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_low_stock_products(int) TO authenticated;


-- 2f. Add reason column to notifications_log (for low_stock alerts)
ALTER TABLE public.notifications_log
  ADD COLUMN IF NOT EXISTS reason text;


-- =============================================================================
-- SECTION 3: FIX D — Delivery Route Grouping
-- =============================================================================

-- 3a. Add area to profiles (retailer's delivery area/zone)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS area text;

-- 3b. get_delivery_summary: group today's delivery orders by area
CREATE OR REPLACE FUNCTION public.get_delivery_summary(
  p_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  area           text,
  pending_count  int,
  approved_count int,
  total_orders   int,
  retailer_names text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can access delivery summary';
  END IF;

  RETURN QUERY
    SELECT
      COALESCE(p.area, 'Unassigned') AS area,
      COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE o.status IN ('approved', 'packed'))::int AS approved_count,
      COUNT(*)::int AS total_orders,
      ARRAY_AGG(DISTINCT COALESCE(p.name, p.business_name, 'Unknown')) AS retailer_names
    FROM public.orders o
    JOIN public.profiles p ON p.id = o.user_id
    WHERE o.fulfillment_mode = 'delivery'
      AND o.status IN ('pending', 'approved', 'packed')
      AND DATE(o.created_at) = p_date
    GROUP BY COALESCE(p.area, 'Unassigned')
    ORDER BY total_orders DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_summary(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_delivery_summary(date) TO authenticated;


-- 3c. CHANGED — Update get_orders_page to support p_area filter
-- Drop the old 8-param signature first to avoid overload conflicts
DROP FUNCTION IF EXISTS public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.get_orders_page(
  p_role        text,
  p_user_id     uuid,
  p_status      text           DEFAULT NULL,
  p_cursor      timestamptz    DEFAULT NULL,
  p_cursor_id   uuid           DEFAULT NULL,
  p_page_size   int            DEFAULT 20,
  p_from_date   timestamptz    DEFAULT NULL,
  p_to_date     timestamptz    DEFAULT NULL,
  p_area        text           DEFAULT NULL    -- CHANGED: added area filter for FIX D
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
      LEFT JOIN public.profiles prof ON prof.id = o.user_id  -- CHANGED: join for area filter
     WHERE
       -- Role-based visibility: retailers see only their own orders
       (p_role IN ('admin', 'delivery') OR o.user_id = p_user_id)

       -- Status filter
       AND (p_status IS NULL OR o.status = p_status)

       -- Date range filters
       AND (p_from_date IS NULL OR o.created_at >= p_from_date)
       AND (p_to_date   IS NULL OR o.created_at <= p_to_date)

       -- CHANGED: Area filter
       AND (p_area IS NULL OR COALESCE(prof.area, 'Unassigned') = p_area)

       -- Keyset cursor: fetch rows strictly before the last-seen (created_at, id)
       AND (
         p_cursor IS NULL
         OR (o.created_at, o.id) < (p_cursor, p_cursor_id)
       )

     ORDER BY o.created_at DESC, o.id DESC
     LIMIT p_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text) TO authenticated;


-- =============================================================================
-- SECTION 4: FIX E — Performance Monitoring (pg_stat_statements view)
-- =============================================================================

-- NOTE: pg_stat_statements extension must be enabled in your Supabase project.
-- Go to Database → Extensions → Enable pg_stat_statements
-- If not enabled, comment out this section.

-- Create a helper view for admins to inspect slow RPCs
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
  ) THEN
    EXECUTE '
      CREATE OR REPLACE VIEW public.slow_rpc_candidates
      WITH (security_invoker = true)
      AS
      SELECT query, calls, mean_exec_time, total_exec_time
      FROM pg_stat_statements
      WHERE query ILIKE ''%place_order%''
         OR query ILIKE ''%get_orders_page%''
         OR query ILIKE ''%search_products%''
         OR query ILIKE ''%get_sales_summary%''
         OR query ILIKE ''%get_top_products%''
      ORDER BY mean_exec_time DESC
      LIMIT 20;
    ';
    EXECUTE 'REVOKE ALL ON public.slow_rpc_candidates FROM PUBLIC;';
    EXECUTE 'REVOKE ALL ON public.slow_rpc_candidates FROM authenticated;';
    EXECUTE 'GRANT SELECT ON public.slow_rpc_candidates TO service_role;';
  END IF;
END $$;


COMMIT;
