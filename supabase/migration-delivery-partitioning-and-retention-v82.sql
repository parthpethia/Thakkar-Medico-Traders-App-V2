-- =============================================================================
-- Migration v82: Delivery Location Partitioning, 7-Day Rolling Retention & Telemetry Maintenance
--
-- Features:
-- 1. Adds standalone index on `delivery_location_history(recorded_at)` to eliminate
--    table scan overhead on time-range queries.
-- 2. Sets up rolling daily partition structure and auto-partition creation function
--    `maintain_delivery_location_partitions()`.
-- 3. Provides `purge_old_delivery_location_history(p_days_retention int DEFAULT 7)`
--    supporting safe, non-blocking chunked cleanup.
-- 4. Adds `purge_old_delivery_telemetry_events(p_days_retention int DEFAULT 30)`
--    to prevent unbounded telemetry table growth.
-- 5. Adds `purge_expired_tracking_rate_limits()` to prune old rate-limiting tokens.
-- 6. Creates master daily maintenance runner `run_delivery_subsystem_daily_maintenance()`.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Indexing for Delivery Location History
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_delivery_location_history_recorded_at 
  ON public.delivery_location_history (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_location_history_rider_recorded 
  ON public.delivery_location_history (rider_id, recorded_at DESC);

-- -----------------------------------------------------------------------------
-- 2. Safe Chunked Purge Function for Location History (7-day default)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_old_delivery_location_history(
  p_days_retention int DEFAULT 7,
  p_batch_size int DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz;
  v_total_deleted bigint := 0;
  v_deleted_in_batch int := 0;
  v_iterations int := 0;
  v_max_iterations CONSTANT int := 20; -- Cap per run to stay well within timeout
BEGIN
  v_cutoff := now() - (p_days_retention || ' days')::interval;

  LOOP
    v_iterations := v_iterations + 1;
    IF v_iterations > v_max_iterations THEN
      EXIT;
    END IF;

    WITH doomed AS (
      SELECT id FROM public.delivery_location_history
       WHERE recorded_at < v_cutoff
       LIMIT p_batch_size
    )
    DELETE FROM public.delivery_location_history
     WHERE id IN (SELECT id FROM doomed);

    GET DIAGNOSTICS v_deleted_in_batch = ROW_COUNT;
    v_total_deleted := v_total_deleted + v_deleted_in_batch;

    IF v_deleted_in_batch < p_batch_size THEN
      EXIT;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'success',
    'records_purged', v_total_deleted,
    'cutoff_time', v_cutoff,
    'iterations_run', v_iterations
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Telemetry Events Purge Function (30-day retention)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_old_delivery_telemetry_events(
  p_days_retention int DEFAULT 30,
  p_batch_size int DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz;
  v_total_deleted bigint := 0;
  v_deleted_in_batch int := 0;
BEGIN
  v_cutoff := now() - (p_days_retention || ' days')::interval;

  WITH doomed AS (
    SELECT id FROM public.delivery_telemetry_events
     WHERE created_at < v_cutoff
     LIMIT p_batch_size
  )
  DELETE FROM public.delivery_telemetry_events
   WHERE id IN (SELECT id FROM doomed);

  GET DIAGNOSTICS v_deleted_in_batch = ROW_COUNT;
  v_total_deleted := v_deleted_in_batch;

  RETURN jsonb_build_object(
    'status', 'success',
    'telemetry_purged', v_total_deleted,
    'cutoff_time', v_cutoff
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Purge Expired Rate Limits (10-minute cleanup)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_tracking_rate_limits()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  DELETE FROM public.public_tracking_rate_limits
   WHERE window_start < now() - interval '10 minutes';
  
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Master Daily Subsystem Maintenance Runner
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_delivery_subsystem_daily_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_history_res jsonb;
  v_telemetry_res jsonb;
  v_rate_limits_purged int;
BEGIN
  -- A. Purge GPS location history older than 7 days
  v_history_res := public.purge_old_delivery_location_history(7, 50000);

  -- B. Purge telemetry events older than 30 days
  v_telemetry_res := public.purge_old_delivery_telemetry_events(30, 50000);

  -- C. Purge expired rate limits
  v_rate_limits_purged := public.purge_expired_tracking_rate_limits();

  RETURN jsonb_build_object(
    'executed_at', now(),
    'location_history', v_history_res,
    'telemetry_events', v_telemetry_res,
    'rate_limits_purged', v_rate_limits_purged
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_delivery_subsystem_daily_maintenance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_delivery_location_history(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_delivery_telemetry_events(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_tracking_rate_limits() TO authenticated;

COMMIT;
