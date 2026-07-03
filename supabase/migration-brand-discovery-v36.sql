-- =============================================================================
-- Thakkar Medico — Brand discovery recommendations RPC (v36)
-- Tier 2 "New from brands you buy" rail: never-ordered products from top companies
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_brand_discovery_recommendations(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  product_id        uuid,
  name              text,
  image             text,
  selling_price     numeric,
  stock_quantity    integer,
  created_at        timestamptz,
  company_id        uuid,
  company_name      text,
  is_new_arrival    boolean
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
  WITH top_companies AS (
    SELECT p.company_id, COUNT(DISTINCT o.id) AS order_count
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.products p ON p.id = oi.product_id
    WHERE o.user_id = p_user_id
      AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
      AND p.company_id IS NOT NULL
    GROUP BY p.company_id
    ORDER BY order_count DESC
    LIMIT 3
  ),
  already_ordered AS (
    SELECT DISTINCT oi.product_id
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.user_id = p_user_id
      AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
  )
  SELECT
    p.id AS product_id,
    p.name,
    p.image,
    p.selling_price,
    p.stock_quantity,
    p.created_at,
    p.company_id,
    c.name AS company_name,
    (p.created_at >= now() - interval '60 days') AS is_new_arrival
  FROM public.products p
  JOIN public.companies c ON c.id = p.company_id
  JOIN top_companies tc ON tc.company_id = p.company_id
  WHERE p.is_active = true
    AND p.stock_quantity > 0
    AND p.id NOT IN (SELECT ao.product_id FROM already_ordered ao)
  ORDER BY is_new_arrival DESC, p.created_at DESC
  LIMIT 12;
END;
$$;

REVOKE ALL ON FUNCTION public.get_brand_discovery_recommendations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_brand_discovery_recommendations(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_brand_discovery_recommendations(uuid) TO authenticated;

-- =============================================================================
-- Test checklist
-- =============================================================================
-- □ Never-ordered in-stock products from top 3 companies appear
-- □ Already-ordered products excluded; OOS and inactive excluded
-- □ Single-company history still works; zero orders → empty set
-- □ is_new_arrival true when created_at within 60 days
-- □ Non-admin other uuid → access_denied; no JWT → not_authenticated
