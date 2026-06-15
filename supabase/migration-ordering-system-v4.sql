-- =============================================================================
-- Thakkar Medico — Ordering System V4 (P2) Migration
-- Notifications infra, credit limits, loyalty points, payment modes
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v3.sql must have been run first
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: FIX B — notifications_log table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifications_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        REFERENCES public.orders (id) ON DELETE SET NULL,
  to_status   text,
  phone       text,
  provider    text,
  status      text        CHECK (status IN ('sent', 'failed', 'skipped')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_log_select_admin" ON public.notifications_log;
CREATE POLICY "notifications_log_select_admin" ON public.notifications_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "notifications_log_insert_service" ON public.notifications_log;
CREATE POLICY "notifications_log_insert_service" ON public.notifications_log
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE INDEX IF NOT EXISTS idx_notifications_log_order_id
  ON public.notifications_log (order_id);

-- =============================================================================
-- SECTION 2: FIX C — credit_limit / credit_used on profiles
-- (columns already exist in setup.sql, but ensure constraints are present)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_credit_used_nonneg'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_credit_used_nonneg CHECK (credit_used >= 0);
  END IF;
END $$;

-- =============================================================================
-- SECTION 3: FIX D — loyalty_points constraint + loyalty_transactions table
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_loyalty_points_nonneg'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_loyalty_points_nonneg CHECK (loyalty_points >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  order_id    uuid        REFERENCES public.orders (id) ON DELETE SET NULL,
  points      int         NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "loyalty_transactions_select_own" ON public.loyalty_transactions;
CREATE POLICY "loyalty_transactions_select_own" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (retailer_id = auth.uid());

DROP POLICY IF EXISTS "loyalty_transactions_select_admin" ON public.loyalty_transactions;
CREATE POLICY "loyalty_transactions_select_admin" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_retailer_id
  ON public.loyalty_transactions (retailer_id);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_order_id
  ON public.loyalty_transactions (order_id);

-- =============================================================================
-- SECTION 4: FIX E — payment_mode column + pending_payment status
-- =============================================================================

-- 4a. Update the status CHECK constraint to include 'pending_payment'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_status_check'
  ) THEN
    ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
  END IF;

  ALTER TABLE public.orders
    ADD CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'pending_payment', 'approved', 'packed', 'dispatched', 'delivered', 'cancelled'));
END $$;

-- 4b. Add payment_mode CHECK constraint (the column already exists in setup.sql)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_payment_mode_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_mode_check
      CHECK (payment_mode IN ('cod', 'credit', 'upi'));
  END IF;
END $$;

-- 4c. Add payment_modes_enabled to settings (for admin to toggle)
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS payment_modes_enabled jsonb
    NOT NULL DEFAULT '["cod","credit","upi"]'::jsonb;

-- =============================================================================
-- SECTION 5: FIX C — restore_credit helper function
-- =============================================================================

