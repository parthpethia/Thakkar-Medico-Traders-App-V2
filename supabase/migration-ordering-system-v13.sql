-- ============================================================================
-- Migration v13: cart_items + settings RLS cleanup (Performance Advisor)
-- ============================================================================
-- cart_items: remove duplicate/stray policies; one permissive policy per action.
-- settings: admin checks via stable helper (avoids auth initplan in policies).
-- Run after v12. Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helpers for RLS (auth evaluated once inside function body)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.current_auth_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_user_is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_auth_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_auth_user_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- cart_items: drop every policy, then exactly one per command
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'cart_items'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.cart_items', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "cart_items_select" ON public.cart_items
  FOR SELECT TO authenticated
  USING (user_id = (select public.current_auth_user_id()));

CREATE POLICY "cart_items_insert" ON public.cart_items
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select public.current_auth_user_id()));

CREATE POLICY "cart_items_update" ON public.cart_items
  FOR UPDATE TO authenticated
  USING (user_id = (select public.current_auth_user_id()))
  WITH CHECK (user_id = (select public.current_auth_user_id()));

CREATE POLICY "cart_items_delete" ON public.cart_items
  FOR DELETE TO authenticated
  USING (user_id = (select public.current_auth_user_id()));

-- ---------------------------------------------------------------------------
-- settings: drop every policy, recreate minimal set
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settings'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.settings', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "settings_select" ON public.settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "settings_insert_admin" ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK ((select public.current_user_is_admin()));

CREATE POLICY "settings_update_admin" ON public.settings
  FOR UPDATE TO authenticated
  USING ((select public.current_user_is_admin()))
  WITH CHECK ((select public.current_user_is_admin()));

CREATE POLICY "settings_delete_admin" ON public.settings
  FOR DELETE TO authenticated
  USING ((select public.current_user_is_admin()));
