-- =============================================================================
-- Thakkar Medico — V87: Admin delivery assign & reassign (delivery_status fix)
-- Fixes: orders_delivery_status_check violation on reassignment ('assigned' invalid)
-- Run in Supabase SQL Editor after v86
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.assign_order_to_delivery(
  p_order_id uuid,
  p_delivery_profile_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_mode text;
  v_driver_role text;
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status, fulfillment_mode
    INTO v_status, v_mode
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF COALESCE(v_mode, 'delivery') NOT IN ('delivery', 'doorstep') THEN
    RAISE EXCEPTION 'not_delivery_order';
  END IF;

  SELECT role INTO v_driver_role
    FROM public.profiles
   WHERE id = p_delivery_profile_id;

  IF v_driver_role IS NULL OR v_driver_role NOT IN ('delivery', 'driver') THEN
    RAISE EXCEPTION 'invalid_delivery_profile';
  END IF;

  -- First-time assignment (move into assigned workflow)
  IF v_status IN ('pending', 'approved', 'packed') THEN
    UPDATE public.orders
       SET status_before_assignment = v_status,
           assigned_to = p_delivery_profile_id,
           assigned_at = now(),
           assigned_by = auth.uid(),
           status = 'assigned',
           delivery_status = CASE
             WHEN delivery_status IS NULL
               OR delivery_status NOT IN (
                 'pending', 'dispatched', 'in_transit', 'arriving_soon',
                 'signal_lost', 'delivered', 'failed'
               )
             THEN 'pending'
             ELSE delivery_status
           END
     WHERE id = p_order_id;
    RETURN;
  END IF;

  -- Reassignment: swap rider only — preserve order + delivery_status (CHECK-safe)
  IF v_status IN ('assigned', 'accepted', 'picked_up', 'dispatched', 'in_transit', 'out_for_delivery') THEN
    UPDATE public.orders
       SET assigned_to = p_delivery_profile_id,
           assigned_at = now(),
           assigned_by = auth.uid()
     WHERE id = p_order_id;

    UPDATE public.delivery_tracking
       SET rider_id = p_delivery_profile_id,
           updated_at = now()
     WHERE order_id = p_order_id;

    RETURN;
  END IF;

  RAISE EXCEPTION 'invalid_status_for_assign'
    USING HINT = format(
      'Cannot assign/reassign rider when order status is %s',
      v_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_order_to_delivery(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_order_to_delivery(uuid, uuid) TO authenticated;

-- Sanitize any legacy invalid delivery_status values (e.g. 'assigned')
UPDATE public.orders
   SET delivery_status = 'pending'
 WHERE delivery_status IS NOT NULL
   AND delivery_status NOT IN (
     'pending', 'dispatched', 'in_transit', 'arriving_soon',
     'signal_lost', 'delivered', 'failed'
   );

COMMIT;
