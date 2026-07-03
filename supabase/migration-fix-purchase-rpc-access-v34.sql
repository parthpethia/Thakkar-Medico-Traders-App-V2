-- =============================================================================
-- Thakkar Medico — Fix purchase RPC access guards (v34)
-- =============================================================================
-- Root cause (v33): the first guard was `IF p_user_id IS NULL THEN access_denied`.
-- In the Supabase SQL editor, auth.uid() is often NULL (no user JWT on the session),
-- so get_retailer_purchase_history(auth.uid()) passes NULL as p_user_id and fails at
-- line 4 with a misleading access_denied — not an inverted admin check (Cause B).
-- The v33 second guard (auth.uid() IS DISTINCT FROM p_user_id + current_user_is_admin)
-- is correct for the mobile app when a real JWT is present.
--
-- current_user_is_admin() (v20): returns false when auth.uid() IS NULL; does not throw.
--
-- After deploy: SQL editor tests without a JWT will get not_authenticated. Validate
-- with the mobile app — e.g. temporary debug screen or console.log calling
-- supabase.rpc('get_retailer_purchase_history') from a logged-in retailer session.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_retailer_purchase_history(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  product_id        uuid,
  name              text,
  company           text,
  company_id        uuid,
  division_id       uuid,
  category_id       uuid,
  selling_price     numeric,
  stock_quantity    integer,
  is_active         boolean,
  image             text,
  total_qty_ordered bigint,
  order_count       bigint,
  last_ordered_at   timestamptz,
  first_ordered_at  timestamptz
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
  SELECT
    oi.product_id,
    p.name,
    p.company,
    p.company_id,
    p.division_id,
    p.category_id,
    p.selling_price,
    p.stock_quantity,
    p.is_active,
    p.image,
    SUM(oi.qty)           AS total_qty_ordered,
    COUNT(DISTINCT o.id)  AS order_count,
    MAX(o.created_at)     AS last_ordered_at,
    MIN(o.created_at)     AS first_ordered_at
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.products p ON p.id = oi.product_id
  WHERE
    o.user_id = p_user_id
    AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
    AND p.is_active = true
  GROUP BY
    oi.product_id, p.name, p.company, p.company_id,
    p.division_id, p.category_id, p.selling_price,
    p.stock_quantity, p.is_active, p.image
  ORDER BY total_qty_ordered DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_company_purchase_summary(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  company_id    uuid,
  company_name  text,
  company_slug  text,
  order_count   bigint,
  total_units   bigint,
  last_order_at timestamptz
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
  SELECT
    p.company_id,
    c.name        AS company_name,
    c.slug        AS company_slug,
    COUNT(DISTINCT o.id)   AS order_count,
    SUM(oi.qty)            AS total_units,
    MAX(o.created_at)      AS last_order_at
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.products p ON p.id = oi.product_id
  JOIN public.companies c ON c.id = p.company_id
  WHERE
    o.user_id = p_user_id
    AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
    AND p.company_id IS NOT NULL
  GROUP BY p.company_id, c.name, c.slug
  ORDER BY order_count DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_retailer_purchase_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_retailer_purchase_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_retailer_purchase_history(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_company_purchase_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_company_purchase_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_company_purchase_summary(uuid) TO authenticated;

-- =============================================================================
-- Test checklist (SQL editor + app)
-- =============================================================================
-- □ SELECT auth.uid(); in SQL editor — expect NULL without JWT; not_authenticated from RPCs
-- □ App: supabase.rpc('get_retailer_purchase_history') as retailer — rows or empty set
-- □ App: rpc with no arg (DEFAULT auth.uid()) — own data
-- □ App: retailer rpc('get_retailer_purchase_history', { p_user_id: other_uuid }) — access_denied
-- □ App: admin rpc for another retailer — succeeds
-- □ Same four cases for get_company_purchase_summary
-- □ Retailer with zero orders — empty result, no error
