-- ============================================================================
-- Migration v9: Fix slow_rpc_candidates security (Supabase linter)
-- ============================================================================
-- View must use security_invoker so callers use their own privileges.
-- pg_stat_statements is not exposed to app users — service_role / SQL editor only.
-- Idempotent — safe to re-run.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
  ) THEN
    EXECUTE '
      CREATE OR REPLACE VIEW public.slow_rpc_candidates
      WITH (security_invoker = true)
      AS
      SELECT query, calls, mean_exec_time, total_exec_time
      FROM pg_stat_statements
      WHERE query ILIKE ''%place_order%''
         OR query ILIKE ''%get_orders_page%''
         OR query ILIKE ''%search_products%''
         OR query ILIKE ''%get_sales_summary%''
         OR query ILIKE ''%get_top_products%''
      ORDER BY mean_exec_time DESC
      LIMIT 20;
    ';
  END IF;
END $$;

REVOKE ALL ON public.slow_rpc_candidates FROM PUBLIC;
REVOKE ALL ON public.slow_rpc_candidates FROM authenticated;
REVOKE ALL ON public.slow_rpc_candidates FROM anon;

GRANT SELECT ON public.slow_rpc_candidates TO service_role;
