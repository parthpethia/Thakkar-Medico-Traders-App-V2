-- =============================================================================
-- Thakkar Medico — V27: Restore stock when order is cancelled
--
-- BUG: stock_quantity is deducted at order placement (place_order RPC) but
--      never restored when an order is cancelled. This causes an inventory leak.
--
-- FIX: Add a loop inside the cancellation block of enforce_order_status_transition
--      that iterates over order_items and restores stock + logs to stock_history.
--      Follows the same pattern as restore_credit() which already runs on cancel.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-pa.sql must have been run first
-- =============================================================================

BEGIN;

-- Replace the trigger function body — does NOT touch the trigger itself
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
BEGIN
  -- Skip if status hasn't changed
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Valid transitions
  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled')    THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled')    THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled')      THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled')  THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')   THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  -- Log the transition in order_status_events
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  -- Cancellation: restore credit AND stock
  IF NEW.status = 'cancelled' THEN
    -- Restore credit (existing behavior)
    PERFORM restore_credit(NEW.id);

    -- Restore stock for each item in the order
    FOR v_item IN
      SELECT product_id, qty
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      -- Add stock back to product
      UPDATE products
         SET stock_quantity = stock_quantity + v_item.qty
       WHERE id = v_item.product_id;

      -- Audit trail for the stock restore
      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Cancelled order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  -- Accrue loyalty points when order is delivered
  IF NEW.status = 'delivered' THEN
    v_points := FLOOR(NEW.grand_total / 100);
    IF v_points > 0 THEN
      INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason)
      VALUES (NEW.user_id, NEW.id, v_points, 'order_delivered');

      UPDATE profiles
         SET loyalty_points = loyalty_points + v_points
       WHERE id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
