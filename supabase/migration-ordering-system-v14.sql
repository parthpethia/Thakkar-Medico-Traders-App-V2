-- ============================================================================
-- Migration v14: GraphQL schema visibility (Security Advisor)
-- ============================================================================
-- The Expo app uses PostgREST (supabase-js) with RLS — not GraphQL.
-- Advisor flags any table with GRANT SELECT TO authenticated as "visible"
-- in the GraphQL schema even when RLS restricts rows.
--
-- This migration:
--   1) Marks public tables @graphql ignore (hidden from GraphQL introspection)
--   2) Revokes SELECT from authenticated on tables only edge/RPC use (never .from())
--
-- If warnings remain: Dashboard → Project Settings → API → disable GraphQL.
-- Do NOT revoke SELECT on tables the app queries (products, orders, profiles, …).
-- Run after v13. Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Hide public tables from Supabase GraphQL (keep PostgREST grants)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  kind text;
BEGIN
  FOR r IN
    SELECT c.relname AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm')
      AND c.relname NOT LIKE 'pg_%'
  LOOP
    kind := CASE r.relkind
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'COMMENT ON %s public.%I IS %L',
      kind,
      r.name,
      '@graphql({"ignore": true})'
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Tables not read by the mobile app (service role / SECURITY DEFINER only)
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.notifications_log FROM authenticated;
REVOKE SELECT ON public.password_reset_events FROM authenticated;
REVOKE SELECT ON public.order_items FROM authenticated;
REVOKE SELECT ON public.order_status_events FROM authenticated;

-- Inserts to notifications_log should go through Edge Functions (service role)
REVOKE INSERT, UPDATE, DELETE ON public.notifications_log FROM authenticated;

-- Password reset audit: app uses log_password_reset_event() RPC (SECURITY DEFINER)
REVOKE INSERT, UPDATE, DELETE ON public.password_reset_events FROM authenticated;

-- Line items / status events: app uses get_order_timeline() and order payloads via RPC
REVOKE INSERT, UPDATE, DELETE ON public.order_items FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.order_status_events FROM authenticated;
