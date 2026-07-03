-- =============================================================================
-- Thakkar Medico — V44: Retry UPI Payment and Change Payment Mode Options
--
-- Adds:
--   1. Update enforce_order_status_transition trigger function to allow payment_failed -> pending.
--   2. Update orders_update and orders_update_own_cancel RLS policies to allow updating
--      orders in 'pending_payment' or 'payment_failed' status (enabling cancellation requests).
--   3. Create change_order_payment_mode RPC to switch payment modes securely.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Update enforce_order_status_transition
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid       boolean := false;
  v_points      int;
  v_item        RECORD;
  v_alloc       jsonb;
  v_batch_id    uuid;
  v_alloc_qty   integer;
BEGIN
  -- Skip if status hasn't changed
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Valid transitions
  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled', 'assigned', 'payment_failed') THEN true
    WHEN OLD.status = 'payment_failed'  AND NEW.status IN ('pending_payment', 'cancelled', 'pending')                  THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned', 'rejected')  THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled', 'assigned')                THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled', 'assigned')            THEN true
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('accepted', 'cancelled', 'rejected', 'packed', 'pending', 'approved') THEN true
    WHEN OLD.status = 'accepted'        AND NEW.status IN ('picked_up', 'cancelled')                         THEN true
    WHEN OLD.status = 'picked_up'       AND NEW.status IN ('dispatched', 'cancelled')                        THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')                         THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  -- Log the transition
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  -- -----------------------------------------------------------------------
  -- Cancellation: restore credit + restore stock to BATCHES
  -- -----------------------------------------------------------------------
  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty, batch_allocations
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
        -- Restore stock to the specific batches that were allocated
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
        LOOP
          v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
          v_alloc_qty := (v_alloc ->> 'qty')::integer;

          UPDATE product_batches
             SET quantity = quantity + v_alloc_qty
           WHERE id = v_batch_id;
        END LOOP;
      ELSE
        -- Pre-v43 orders fallback
        UPDATE product_batches
           SET quantity = quantity + v_item.qty
         WHERE id = (
           SELECT id FROM product_batches
            WHERE product_id = v_item.product_id
              AND is_active = true
            ORDER BY
              CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
              created_at ASC
            LIMIT 1
         );

        IF NOT FOUND THEN
          INSERT INTO product_batches (product_id, batch_number, quantity)
          VALUES (v_item.product_id, 'LEGACY', v_item.qty);
        END IF;
      END IF;

      -- Audit trail for the stock restore
      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Cancelled order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  -- -----------------------------------------------------------------------
  -- Rejection: same batch-aware restore logic
  -- -----------------------------------------------------------------------
  IF NEW.status = 'rejected' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty, batch_allocations
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
        LOOP
          v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
          v_alloc_qty := (v_alloc ->> 'qty')::integer;

          UPDATE product_batches
             SET quantity = quantity + v_alloc_qty
           WHERE id = v_batch_id;
        END LOOP;
      ELSE
        UPDATE product_batches
           SET quantity = quantity + v_item.qty
         WHERE id = (
           SELECT id FROM product_batches
            WHERE product_id = v_item.product_id
              AND is_active = true
            ORDER BY
              CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
              created_at ASC
            LIMIT 1
         );

        IF NOT FOUND THEN
          INSERT INTO product_batches (product_id, batch_number, quantity)
          VALUES (v_item.product_id, 'LEGACY', v_item.qty);
        END IF;
      END IF;

      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Rejected order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  -- -----------------------------------------------------------------------
  -- Delivered: accrue loyalty points
  -- -----------------------------------------------------------------------
  IF NEW.status = 'delivered' THEN
    v_points := FLOOR(NEW.grand_total / 100);
    IF v_points > 0 THEN
      INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
      VALUES (NEW.user_id, NEW.id, v_points, 'order_delivered', 'earned');

      UPDATE profiles
         SET loyalty_points = loyalty_points + v_points
       WHERE id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 2. Update orders_update and orders_update_own_cancel RLS Policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND assigned_to = (SELECT auth.uid())
    )
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text, 'pending_payment'::text, 'payment_failed'::text])
    )
  )
  WITH CHECK (
    (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND assigned_to = (SELECT auth.uid())
    )
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text, 'pending_payment'::text, 'payment_failed'::text])
    )
  );

DROP POLICY IF EXISTS "orders_update_own_cancel" ON public.orders;
CREATE POLICY "orders_update_own_cancel" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (select auth.uid()) = user_id
    AND status IN ('pending', 'approved', 'pending_payment', 'payment_failed')
  )
  WITH CHECK (
    (select auth.uid()) = user_id
    AND status IN ('pending', 'approved', 'pending_payment', 'payment_failed')
  );


-- ---------------------------------------------------------------------------
-- 3. Create change_order_payment_mode function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_order_payment_mode(
  p_order_id     uuid,
  p_payment_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id        uuid := auth.uid();
  v_caller_role      text;
  v_retailer_id      uuid;
  v_status           text;
  v_grand_total      numeric;
  v_old_mode         text;
  v_enabled_modes    jsonb;
  v_credit_limit     numeric;
  v_credit_used      numeric;
  v_retailer_name    text;
BEGIN
  -- Fetch caller role
  SELECT role INTO v_caller_role FROM profiles WHERE id = v_caller_id;

  -- Fetch order details
  SELECT user_id, status, grand_total, payment_mode
    INTO v_retailer_id, v_status, v_grand_total, v_old_mode
    FROM orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING HINT = 'Order does not exist';
  END IF;

  -- Verify authorization (owner or admin)
  IF v_caller_id <> v_retailer_id AND v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only the order owner or admin can change the payment mode';
  END IF;

  -- Check current order state
  IF v_status NOT IN ('pending_payment', 'payment_failed') THEN
    RAISE EXCEPTION 'invalid_order_status' USING HINT = 'Payment mode can only be changed for pending or failed payments';
  END IF;

  IF v_old_mode <> 'upi' THEN
    RAISE EXCEPTION 'not_upi_order' USING HINT = 'Only UPI orders can be switched to another payment method';
  END IF;

  -- Validate new payment mode is enabled in settings
  SELECT COALESCE(payment_modes_enabled, '["cod"]'::jsonb) INTO v_enabled_modes FROM settings LIMIT 1;
  
  IF NOT (p_payment_mode = ANY(ARRAY(SELECT jsonb_array_elements_text(v_enabled_modes)))) THEN
    RAISE EXCEPTION 'payment_mode_not_enabled' USING HINT = 'This payment mode is not enabled in settings';
  END IF;

  IF p_payment_mode NOT IN ('cod', 'credit') THEN
    RAISE EXCEPTION 'invalid_payment_mode' USING HINT = 'New payment mode must be cod or credit';
  END IF;

  -- If credit, check limit and update used credit
  IF p_payment_mode = 'credit' THEN
    SELECT credit_limit, credit_used, name INTO v_credit_limit, v_credit_used, v_retailer_name
      FROM profiles
     WHERE id = v_retailer_id
       FOR UPDATE;

    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s', v_credit_used, v_grand_total, v_credit_limit);
    END IF;

    -- Debit credit
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = v_retailer_id;
  END IF;

  -- Update order payment mode and transition status to pending
  UPDATE orders
     SET payment_mode = p_payment_mode,
         status = 'pending',
         razorpay_order_id = NULL
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'payment_mode', p_payment_mode,
    'status', 'pending'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.change_order_payment_mode(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_order_payment_mode(uuid, text) TO authenticated;

COMMIT;
