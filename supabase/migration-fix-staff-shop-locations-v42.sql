-- ============================================================================
-- Migration v42: Allow staff (admin and delivery) to manage retailer shop locations
-- ============================================================================

DROP POLICY IF EXISTS "shop_locations_insert" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_insert" ON public.retailer_shop_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      retailer_account_id = (SELECT auth.uid())
      AND added_by = 'retailer'
    )
    OR (SELECT public.current_user_is_staff())
  );

DROP POLICY IF EXISTS "shop_locations_update" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_update" ON public.retailer_shop_locations
  FOR UPDATE TO authenticated
  USING (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_staff())
  )
  WITH CHECK (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_staff())
  );

DROP POLICY IF EXISTS "shop_locations_delete" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_delete" ON public.retailer_shop_locations
  FOR DELETE TO authenticated
  USING (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_staff())
  );

-- Grant SELECT on settings table to authenticated and anon roles to fix permission denied (42501)
GRANT SELECT ON public.settings TO authenticated, anon;
