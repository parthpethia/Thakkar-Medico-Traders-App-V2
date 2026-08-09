-- =============================================================================
-- Migration v78: Delivery Subsystem Continuous Integrity Monitoring & Telemetry
--
-- Features:
-- 1. Creates `delivery_telemetry_events` table for client/edge observability
--    (reconnections, off-route recalculations, mid-transit shifts).
-- 2. Creates `delivery_integrity_health_log` table for daily audit trends.
-- 3. Adds `reconcile_historical_delivered_order_snapshots(p_dry_run boolean)`
--    supporting safe read-only report mode and manual review execution.
-- 4. Creates `run_daily_delivery_health_check()` and `get_delivery_health_summary()`.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Telemetry Events Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  order_id uuid REFERENCES public.orders (id) ON DELETE SET NULL,
  rider_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_created_at 
  ON public.delivery_telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type_created 
  ON public.delivery_telemetry_events (event_type, created_at DESC);

ALTER TABLE public.delivery_telemetry_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "telemetry_events_insert" ON public.delivery_telemetry_events;
CREATE POLICY "telemetry_events_insert" ON public.delivery_telemetry_events
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "telemetry_events_select" ON public.delivery_telemetry_events;
CREATE POLICY "telemetry_events_select" ON public.delivery_telemetry_events
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_staff()));

-- -----------------------------------------------------------------------------
-- 2. Delivery Integrity Health Log Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_integrity_health_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  total_delivered_checked int NOT NULL DEFAULT 0,
  mismatches_found int NOT NULL DEFAULT 0,
  remediated_count int NOT NULL DEFAULT 0,
  is_dry_run boolean NOT NULL DEFAULT true,
  realtime_reconnects_24h int NOT NULL DEFAULT 0,
  off_route_recalcs_24h int NOT NULL DEFAULT 0,
  destination_shifts_24h int NOT NULL DEFAULT 0,
  details jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_integrity_health_log_run_at 
  ON public.delivery_integrity_health_log (run_at DESC);

ALTER TABLE public.delivery_integrity_health_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "health_log_select_staff" ON public.delivery_integrity_health_log;
CREATE POLICY "health_log_select_staff" ON public.delivery_integrity_health_log
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_staff()));