CREATE OR REPLACE FUNCTION public.restore_credit(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retailer_id uuid;
  v_grand_total numeric;
  v_payment_mode text;
BEGIN
  SELECT user_id, grand_total, COALESCE(payment_mode, 'cod')
    INTO v_retailer_id, v_grand_total, v_payment_mode
    FROM orders
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only restore credit if the order was placed on credit
  IF v_payment_mode <> 'credit' THEN
    RETURN;
  END IF;

  -- Guard: never let credit_used go below zero
  UPDATE profiles
     SET credit_used = GREATEST(credit_used - v_grand_total, 0)
   WHERE id = v_retailer_id;
END;
$$;

-- =============================================================================
-- SECTION 6: Updated place_order RPC (FIX C credit check + FIX E payment_mode)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,
  p_address          text,
  p_idempotency_key  uuid,
  p_payment_mode     text DEFAULT 'cod'    -- CHANGED: new parameter for payment mode
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id        uuid    := auth.uid();
  v_caller_role      text;
  v_is_self_order    boolean;
  v_retailer_approved boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_existing_order   jsonb;
  v_gst_enabled      boolean;
  v_subtotal         numeric := 0;
  v_gst_total        numeric := 0;
  v_grand_total      numeric := 0;
  v_item             jsonb;
  v_product_id       uuid;
  v_qty              integer;
  v_unit_price       numeric;
  v_gst_pct          numeric;
  v_stock            integer;
  v_line_total       numeric;
  v_line_gst         numeric;
  v_retailer_name    text;
  v_retailer_phone   text;
  v_credit_limit     numeric;                -- CHANGED: for credit check
  v_credit_used      numeric;                -- CHANGED: for credit check
  v_initial_status   text := 'pending';      -- CHANGED: may become 'pending_payment'
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 0: Validate payment mode                              -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_payment_mode NOT IN ('cod', 'credit', 'upi') THEN
    RAISE EXCEPTION 'invalid_payment_mode'
      USING HINT = 'Payment mode must be cod, credit, or upi';
  END IF;

  -- UPI orders start as pending_payment until payment confirmed -- CHANGED
  IF p_payment_mode = 'upi' THEN
    v_initial_status := 'pending_payment';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 1: Idempotency — return existing order if this key was already used
  -- -----------------------------------------------------------------------
  SELECT jsonb_build_object('order_id', id, 'order_number', order_number, 'already_exists', true)
    INTO v_existing_order
    FROM orders
   WHERE idempotency_key = p_idempotency_key
   LIMIT 1;

  IF v_existing_order IS NOT NULL THEN
    RETURN v_existing_order;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 2: Verify the caller is authorized
  -- -----------------------------------------------------------------------
  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  v_is_self_order := (v_caller_id = p_retailer_id);

  IF NOT v_is_self_order AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only the retailer themselves or staff can place orders';
  END IF;

  -- Retailer must be approved
  SELECT approved, COALESCE(name, business_name, 'Retailer'), COALESCE(phone, ''),
         credit_limit, credit_used                              -- CHANGED: fetch credit info
    INTO v_retailer_approved, v_retailer_name, v_retailer_phone,
         v_credit_limit, v_credit_used
    FROM profiles
   WHERE id = p_retailer_id AND role = 'retailer';

  IF v_retailer_approved IS NULL THEN
    RAISE EXCEPTION 'not_approved'
      USING HINT = 'Retailer not found or is not a retailer role';
  END IF;

  IF NOT v_retailer_approved THEN
    RAISE EXCEPTION 'not_approved'
      USING HINT = 'Retailer account is pending approval';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 3: Read GST setting
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true)
    INTO v_gst_enabled
    FROM settings s
   LIMIT 1;

  -- -----------------------------------------------------------------------
  -- Step 4: Lock product rows and validate stock
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_quantity'
        USING HINT = 'Each item must have qty > 0';
    END IF;

    SELECT selling_price, gst_percent, stock_quantity
      INTO v_unit_price, v_gst_pct, v_stock
      FROM products
     WHERE id = v_product_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found'
        USING HINT = format('Product %s does not exist', v_product_id);
    END IF;

    IF v_stock < v_qty THEN
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('Product %s: requested %s but only %s in stock', v_product_id, v_qty, v_stock);
    END IF;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;

    v_line_total := ROUND(v_unit_price * v_qty, 2) + v_line_gst;
    v_subtotal   := v_subtotal + ROUND(v_unit_price * v_qty, 2);
    v_gst_total  := v_gst_total + v_line_gst;
  END LOOP;

  v_grand_total := v_subtotal + v_gst_total;

  -- -----------------------------------------------------------------------
  -- Step 4b: Credit limit check (FIX C)                        -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s',
                            v_credit_used, v_grand_total, v_credit_limit);
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 5: Create the order with a UUID-based order number
  -- -----------------------------------------------------------------------
  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_type, payment_mode,
    status, idempotency_key, created_by
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    p_address, 'delivery', p_payment_mode,                      -- CHANGED: use p_payment_mode
    v_initial_status, p_idempotency_key, v_caller_id            -- CHANGED: use v_initial_status
  );

  -- -----------------------------------------------------------------------
  -- Step 5b: Debit credit if payment_mode = 'credit' (FIX C)  -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 6: Insert normalized order_items + decrement stock + log history
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    SELECT selling_price, gst_percent INTO v_unit_price, v_gst_pct
      FROM products WHERE id = v_product_id;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;
    v_line_total := ROUND(v_unit_price * v_qty, 2) + v_line_gst;

    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total)
    VALUES (v_order_id, v_product_id, v_qty, v_unit_price, v_gst_pct, v_line_total);

    UPDATE products
       SET stock_quantity = stock_quantity - v_qty
     WHERE id = v_product_id;

    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, -v_qty, 'Order ' || v_order_number);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 7: Clear the retailer's cart (only for self-placed orders)
  -- -----------------------------------------------------------------------
  DELETE FROM cart_items WHERE user_id = p_retailer_id;

  -- -----------------------------------------------------------------------
  -- Step 8: Log the initial status event
  -- -----------------------------------------------------------------------
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (v_order_id, NULL, v_initial_status, v_caller_id);   -- CHANGED: use v_initial_status

  -- -----------------------------------------------------------------------
  -- Done — return the new order's identifiers
  -- -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'already_exists', false
  );
END;
$$;

-- Re-grant (signature changed with new parameter)
REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text) TO authenticated;

-- =============================================================================
-- SECTION 7: Status transition trigger
-- (FIX C — restore_credit on cancel, FIX D — loyalty accrual on delivered)
-- =============================================================================

-- 7a. Valid transition map + trigger function
CREATE OR REPLACE FUNCTION public.enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid       boolean := false;
  v_points      int;
BEGIN
  -- Skip if status hasn't changed
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Valid transitions
  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled')    THEN true  -- CHANGED: pending_payment flows
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled')    THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled')      THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled')  THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')   THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % → %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  -- Log the transition in order_status_events
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  -- CHANGED: FIX C — restore credit when order is cancelled
  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);
  END IF;

  -- CHANGED: FIX D — accrue loyalty points when order is delivered
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

-- 7b. Attach trigger (idempotent re-create)
DROP TRIGGER IF EXISTS trg_enforce_order_status ON public.orders;
CREATE TRIGGER trg_enforce_order_status
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_status_transition();

-- =============================================================================
-- SECTION 8: Enable Realtime on orders table (FIX A)
-- =============================================================================

-- Supabase Realtime requires the table to be added to the publication.
-- This is idempotent — Supabase ignores if already added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
END $$;

-- =============================================================================
-- SECTION 9: Webhook comment for Edge Function (FIX B)
-- =============================================================================

-- To enable the notification webhook, run this in Supabase CLI or Dashboard:
--
-- supabase functions deploy notify-order-status
--
-- Then create a Database Webhook in Dashboard → Database → Webhooks:
--   Name:    notify-order-status
--   Table:   order_status_events
--   Events:  INSERT
--   Type:    Supabase Edge Function
--   Function: notify-order-status
--
-- The Edge Function reads the inserted row and sends notifications.

COMMIT;
