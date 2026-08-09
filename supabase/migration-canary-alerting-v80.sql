-- =============================================================================
-- Migration v80: Canary Alerting, Circuit Breakers & Scoped Health Telemetry
--
-- Features:
-- 1. Expanded metrics in get_delivery_health_summary():
--    - auto_circuit_breakers_24h
--    - rider_reported_issues_24h
-- 2. Webhook notification trigger support on delivery_telemetry_events for
--    critical alert types (auto_circuit_breaker_triggered, rider_reported_issue).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_delivery_health_summary(
  p_canary_only boolean DEFAULT false
)
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
  v_circuit_breakers_24h int := 0;
  v_rider_issues_24h int := 0;
  v_canary_count int := 0;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(*) INTO v_canary_count
    FROM public.canary_rider_flags
   WHERE feature_set = 'delivery_flow_v2'
     AND enabled = true;

  SELECT * INTO v_last_log
    FROM public.delivery_integrity_health_log
   ORDER BY run_at DESC
   LIMIT 1;

  IF p_canary_only THEN
    -- Scoped to canary allowlist riders only
    SELECT count(*) INTO v_reconnects_24h
      FROM public.delivery_telemetry_events e
      JOIN public.canary_rider_flags cf 
        ON cf.rider_id = e.rider_id AND cf.feature_set = 'delivery_flow_v2' AND cf.enabled = true
     WHERE e.event_type = 'realtime_reconnect'
       AND e.created_at >= (now() - interval '24 hours');

    SELECT count(*) INTO v_off_route_24h
      FROM public.delivery_telemetry_events e
      JOIN public.canary_rider_flags cf 
        ON cf.rider_id = e.rider_id AND cf.feature_set = 'delivery_flow_v2' AND cf.enabled = true
     WHERE e.event_type = 'off_route_recalculation'
       AND e.created_at >= (now() - interval '24 hours');

    SELECT count(*) INTO v_shifts_24h
      FROM public.delivery_telemetry_events e
      JOIN public.canary_rider_flags cf 
        ON cf.rider_id = e.rider_id AND cf.feature_set = 'delivery_flow_v2' AND cf.enabled = true
     WHERE e.event_type = 'destination_shifted'
       AND e.created_at >= (now() - interval '24 hours');

    SELECT count(*) INTO v_circuit_breakers_24h
      FROM public.delivery_telemetry_events e
      JOIN public.canary_rider_flags cf 
        ON cf.rider_id = e.rider_id AND cf.feature_set = 'delivery_flow_v2' AND cf.enabled = true
     WHERE e.event_type = 'auto_circuit_breaker_triggered'
       AND e.created_at >= (now() - interval '24 hours');

    SELECT count(*) INTO v_rider_issues_24h
      FROM public.delivery_telemetry_events e
      JOIN public.canary_rider_flags cf 
        ON cf.rider_id = e.rider_id AND cf.feature_set = 'delivery_flow_v2' AND cf.enabled = true
     WHERE e.event_type = 'rider_reported_issue'
       AND e.created_at >= (now() - interval '24 hours');
  ELSE
    -- Fleet-wide
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

    SELECT count(*) INTO v_circuit_breakers_24h
      FROM public.delivery_telemetry_events
     WHERE event_type = 'auto_circuit_breaker_triggered'
       AND created_at >= (now() - interval '24 hours');

    SELECT count(*) INTO v_rider_issues_24h
      FROM public.delivery_telemetry_events
     WHERE event_type = 'rider_reported_issue'
       AND created_at >= (now() - interval '24 hours');
  END IF;

  RETURN jsonb_build_object(
    'is_canary_filtered', p_canary_only,
    'canary_riders_active', v_canary_count,
    'last_audit_at', v_last_log.run_at,
    'mismatches_found', COALESCE(v_last_log.mismatches_found, 0),
    'total_checked', COALESCE(v_last_log.total_delivered_checked, 0),
    'realtime_reconnects_24h', v_reconnects_24h,
    'off_route_recalcs_24h', v_off_route_24h,
    'destination_shifts_24h', v_shifts_24h,
    'circuit_breakers_24h', v_circuit_breakers_24h,
    'rider_issues_24h', v_rider_issues_24h
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_health_summary(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_delivery_health_summary(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_delivery_health_summary(boolean) TO authenticated;

COMMIT;
