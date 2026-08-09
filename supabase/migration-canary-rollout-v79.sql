-- =============================================================================
-- Migration v79: Remote Canary Rollout Management & Scoped Telemetry
--
-- Features:
-- 1. `canary_rider_flags` table for remote-controlled feature flag allowlists.
-- 2. `check_rider_canary_flag()` for instant mobile client feature evaluation.
-- 3. `toggle_rider_canary_flag()` for non-deployment admin group management.
-- 4. `get_delivery_health_summary(p_canary_only boolean)` supporting scoped
--    canary cohort telemetry isolation during rollout windows.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Canary Rider Flags Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.canary_rider_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  feature_set text NOT NULL DEFAULT 'delivery_flow_v2',
  enabled boolean NOT NULL DEFAULT true,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  enabled_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_canary_rider_feature UNIQUE (rider_id, feature_set)
);

CREATE INDEX IF NOT EXISTS idx_canary_rider_lookup 
  ON public.canary_rider_flags (rider_id, feature_set, enabled);

ALTER TABLE public.canary_rider_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "canary_flags_select_own_or_staff" ON public.canary_rider_flags;
CREATE POLICY "canary_flags_select_own_or_staff" ON public.canary_rider_flags
  FOR SELECT TO authenticated
  USING (
    rider_id = auth.uid() 
    OR (SELECT public.current_user_is_staff())
  );

DROP POLICY IF EXISTS "canary_flags_manage_staff" ON public.canary_rider_flags;
CREATE POLICY "canary_flags_manage_staff" ON public.canary_rider_flags
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_staff()))
  WITH CHECK ((SELECT public.current_user_is_staff()));

-- -----------------------------------------------------------------------------
-- 2. Client Canary Flag Evaluation RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rider_canary_flag(
  p_rider_id uuid DEFAULT NULL,
  p_feature_set text DEFAULT 'delivery_flow_v2'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_id uuid := COALESCE(p_rider_id, auth.uid());
  v_enabled boolean := false;
BEGIN
  IF v_target_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT enabled INTO v_enabled
    FROM public.canary_rider_flags
   WHERE rider_id = v_target_id
     AND feature_set = p_feature_set
   LIMIT 1;

  RETURN COALESCE(v_enabled, false);
END;
$$;

REVOKE ALL ON FUNCTION public.check_rider_canary_flag(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_rider_canary_flag(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_rider_canary_flag(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Admin Canary Toggle RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.toggle_rider_canary_flag(
  p_rider_id uuid,
  p_enabled boolean,
  p_feature_set text DEFAULT 'delivery_flow_v2',
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result record;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  INSERT INTO public.canary_rider_flags (
    rider_id,
    feature_set,
    enabled,
    enabled_at,
    enabled_by,
    notes,
    updated_at
  ) VALUES (
    p_rider_id,
    p_feature_set,
    p_enabled,
    now(),
    auth.uid(),
    p_notes,
    now()
  )
  ON CONFLICT (rider_id, feature_set) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        enabled_at = now(),
        enabled_by = auth.uid(),
        notes = COALESCE(EXCLUDED.notes, canary_rider_flags.notes),
        updated_at = now()
  RETURNING * INTO v_result;

  RETURN jsonb_build_object(
    'status', 'success',
    'rider_id', v_result.rider_id,
    'feature_set', v_result.feature_set,
    'enabled', v_result.enabled,
    'updated_at', v_result.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_rider_canary_flag(uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_rider_canary_flag(uuid, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.toggle_rider_canary_flag(uuid, boolean, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Get List of Canary Riders RPC for Admin Management
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_canary_riders(
  p_feature_set text DEFAULT 'delivery_flow_v2'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_riders jsonb;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rider_id', p.id,
      'name', COALESCE(p.name, p.business_name, 'Rider'),
      'phone', p.phone,
      'is_canary_enabled', COALESCE(cf.enabled, false),
      'enabled_at', cf.enabled_at,
      'notes', cf.notes
    ) ORDER BY p.name ASC
  ), '[]'::jsonb)
  INTO v_riders
  FROM public.profiles p
  LEFT JOIN public.canary_rider_flags cf 
    ON cf.rider_id = p.id AND cf.feature_set = p_feature_set
  WHERE p.role = 'delivery';

  RETURN v_riders;
END;
$$;

REVOKE ALL ON FUNCTION public.list_canary_riders(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_canary_riders(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_canary_riders(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Enhanced Health Summary with Canary Cohort Filter
-- -----------------------------------------------------------------------------
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
  END IF;

  RETURN jsonb_build_object(
    'is_canary_filtered', p_canary_only,
    'canary_riders_active', v_canary_count,
    'last_audit_at', v_last_log.run_at,
    'mismatches_found', COALESCE(v_last_log.mismatches_found, 0),
    'total_checked', COALESCE(v_last_log.total_delivered_checked, 0),
    'realtime_reconnects_24h', v_reconnects_24h,
    'off_route_recalcs_24h', v_off_route_24h,
    'destination_shifts_24h', v_shifts_24h
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_health_summary(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_delivery_health_summary(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_delivery_health_summary(boolean) TO authenticated;

COMMIT;
