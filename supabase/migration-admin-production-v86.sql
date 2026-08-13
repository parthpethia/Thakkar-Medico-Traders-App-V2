-- =============================================================================
-- Thakkar Medico — V86: Admin dashboard production RPCs (delivery ops + scale)
-- Run in Supabase SQL Editor on production before deploying admin app v1.0.27+
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Extended dashboard stats (single round-trip incl. logistics KPIs)
-- ---------------------------------------------------------------------------
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
  v_active_deliveries int;
  v_unassigned_delivery int;
  v_delivered_today int;
  v_failed_today int;
  v_riders_on_duty int;
  v_riders_online int;
  v_gps_since timestamptz := now() - interval '5 minutes';
BEGIN
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
   WHERE status IN ('pending', 'pending_payment', 'cancellation_requested');

  SELECT COALESCE(COUNT(*)::int, 0), COALESCE(COUNT(*) FILTER (WHERE approved = false)::int, 0)
    INTO v_total_users, v_pending_users
    FROM profiles;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_total_products
    FROM products;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_active_deliveries
    FROM orders o
   WHERE o.fulfillment_mode NOT IN ('pickup', 'self_pickup')
     AND o.status IN (
       'assigned', 'accepted', 'packed', 'dispatched',
       'in_transit', 'out_for_delivery', 'picked_up'
     );

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_unassigned_delivery
    FROM orders o
   WHERE o.fulfillment_mode NOT IN ('pickup', 'self_pickup')
     AND o.status IN ('approved', 'packed')
     AND o.assigned_to IS NULL;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_delivered_today
    FROM orders o
   WHERE o.status = 'delivered'
     AND o.delivered_at IS NOT NULL
     AND o.delivered_at >= p_today;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_failed_today
    FROM orders o
   WHERE o.status IN ('delivery_failed', 'failed')
     AND o.updated_at >= p_today;

  SELECT COALESCE(COUNT(*)::int, 0)
    INTO v_riders_on_duty
    FROM profiles p
   WHERE p.role IN ('delivery', 'driver')
     AND COALESCE(p.is_on_duty, false) = true;

  SELECT COALESCE(COUNT(DISTINCT dt.rider_id)::int, 0)
    INTO v_riders_online
    FROM delivery_tracking dt
   WHERE dt.updated_at >= v_gps_since
     AND dt.rider_id IS NOT NULL;

  RETURN jsonb_build_object(
    'todayOrders', v_today_orders,
    'todayRevenue', v_today_revenue,
    'pendingOrders', v_pending_orders,
    'totalUsers', v_total_users,
    'pendingUsers', v_pending_users,
    'totalProducts', v_total_products,
    'activeDeliveries', v_active_deliveries,
    'unassignedDelivery', v_unassigned_delivery,
    'deliveredToday', v_delivered_today,
    'failedToday', v_failed_today,
    'ridersOnDuty', v_riders_on_duty,
    'ridersOnline', v_riders_online
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_stats(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats(timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Delivery ops analytics for admin date ranges
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_delivery_ops_analytics(
  p_from_date timestamptz,
  p_to_date   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_role text;
  v_summary jsonb;
  v_top_riders jsonb;
  v_daily jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
    'delivered_count', COALESCE(COUNT(*) FILTER (WHERE o.status = 'delivered'), 0),
    'failed_count', COALESCE(COUNT(*) FILTER (WHERE o.status IN ('delivery_failed', 'failed')), 0),
    'in_transit_count', COALESCE(COUNT(*) FILTER (
      WHERE o.status IN ('dispatched', 'in_transit', 'out_for_delivery', 'picked_up')
    ), 0),
    'delivery_orders', COALESCE(COUNT(*) FILTER (
      WHERE o.fulfillment_mode NOT IN ('pickup', 'self_pickup')
    ), 0),
    'pickup_orders', COALESCE(COUNT(*) FILTER (
      WHERE o.fulfillment_mode IN ('pickup', 'self_pickup')
    ), 0),
    'avg_delivery_minutes', COALESCE(ROUND(AVG(
      EXTRACT(EPOCH FROM (o.delivered_at - o.dispatched_at)) / 60.0
    ) FILTER (
      WHERE o.status = 'delivered'
        AND o.delivered_at IS NOT NULL
        AND o.dispatched_at IS NOT NULL
        AND o.fulfillment_mode NOT IN ('pickup', 'self_pickup')
    ))::int, 0),
    'pod_count', (
      SELECT COALESCE(COUNT(*)::int, 0)
        FROM delivery_proofs dp
       WHERE dp.created_at >= p_from_date
         AND dp.created_at <= p_to_date
    )
  )
  INTO v_summary
  FROM orders o
  WHERE o.created_at >= p_from_date
    AND o.created_at <= p_to_date;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.delivered_count DESC), '[]'::jsonb)
  INTO v_top_riders
  FROM (
    SELECT
      p.id AS rider_id,
      COALESCE(p.name, p.business_name, 'Rider') AS rider_name,
      COUNT(*)::int AS delivered_count
    FROM orders o
    JOIN profiles p ON p.id = o.assigned_to
   WHERE o.status = 'delivered'
     AND o.delivered_at >= p_from_date
     AND o.delivered_at <= p_to_date
     AND o.fulfillment_mode NOT IN ('pickup', 'self_pickup')
   GROUP BY p.id, p.name, p.business_name
   ORDER BY delivered_count DESC
   LIMIT 10
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(d)::jsonb ORDER BY d.day ASC), '[]'::jsonb)
  INTO v_daily
  FROM (
    SELECT
      date_trunc('day', o.delivered_at)::date AS day,
      COUNT(*)::int AS delivered_count,
      COALESCE(COUNT(*) FILTER (WHERE o.status IN ('delivery_failed', 'failed')), 0)::int AS failed_count
    FROM orders o
   WHERE o.delivered_at >= p_from_date
     AND o.delivered_at <= p_to_date
     AND o.status = 'delivered'
   GROUP BY 1
   ORDER BY 1
  ) d;

  RETURN jsonb_build_object(
    'summary', v_summary,
    'top_riders', v_top_riders,
    'daily_deliveries', v_daily
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_ops_analytics(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_delivery_ops_analytics(timestamptz, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Paginated admin retailer list (credit + area; avoids loading 8k+ rows)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_retailers(
  p_query  text DEFAULT NULL,
  p_offset int DEFAULT 0,
  p_limit  int DEFAULT 50
)
RETURNS TABLE (
  id             uuid,
  name           text,
  phone          text,
  business_name  text,
  area           text,
  city           text,
  retailer_code  text,
  approved       boolean,
  credit_limit   numeric,
  credit_used    numeric,
  total_count    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_role  text;
  v_query text;
  v_limit int;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_query := NULLIF(trim(COALESCE(p_query, '')), '');

  IF v_query IS NULL THEN
    RETURN QUERY
      SELECT pr.id, pr.name, pr.phone, pr.business_name, pr.area, pr.city,
             pr.retailer_code, pr.approved, pr.credit_limit, pr.credit_used,
             COUNT(*) OVER() AS total_count
        FROM profiles pr
       WHERE pr.role = 'retailer'
       ORDER BY pr.business_name ASC NULLS LAST, pr.name ASC NULLS LAST
       LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
  ELSE
    RETURN QUERY
      SELECT pr.id, pr.name, pr.phone, pr.business_name, pr.area, pr.city,
             pr.retailer_code, pr.approved, pr.credit_limit, pr.credit_used,
             COUNT(*) OVER() AS total_count
        FROM profiles pr
       WHERE pr.role = 'retailer'
         AND (
           pr.name ILIKE '%' || v_query || '%'
           OR pr.business_name ILIKE '%' || v_query || '%'
           OR pr.phone ILIKE '%' || v_query || '%'
           OR pr.retailer_code ILIKE '%' || v_query || '%'
           OR pr.area ILIKE '%' || v_query || '%'
           OR pr.city ILIKE '%' || v_query || '%'
         )
       ORDER BY pr.business_name ASC NULLS LAST, pr.name ASC NULLS LAST
       LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_retailers(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_retailers(text, int, int) TO authenticated;

COMMIT;
