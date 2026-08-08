-- =============================================================================
-- Thakkar Medico — V55: RPC Query Consolidation & Load Reduction
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. get_retailer_profile_data: batches profile, loyalty history, stats, and audit logs
CREATE OR REPLACE FUNCTION public.get_retailer_profile_data(p_retailer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_result jsonb;
BEGIN
  -- Authorization check: caller must be user themselves, admin, or delivery
  SELECT role INTO v_caller_role FROM profiles WHERE id = v_caller_id;
  IF v_caller_id <> p_retailer_id AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
    'profile_extras', (
      SELECT jsonb_build_object(
        'push_enabled', push_enabled,
        'push_token', push_token,
        'preferred_language', preferred_language
      )
      FROM profiles WHERE id = p_retailer_id
    ),
    'loyalty_history', COALESCE((
      SELECT jsonb_agg(row_to_json(t))
      FROM (
        SELECT id, order_id, points, reason, type, created_at
        FROM loyalty_transactions
        WHERE retailer_id = p_retailer_id
        ORDER BY created_at DESC
        LIMIT 10
      ) t
    ), '[]'::jsonb),
    'stats', COALESCE((
      SELECT row_to_json(s)
      FROM get_retailer_stats(p_retailer_id) s
    ), '{}'::jsonb),
    'login_audit', COALESCE((
      SELECT jsonb_agg(row_to_json(a))
      FROM (
        SELECT id, event, created_at
        FROM login_audit
        WHERE user_id = p_retailer_id
        ORDER BY created_at DESC
        LIMIT 5
      ) a
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_retailer_profile_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_retailer_profile_data(uuid) TO authenticated;


-- 2. get_admin_dashboard_stats: aggregates admin metrics into a single response
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_today timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_today_orders int;
  v_today_revenue numeric;
  v_pending_orders int;
  v_total_users int;
  v_pending_users int;
  v_total_products int;
BEGIN
  -- Admin authority check
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only admins can view dashboard stats';
  END IF;

  SELECT COALESCE(COUNT(*)::int, 0), COALESCE(SUM(grand_total), 0)
    INTO v_today_orders, v_today_revenue
    FROM orders
   WHERE created_at >= p_today
     AND status <> 'cancelled';

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_pending_orders
    FROM orders
   WHERE status = 'pending';

  SELECT COALESCE(COUNT(*)::int, 0), COALESCE(COUNT(*) FILTER (WHERE approved = false)::int, 0)
    INTO v_total_users, v_pending_users
    FROM profiles;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_total_products
    FROM products;

  RETURN jsonb_build_object(
    'todayOrders', v_today_orders,
    'todayRevenue', v_today_revenue,
    'pendingOrders', v_pending_orders,
    'totalUsers', v_total_users,
    'pendingUsers', v_pending_users,
    'totalProducts', v_total_products
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats(timestamptz) TO authenticated;


-- 3. get_sales_analytics: groups 5 different sub-analytics RPCs
CREATE OR REPLACE FUNCTION public.get_sales_analytics(
  p_from_date timestamptz,
  p_to_date   timestamptz,
  p_limit     int DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          text;
  v_summary       jsonb;
  v_top_products  jsonb;
  v_top_retailers jsonb;
  v_daily_revenue jsonb;
  v_status_bd     jsonb;
BEGIN
  -- Admin authority check
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can access sales analytics';
  END IF;

  -- 1. Sales summary
  SELECT row_to_json(s) INTO v_summary FROM get_sales_summary(p_from_date, p_to_date) s;

  -- 2. Top products
  SELECT json_agg(row_to_json(p)) INTO v_top_products FROM get_top_products(p_from_date, p_to_date, p_limit) p;

  -- 3. Top retailers
  SELECT json_agg(row_to_json(r)) INTO v_top_retailers FROM get_top_retailers(p_from_date, p_to_date, p_limit) r;

  -- 4. Daily revenue
  SELECT json_agg(row_to_json(d)) INTO v_daily_revenue FROM get_daily_revenue(p_from_date, p_to_date) d;

  -- 5. Status breakdown
  SELECT json_agg(row_to_json(b)) INTO v_status_bd FROM get_status_breakdown(p_from_date, p_to_date) b;

  RETURN jsonb_build_object(
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'top_products', COALESCE(v_top_products, '[]'::jsonb),
    'top_retailers', COALESCE(v_top_retailers, '[]'::jsonb),
    'daily_revenue', COALESCE(v_daily_revenue, '[]'::jsonb),
    'status_breakdown', COALESCE(v_status_bd, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_sales_analytics(timestamptz, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_analytics(timestamptz, timestamptz, int) TO authenticated;

COMMIT;
