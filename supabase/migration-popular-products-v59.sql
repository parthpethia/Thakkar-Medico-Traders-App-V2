-- =============================================================================
-- Thakkar Medico — V59: Popular Products RPC
--
-- Returns the most-ordered products across all users, ranked by the number of
-- distinct orders they appear in (order_count) then by total quantity sold.
-- Only active products are returned. Cancelled / rejected / payment_failed
-- orders are excluded.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_popular_products(
  p_limit  int DEFAULT 10
)
RETURNS TABLE (
  product_id      uuid,
  name            text,
  company         text,
  category        text,
  pack_size       text,
  image           text,
  mrp             numeric,
  selling_price   numeric,
  gst_percent     numeric,
  stock_quantity  int,
  is_active       boolean,
  created_at      timestamptz,
  order_count     bigint,
  total_qty       bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id            AS product_id,
    p.name,
    p.company,
    p.category,
    p.pack_size,
    p.image,
    p.mrp,
    p.selling_price,
    p.gst_percent,
    p.stock_quantity,
    p.is_active,
    p.created_at,
    COUNT(DISTINCT o.id)  AS order_count,
    COALESCE(SUM(oi.qty), 0) AS total_qty
  FROM public.order_items oi
  JOIN public.orders o   ON o.id = oi.order_id
  JOIN public.products p ON p.id = oi.product_id
  WHERE
    o.status NOT IN ('cancelled', 'rejected', 'payment_failed')
    AND p.is_active = true
  GROUP BY
    p.id, p.name, p.company, p.category, p.pack_size, p.image,
    p.mrp, p.selling_price, p.gst_percent, p.stock_quantity,
    p.is_active, p.created_at
  ORDER BY order_count DESC, total_qty DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_popular_products(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_popular_products(int) TO authenticated;

COMMIT;
