-- =============================================================================
-- Thakkar Medico — Ordering System V5 (P3) Migration
-- Credit management, loyalty redemption, pickup mode, admin settings, stats, push
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v4.sql must have been run first
-- =============================================================================

BEGIN;

-- =============================================================================
-- FIX A: Credit account management — credit_adjustments table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.credit_adjustments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id  uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  amount       numeric     NOT NULL,
  reason       text,
  adjusted_by  uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credit_adjustments_select_admin" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_select_admin" ON public.credit_adjustments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "credit_adjustments_select_own" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_select_own" ON public.credit_adjustments
  FOR SELECT TO authenticated
  USING (retailer_id = auth.uid());

DROP POLICY IF EXISTS "credit_adjustments_insert_admin" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_insert_admin" ON public.credit_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE INDEX IF NOT EXISTS idx_credit_adjustments_retailer_id
  ON public.credit_adjustments (retailer_id);

-- Adjusts a retailer's credit limit. Admin only.
CREATE OR REPLACE FUNCTION public.adjust_credit_limit(
  p_retailer_id  uuid,
  p_amount       numeric,
  p_reason       text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role   text;
  v_current_limit numeric;
  v_current_used  numeric;
  v_new_limit     numeric;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only admins can adjust credit limits';
  END IF;

  SELECT credit_limit, credit_used
    INTO v_current_limit, v_current_used
    FROM profiles
   WHERE id = p_retailer_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'retailer_not_found' USING HINT = 'Retailer does not exist';
  END IF;

  v_new_limit := v_current_limit + p_amount;

  IF v_new_limit < v_current_used THEN
    RAISE EXCEPTION 'limit_below_used'
      USING HINT = format('New limit %s would be below current usage %s', v_new_limit, v_current_used);
  END IF;

  UPDATE profiles SET credit_limit = v_new_limit WHERE id = p_retailer_id;

  INSERT INTO credit_adjustments (retailer_id, amount, reason, adjusted_by)
  VALUES (p_retailer_id, p_amount, p_reason, auth.uid());

  RETURN v_new_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_credit_limit(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_credit_limit(uuid, numeric, text) TO authenticated;

-- Resets credit_used when full payment is received for a credit order.
CREATE OR REPLACE FUNCTION public.reset_credit_used(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role  text;
  v_retailer_id  uuid;
  v_grand_total  numeric;
  v_payment_mode text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only admins can reset credit';
  END IF;

  SELECT user_id, grand_total, COALESCE(payment_mode, 'cod')
    INTO v_retailer_id, v_grand_total, v_payment_mode
    FROM orders
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_payment_mode <> 'credit' THEN
    RAISE EXCEPTION 'not_credit_order' USING HINT = 'This order was not placed on credit';
  END IF;

  UPDATE profiles
     SET credit_used = GREATEST(credit_used - v_grand_total, 0)
   WHERE id = v_retailer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_credit_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_credit_used(uuid) TO authenticated;


-- =============================================================================
-- FIX B: Loyalty redemption — columns + function
-- =============================================================================

-- Add type column to loyalty_transactions
ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS type text DEFAULT 'earned';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_transactions_type_check'
  ) THEN
    ALTER TABLE public.loyalty_transactions
      ADD CONSTRAINT loyalty_transactions_type_check
      CHECK (type IN ('earned', 'redeemed'));
  END IF;
END $$;

-- Backfill existing rows
UPDATE public.loyalty_transactions SET type = 'earned' WHERE type IS NULL;

-- Add discount_amount to orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0;

-- Add loyalty settings columns
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS loyalty_redemption_rate numeric NOT NULL DEFAULT 0.5;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS max_redemption_percent numeric NOT NULL DEFAULT 20;

-- Redeems loyalty points against an order. Called inside place_order for atomicity.
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(
  p_retailer_id  uuid,
  p_order_id     uuid,
  p_points       int
)
RETURNS TABLE (new_grand_total numeric, points_remaining int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_points   int;
  v_redemption_rate  numeric;
  v_max_pct          numeric;
  v_order_total      numeric;
  v_discount         numeric;
  v_max_discount     numeric;
BEGIN
  SELECT loyalty_points INTO v_current_points
    FROM profiles WHERE id = p_retailer_id;

  IF v_current_points < p_points THEN
    RAISE EXCEPTION 'insufficient_points'
      USING HINT = format('Have %s points but tried to redeem %s', v_current_points, p_points);
  END IF;

  SELECT loyalty_redemption_rate, max_redemption_percent
    INTO v_redemption_rate, v_max_pct
    FROM settings LIMIT 1;

  SELECT grand_total INTO v_order_total FROM orders WHERE id = p_order_id;

  v_discount := ROUND(p_points * v_redemption_rate, 2);
  v_max_discount := ROUND(v_order_total * v_max_pct / 100, 2);

  IF v_discount > v_max_discount THEN
    RAISE EXCEPTION 'redemption_limit_exceeded'
      USING HINT = format('Discount %s exceeds max %s%% of order value %s', v_discount, v_max_pct, v_order_total);
  END IF;

  UPDATE profiles
     SET loyalty_points = loyalty_points - p_points
   WHERE id = p_retailer_id;

  INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
  VALUES (p_retailer_id, p_order_id, -p_points, 'redeemed_at_checkout', 'redeemed');

  UPDATE orders
     SET discount_amount = discount_amount + v_discount,
         grand_total = grand_total - v_discount
   WHERE id = p_order_id;

  RETURN QUERY
    SELECT o.grand_total, p.loyalty_points
      FROM orders o, profiles p
     WHERE o.id = p_order_id AND p.id = p_retailer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_loyalty_points(uuid, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, uuid, int) TO authenticated;


-- =============================================================================
-- FIX C: Pickup mode — columns on orders + settings
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS fulfillment_mode text NOT NULL DEFAULT 'delivery';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_fulfillment_mode_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_fulfillment_mode_check
      CHECK (fulfillment_mode IN ('delivery', 'pickup'));
  END IF;
END $$;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS pickup_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS pickup_address text;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS pickup_hours text;


-- =============================================================================
-- FIX D: Admin settings — update_settings function + support_phone
-- =============================================================================

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS support_phone text;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS gst_percent numeric NOT NULL DEFAULT 18;

-- Server-side settings updater that validates keys against an allow-list.
CREATE OR REPLACE FUNCTION public.update_settings(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_settings_id uuid;
  v_result      jsonb;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only admins can update settings';
  END IF;

  IF p_key NOT IN (
    'gst_enabled', 'gst_percent',
    'credit_enabled', 'loyalty_enabled',
    'delivery_enabled', 'pickup_enabled',
    'pickup_address', 'pickup_hours',
    'payment_modes_enabled',
    'loyalty_redemption_rate', 'max_redemption_percent',
    'support_phone',
    'show_prices_to_unverified'
  ) THEN
    RAISE EXCEPTION 'invalid_setting_key'
      USING HINT = format('Key "%s" is not an allowed setting', p_key);
  END IF;

  SELECT id INTO v_settings_id FROM settings LIMIT 1;

  IF p_key IN ('gst_enabled', 'credit_enabled', 'loyalty_enabled',
                'delivery_enabled', 'pickup_enabled', 'show_prices_to_unverified') THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = ($1 #>> ''{}'')::boolean, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSIF p_key IN ('gst_percent', 'loyalty_redemption_rate', 'max_redemption_percent') THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = ($1 #>> ''{}'')::numeric, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSIF p_key = 'payment_modes_enabled' THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = $1, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSE
    EXECUTE format(
      'UPDATE public.settings SET %I = $1 #>> ''{}'', updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  END IF;

  SELECT row_to_json(s) INTO v_result FROM settings s WHERE s.id = v_settings_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.update_settings(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_settings(text, jsonb) TO authenticated;


-- =============================================================================
-- FIX E: Retailer stats function
-- =============================================================================

-- Returns aggregate order stats for a retailer in a single call.
CREATE OR REPLACE FUNCTION public.get_retailer_stats(p_retailer_id uuid)
RETURNS TABLE (
  total_orders      int,
  total_value       numeric,
  avg_order_value   numeric,
  pending_count     int,
  credit_limit      numeric,
  credit_used       numeric,
  loyalty_points    int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_caller_role text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = v_caller_id;

  IF v_caller_id <> p_retailer_id AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
    SELECT
      COALESCE((SELECT COUNT(*)::int FROM orders WHERE user_id = p_retailer_id AND status <> 'cancelled'), 0),
      COALESCE((SELECT SUM(grand_total) FROM orders WHERE user_id = p_retailer_id AND status = 'delivered'), 0),
      COALESCE((SELECT ROUND(AVG(grand_total), 2) FROM orders WHERE user_id = p_retailer_id AND status = 'delivered'), 0),
      COALESCE((SELECT COUNT(*)::int FROM orders WHERE user_id = p_retailer_id AND status = 'pending'), 0),
      p.credit_limit,
      p.credit_used,
      p.loyalty_points
    FROM profiles p
    WHERE p.id = p_retailer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_retailer_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_retailer_stats(uuid) TO authenticated;


-- =============================================================================
-- FIX F: Push notification prep — columns on profiles
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_token text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true;


-- =============================================================================
-- UPDATED place_order RPC — adds p_redeem_points and p_fulfillment_mode
-- Full replacement of the V4 version. Changed blocks marked with -- CHANGED.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,
  p_address          text,
  p_idempotency_key  uuid,
  p_payment_mode     text DEFAULT 'cod',
  p_redeem_points    int  DEFAULT 0,        -- CHANGED: loyalty redemption parameter
  p_fulfillment_mode text DEFAULT 'delivery' -- CHANGED: pickup/delivery parameter
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
  v_credit_limit     numeric;
  v_credit_used      numeric;
  v_initial_status   text := 'pending';
  v_discount         numeric := 0;          -- CHANGED: for loyalty redemption
  v_redemption_rate  numeric;               -- CHANGED: loyalty rate from settings
  v_max_pct          numeric;               -- CHANGED: max redemption percent
  v_max_discount     numeric;               -- CHANGED: computed cap
  v_retailer_points  int;                   -- CHANGED: current loyalty balance
  v_pickup_enabled   boolean;               -- CHANGED: pickup setting
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 0: Validate payment mode
  -- -----------------------------------------------------------------------
  IF p_payment_mode NOT IN ('cod', 'credit', 'upi') THEN
    RAISE EXCEPTION 'invalid_payment_mode'
      USING HINT = 'Payment mode must be cod, credit, or upi';
  END IF;

  IF p_payment_mode = 'upi' THEN
    v_initial_status := 'pending_payment';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 0b: Validate fulfillment mode                        -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_fulfillment_mode NOT IN ('delivery', 'pickup') THEN
    RAISE EXCEPTION 'invalid_fulfillment_mode'
      USING HINT = 'Fulfillment mode must be delivery or pickup';
  END IF;

  IF p_fulfillment_mode = 'pickup' THEN                        -- CHANGED
    SELECT COALESCE(s.pickup_enabled, false)
      INTO v_pickup_enabled
      FROM settings s LIMIT 1;
    IF NOT v_pickup_enabled THEN
      RAISE EXCEPTION 'pickup_not_enabled'
        USING HINT = 'Pickup mode is not currently enabled';
    END IF;
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

  SELECT approved, COALESCE(name, business_name, 'Retailer'), COALESCE(phone, ''),
         credit_limit, credit_used, loyalty_points              -- CHANGED: also fetch loyalty_points
    INTO v_retailer_approved, v_retailer_name, v_retailer_phone,
         v_credit_limit, v_credit_used, v_retailer_points
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
  -- Step 3: Read settings (GST + loyalty rates)
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true),
         COALESCE(s.loyalty_redemption_rate, 0.5),              -- CHANGED
         COALESCE(s.max_redemption_percent, 20)                 -- CHANGED
    INTO v_gst_enabled, v_redemption_rate, v_max_pct
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
  -- Step 4b: Loyalty redemption (inline for atomicity)         -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_redeem_points > 0 THEN
    IF v_retailer_points < p_redeem_points THEN
      RAISE EXCEPTION 'insufficient_points'
        USING HINT = format('Have %s points but tried to redeem %s', v_retailer_points, p_redeem_points);
    END IF;

    v_discount := ROUND(p_redeem_points * v_redemption_rate, 2);
    v_max_discount := ROUND(v_grand_total * v_max_pct / 100, 2);

    IF v_discount > v_max_discount THEN
      RAISE EXCEPTION 'redemption_limit_exceeded'
        USING HINT = format('Discount %s exceeds max %s%% of order value %s', v_discount, v_max_pct, v_grand_total);
    END IF;

    v_grand_total := v_grand_total - v_discount;

    UPDATE profiles
       SET loyalty_points = loyalty_points - p_redeem_points
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 4c: Credit limit check
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s',
                            v_credit_used, v_grand_total, v_credit_limit);
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 5: Create the order
  -- -----------------------------------------------------------------------
  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_type, payment_mode,
    fulfillment_mode, discount_amount,                          -- CHANGED
    status, idempotency_key, created_by
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE p_address END,  -- CHANGED: no address for pickup
    p_fulfillment_mode, p_payment_mode,                         -- CHANGED: use fulfillment_mode as delivery_type
    p_fulfillment_mode, v_discount,                             -- CHANGED: store fulfillment_mode + discount
    v_initial_status, p_idempotency_key, v_caller_id
  );

  -- -----------------------------------------------------------------------
  -- Step 5b: Debit credit if payment_mode = 'credit'
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 5c: Log loyalty redemption transaction                -- CHANGED
  -- -----------------------------------------------------------------------
  IF p_redeem_points > 0 THEN
    INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
    VALUES (p_retailer_id, v_order_id, -p_redeem_points, 'redeemed_at_checkout', 'redeemed');
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
  VALUES (v_order_id, NULL, v_initial_status, v_caller_id);

  -- -----------------------------------------------------------------------
  -- Done — return the new order's identifiers                  -- CHANGED: include discount
  -- -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'order_id',        v_order_id,
    'order_number',    v_order_number,
    'already_exists',  false,
    'discount_amount', v_discount,
    'grand_total',     v_grand_total
  );
END;
$$;

-- Re-grant (signature changed with new parameters)
REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text) TO authenticated;


COMMIT;
