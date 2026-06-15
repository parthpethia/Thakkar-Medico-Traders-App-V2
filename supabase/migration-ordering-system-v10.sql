-- ============================================================================
-- Migration v10: Supabase Security Advisor fixes
-- ============================================================================
-- 1) Function search_path mutable — pin search_path on flagged functions
-- 2) GraphQL public exposure — revoke SELECT from anon on public tables/views
--    (App uses authenticated JWT + RLS; phone login uses get_email_by_phone RPC only)
-- Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on functions (by name; handles overloads if present)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS regproc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'set_credit_limit',
        'set_user_credit_limit',
        'set_updated_at',
        'get_product_by_sku'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.regproc);
  END LOOP;
END $$;

-- Ensure barcode lookup function is pinned (recreate if v8 omitted search_path)
CREATE OR REPLACE FUNCTION public.get_product_by_sku(p_sku text)
RETURNS SETOF public.products
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.products
  WHERE barcode_sku = p_sku
    AND is_active = true;
$$;

REVOKE ALL ON FUNCTION public.get_product_by_sku(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_by_sku(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hide public schema objects from anon GraphQL / PostgREST discovery
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm') -- table, view, matview
      AND c.relname NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon', r.name);
  END LOOP;
END $$;

-- New tables created later: do not grant SELECT to anon by default
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM PUBLIC;
