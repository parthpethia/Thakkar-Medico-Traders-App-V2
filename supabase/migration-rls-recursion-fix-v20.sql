-- =============================================================================
-- Thakkar Medico Traders — Fix RLS Recursion (v20)
-- Redefine role check functions as SECURITY DEFINER to bypass RLS recursion.
-- =============================================================================

-- 1. Redefine current_user_is_staff()
CREATE OR REPLACE FUNCTION public.current_user_is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'delivery')
  );
$$;

-- 2. Redefine current_user_is_admin()
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$;

-- 3. Revoke/Grant permissions to ensure secure access
REVOKE ALL ON FUNCTION public.current_user_is_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_user_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO authenticated;

-- 4. orders policies — avoid inline profiles subqueries (RLS recursion)
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.current_user_is_staff())
  );

DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_staff())
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
  );
