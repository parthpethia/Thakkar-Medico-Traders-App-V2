-- ============================================================================
-- Migration v33: cart_items table privileges + RLS (fixes 42501 permission denied)
-- ============================================================================
-- Run in Supabase SQL Editor if cart fetch fails with permission denied for table cart_items.
-- Idempotent — safe to re-run.
-- ============================================================================

GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cart_items TO authenticated;

ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_auth_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_auth_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_auth_user_id() TO authenticated;

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
  USING (user_id = (SELECT public.current_auth_user_id()));

CREATE POLICY "cart_items_insert" ON public.cart_items
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.current_auth_user_id()));

CREATE POLICY "cart_items_update" ON public.cart_items
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.current_auth_user_id()))
  WITH CHECK (user_id = (SELECT public.current_auth_user_id()));

CREATE POLICY "cart_items_delete" ON public.cart_items
  FOR DELETE TO authenticated
  USING (user_id = (SELECT public.current_auth_user_id()));