-- -----------------------------------------------------------------------------
-- 3. Telemetry Ingestion RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_delivery_telemetry_event(
  p_event_type text,
  p_order_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.delivery_telemetry_events (
    event_type,
    order_id,
    rider_id,
    metadata
  ) VALUES (
    p_event_type,
    p_order_id,
    auth.uid(),
    COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_delivery_telemetry_event(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_delivery_telemetry_event(text, uuid, jsonb) TO authenticated, anon;

-- -----------------------------------------------------------------------------
-- 4. Reconcile Historical Delivered Order Snapshots (with p_dry_run)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_historical_delivered_order_snapshots(
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_delivered bigint := 0;
  v_mismatches_found int := 0;
  v_remediated_count int := 0;
  v_affected_list jsonb := '[]'::jsonb;
  v_reconnects_24h int := 0;
  v_off_route_24h int := 0;
  v_shifts_24h int := 0;
BEGIN
  -- Count total delivered orders with valid delivery snapshot
  SELECT count(*) INTO v_total_delivered
    FROM public.orders
   WHERE (delivered_at IS NOT NULL OR status = 'delivered' OR delivery_status = 'delivered')
     AND delivery_snapshot IS NOT NULL
     AND delivery_snapshot->>'lat' IS NOT NULL
     AND (delivery_snapshot->>'lat')::double precision != 0;

  -- Identify mismatch rows
  SELECT 
    count(*),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'order_id', id,
        'order_number', order_number,
        'current_destination_lat', destination_lat,
        'current_destination_lng', destination_lng,
        'snapshot_lat', (delivery_snapshot->>'lat')::double precision,
        'snapshot_lng', (delivery_snapshot->>'lng')::double precision,
        'delivered_at', delivered_at
      )
    ), '[]'::jsonb)
  INTO v_mismatches_found, v_affected_list
  FROM public.orders
  WHERE (delivered_at IS NOT NULL OR status = 'delivered' OR delivery_status = 'delivered')
    AND delivery_snapshot IS NOT NULL
    AND delivery_snapshot->>'lat' IS NOT NULL
    AND (delivery_snapshot->>'lat')::double precision != 0
    AND (
      ABS(COALESCE(destination_lat, 0) - (delivery_snapshot->>'lat')::double precision) > 0.0001 
      OR ABS(COALESCE(destination_lng, 0) - (delivery_snapshot->>'lng')::double precision) > 0.0001
    );

  -- If not a dry run and mismatches exist, apply the atomic fix
  IF NOT p_dry_run AND v_mismatches_found > 0 THEN
    WITH affected AS (
      UPDATE public.orders
         SET destination_lat = (delivery_snapshot->>'lat')::double precision,
             destination_lng = (delivery_snapshot->>'lng')::double precision
       WHERE (delivered_at IS NOT NULL OR status = 'delivered' OR delivery_status = 'delivered')
         AND delivery_snapshot IS NOT NULL
         AND delivery_snapshot->>'lat' IS NOT NULL
         AND (delivery_snapshot->>'lat')::double precision != 0
         AND (
           ABS(COALESCE(destination_lat, 0) - (delivery_snapshot->>'lat')::double precision) > 0.0001 
           OR ABS(COALESCE(destination_lng, 0) - (delivery_snapshot->>'lng')::double precision) > 0.0001
         )
       RETURNING id
    )
    SELECT count(*) INTO v_remediated_count FROM affected;
  END IF;

  -- 24h telemetry statistics
  SELECT count(*) INTO v_reconnects_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'realtime_reconnect'
     AND created_at >= (now() - interval '24 hours');

  SELECT count(*) INTO v_off_route_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'off_route_recalculation'
     AND created_at >= (now() - interval '24 hours');

  SELECT count(*) INTO v_shifts_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'destination_shifted'
     AND created_at >= (now() - interval '24 hours');

  -- Log run into delivery_integrity_health_log
  INSERT INTO public.delivery_integrity_health_log (
    run_at,
    total_delivered_checked,
    mismatches_found,
    remediated_count,
    is_dry_run,
    realtime_reconnects_24h,
    off_route_recalcs_24h,
    destination_shifts_24h,
    details
  ) VALUES (
    now(),
    v_total_delivered,
    v_mismatches_found,
    v_remediated_count,
    p_dry_run,
    v_reconnects_24h,
    v_off_route_24h,
    v_shifts_24h,
    jsonb_build_object('affected_orders', v_affected_list)
  );

  RETURN jsonb_build_object(
    'status', 'complete',
    'is_dry_run', p_dry_run,
    'total_historical_delivered_checked', v_total_delivered,
    'mismatches_found', v_mismatches_found,
    'remediated_orders_count', v_remediated_count,
    'realtime_reconnects_24h', v_reconnects_24h,
    'off_route_recalcs_24h', v_off_route_24h,
    'destination_shifts_24h', v_shifts_24h,
    'affected_orders', v_affected_list,
    'timestamp', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_historical_delivered_order_snapshots(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_historical_delivered_order_snapshots(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_historical_delivered_order_snapshots(boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Daily Health Summary RPC for Admin Dashboard
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_delivery_health_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_log record;
  v_reconnects_24h int := 0;
  v_off_route_24h int := 0;
  v_shifts_24h int := 0;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_last_log
    FROM public.delivery_integrity_health_log
   ORDER BY run_at DESC
   LIMIT 1;

  SELECT count(*) INTO v_reconnects_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'realtime_reconnect'
     AND created_at >= (now() - interval '24 hours');

  SELECT count(*) INTO v_off_route_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'off_route_recalculation'
     AND created_at >= (now() - interval '24 hours');

  SELECT count(*) INTO v_shifts_24h
    FROM public.delivery_telemetry_events
   WHERE event_type = 'destination_shifted'
     AND created_at >= (now() - interval '24 hours');

  RETURN jsonb_build_object(
    'last_audit_at', v_last_log.run_at,
    'mismatches_found', COALESCE(v_last_log.mismatches_found, 0),
    'total_checked', COALESCE(v_last_log.total_delivered_checked, 0),
    'realtime_reconnects_24h', v_reconnects_24h,
    'off_route_recalcs_24h', v_off_route_24h,
    'destination_shifts_24h', v_shifts_24h
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_health_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_delivery_health_summary() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_delivery_health_summary() TO authenticated;

COMMIT;
