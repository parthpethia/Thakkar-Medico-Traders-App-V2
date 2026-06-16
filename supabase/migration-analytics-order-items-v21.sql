-- =============================================================================
-- Analytics: get_top_products must read order_items (no direct SELECT for clients)
-- v17 set this RPC to SECURITY INVOKER; restore DEFINER with admin gate.
-- =============================================================================

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
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
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
REVOKE ALL ON FUNCTION public.get_top_products(timestamptz, timestamptz, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_top_products(timestamptz, timestamptz, int) TO authenticated;
