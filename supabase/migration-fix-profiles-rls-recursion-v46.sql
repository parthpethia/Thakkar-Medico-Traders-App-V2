-- =============================================================================
-- Thakkar Medico — V46: profiles RLS recursion fix
--
-- Redefines profiles_select and profiles_update policies to use non-recursive
-- security definer functions public.current_user_is_staff() and
-- public.current_user_is_admin().
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR public.current_user_is_staff()
  );

DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR public.current_user_is_admin()
  )
  WITH CHECK (
    id = auth.uid()
    OR public.current_user_is_admin()
  );

COMMIT;
