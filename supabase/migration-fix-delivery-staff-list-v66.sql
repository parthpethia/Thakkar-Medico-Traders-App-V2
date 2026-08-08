-- =============================================================================
-- Migration V66: Fix list_delivery_staff RPC to include all delivery drivers
-- and default p_on_duty_only to false so off-duty drivers are also visible
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.list_delivery_staff(
  p_on_duty_only boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  name text,
  phone text,
  is_on_duty boolean,
  current_order_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
    SELECT
      p.id,
      COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(p.business_name), ''), 'Delivery Driver') AS name,
      p.phone,
      COALESCE(p.is_on_duty, false) AS is_on_duty,
      COALESCE(p.current_order_count, 0) AS current_order_count
    FROM public.profiles p
    WHERE (p.role = 'delivery' OR p.role = 'driver')
      AND (NOT p_on_duty_only OR p.is_on_duty = true)
    ORDER BY p.is_on_duty DESC, p.current_order_count ASC, name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_delivery_staff(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_delivery_staff(boolean) TO authenticated;

COMMIT;
