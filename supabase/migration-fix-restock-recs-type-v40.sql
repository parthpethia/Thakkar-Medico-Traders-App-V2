-- =============================================================================
-- Thakkar Medico — V40: Fix type mismatch in get_restock_recommendations
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_restock_recommendations(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  product_id              uuid,
  name                    text,
  company                 text,
  image                   text,
  selling_price           numeric,
  stock_quantity          integer,
  avg_interval_days       double precision,
  last_ordered_at         timestamptz,
  days_since_last_order   double precision,
  restock_urgency         double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_user_id IS NULL THEN
    p_user_id := auth.uid();
  END IF;

  IF auth.uid() = p_user_id
     OR (SELECT public.current_user_is_admin()) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
  WITH order_dates AS (
    SELECT
      oi.product_id,
      o.created_at,
      LAG(o.created_at) OVER (
        PARTITION BY oi.product_id ORDER BY o.created_at
      ) AS prev_order_at
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.user_id = p_user_id
      AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
  ),
  intervals AS (
    SELECT
      od.product_id,
      AVG(EXTRACT(EPOCH FROM (od.created_at - od.prev_order_at)) / 86400)
        AS avg_interval_days,
      COUNT(*) AS interval_count,
      MAX(od.created_at) AS last_ordered_at
    FROM order_dates od
    WHERE od.prev_order_at IS NOT NULL
    GROUP BY od.product_id
    HAVING COUNT(*) >= 1
  )
  SELECT
    i.product_id,
    p.name,
    p.company,
    p.image,
    p.selling_price,
    p.stock_quantity,
    i.avg_interval_days::double precision,
    i.last_ordered_at,
    (EXTRACT(EPOCH FROM (now() - i.last_ordered_at)) / 86400)::double precision
      AS days_since_last_order,
    ((EXTRACT(EPOCH FROM (now() - i.last_ordered_at)) / 86400)
      / GREATEST(i.avg_interval_days, 1))::double precision AS restock_urgency
  FROM intervals i
  JOIN public.products p ON p.id = i.product_id
  WHERE p.is_active = true
    AND p.stock_quantity > 0
    AND (EXTRACT(EPOCH FROM (now() - i.last_ordered_at)) / 86400)
        / GREATEST(i.avg_interval_days, 1) >= 0.8
  ORDER BY restock_urgency DESC
  LIMIT 12;
END;
$$;

REVOKE ALL ON FUNCTION public.get_restock_recommendations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_restock_recommendations(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_restock_recommendations(uuid) TO authenticated;

COMMIT;
