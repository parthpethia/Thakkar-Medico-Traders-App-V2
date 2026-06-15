-- ============================================================================
-- Migration v15: Remaining RLS performance advisor (products, profiles, …)
-- ============================================================================
-- • Drop stray/duplicate policies (especially products)
-- • One permissive policy per role + action where possible
-- • Use public.current_* helpers (from v13) instead of auth.uid() in policies
-- Run after v14. Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_user_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND p.role IN ('admin', 'delivery')
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_is_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_staff() TO authenticated;

-- ---------------------------------------------------------------------------
-- Utility: drop all policies on a public table
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._drop_all_policies(p_table text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, p_table);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
SELECT public._drop_all_policies('profiles');

CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select public.current_auth_user_id())
    OR (select public.current_user_is_staff())
  );

CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = (select public.current_auth_user_id()));

CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    id = (select public.current_auth_user_id())
    OR (select public.current_user_is_admin())
  )
  WITH CHECK (
    id = (select public.current_auth_user_id())
    OR (select public.current_user_is_admin())
  );

-- ---------------------------------------------------------------------------
-- products (clear duplicate dashboard policies)
-- ---------------------------------------------------------------------------
SELECT public._drop_all_policies('products');

CREATE POLICY "products_select" ON public.products
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "products_insert_admin" ON public.products
  FOR INSERT TO authenticated
  WITH CHECK ((select public.current_user_is_admin()));

CREATE POLICY "products_update_admin" ON public.products
  FOR UPDATE TO authenticated
  USING ((select public.current_user_is_admin()))
  WITH CHECK ((select public.current_user_is_admin()));

CREATE POLICY "products_delete_admin" ON public.products
  FOR DELETE TO authenticated
  USING ((select public.current_user_is_admin()));

-- ---------------------------------------------------------------------------
-- credit_adjustments
-- ---------------------------------------------------------------------------
SELECT public._drop_all_policies('credit_adjustments');

CREATE POLICY "credit_adjustments_select" ON public.credit_adjustments
  FOR SELECT TO authenticated
  USING (
    retailer_id = (select public.current_auth_user_id())
    OR (select public.current_user_is_admin())
  );

CREATE POLICY "credit_adjustments_insert_admin" ON public.credit_adjustments
  FOR INSERT TO authenticated
  WITH CHECK ((select public.current_user_is_admin()));

-- ---------------------------------------------------------------------------
-- login_audit
-- ---------------------------------------------------------------------------
SELECT public._drop_all_policies('login_audit');

CREATE POLICY "login_audit_select" ON public.login_audit
  FOR SELECT TO authenticated
  USING (
    user_id = (select public.current_auth_user_id())
    OR (select public.current_user_is_admin())
  );

-- ---------------------------------------------------------------------------
-- Tables with no direct authenticated table access (v14) — remove stale policies
-- ---------------------------------------------------------------------------
SELECT public._drop_all_policies('order_items');
SELECT public._drop_all_policies('order_status_events');
SELECT public._drop_all_policies('password_reset_events');
SELECT public._drop_all_policies('notifications_log');

-- RLS enabled + no permissive policies => deny direct client access (Edge/RPC use service role)
