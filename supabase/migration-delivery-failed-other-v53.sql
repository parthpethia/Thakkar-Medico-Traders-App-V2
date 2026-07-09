-- =============================================================================
-- Thakkar Medico — V53: Allow custom 'other' reasons in delivery_report_failed
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.delivery_report_failed(
  p_order_id uuid,
  p_reason   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_assigned_to uuid;
BEGIN
  -- Only delivery drivers can call this
  IF NOT (SELECT public.current_user_is_delivery()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status, assigned_to
    INTO v_status, v_assigned_to
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  -- Must be assigned to this driver
  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Must be in dispatched status
  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Order must be dispatched to report failure, currently %s', v_status);
  END IF;

  -- Validate reason (allow 'other' or 'other: <detail>')
  IF p_reason IS NULL OR (
    p_reason NOT IN ('shop_closed', 'retailer_unreachable', 'wrong_address', 'other')
    AND NOT (p_reason LIKE 'other:%')
  ) THEN
    RAISE EXCEPTION 'invalid_reason'
      USING HINT = 'Reason must be shop_closed, retailer_unreachable, wrong_address, or start with other:';
  END IF;

  -- Transition to delivery_failed
  UPDATE public.orders
     SET status = 'delivery_failed',
          delivery_failure_reason = p_reason
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delivery_report_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_report_failed(uuid, text) TO authenticated;

COMMIT;
