-- =============================================================================
-- Thakkar Medico — V76: POS Fulfillment Mode & Settings Fix
--
-- 1. Normalizes p_fulfillment_mode in public.place_order ('pickup', 'self_pickup', 'counter_pickup' -> 'pickup')
-- 2. Permits pickup mode for admin/delivery staff even if settings table is uninitialized
-- 3. Ensures default row exists in public.settings with valid UUID
-- =============================================================================

BEGIN;

-- Add pickup_enabled column if it doesn't exist yet
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS pickup_enabled boolean NOT NULL DEFAULT true;

-- Ensure default row in settings with a valid UUID
INSERT INTO public.settings (id, gst_enabled, pickup_enabled, loyalty_redemption_rate, max_redemption_percent)
SELECT gen_random_uuid(), true, true, 0.5, 20
WHERE NOT EXISTS (SELECT 1 FROM public.settings);

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,          -- [{"product_id": uuid, "qty": int, "packaging_level_id"?: uuid, "units_per_level"?: int}]
  p_address          text,
  p_idempotency_key  uuid,
  p_payment_mode     text    DEFAULT 'cod',
  p_redeem_points    int     DEFAULT 0,
  p_fulfillment_mode text    DEFAULT 'delivery',
  p_delivery         jsonb   DEFAULT NULL,
  p_notes            text    DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id         uuid    := auth.uid();
  v_caller_role       text;
  v_is_self_order     boolean;
  v_retailer_approved boolean;
  v_order_id          uuid;
  v_order_number      text;
  v_existing_order    jsonb;
  v_gst_enabled       boolean;
  v_subtotal          numeric := 0;
  v_gst_total         numeric := 0;
  v_grand_total       numeric := 0;
  v_item              jsonb;
  v_product_id        uuid;
  v_qty               integer;
  v_base_qty          integer;
  v_units_per_level   integer;
  v_unit_price        numeric;
  v_gst_pct           numeric;
  v_stock             integer;
  v_line_total        numeric;
  v_line_gst          numeric;
  v_retailer_name     text;
  v_retailer_phone    text;
  v_credit_limit      numeric;
  v_credit_used       numeric;
  v_initial_status    text := 'pending';
  v_discount          numeric := 0;
  v_redemption_rate   numeric;
  v_max_pct           numeric;
  v_max_discount      numeric;
  v_retailer_points   int;
  v_pickup_enabled    boolean;
  v_delivery_text     text;
  v_delivery_id       uuid;
  v_delivery_snapshot jsonb;
  -- Batch allocation vars
  v_batch             RECORD;
  v_remaining         integer;
  v_take              integer;
  v_allocations       jsonb;
  -- Assignment var
  v_assigned_to       uuid := NULL;
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 1: Payment mode validation
  -- -----------------------------------------------------------------------
  IF p_payment_mode NOT IN ('cod', 'credit', 'upi') THEN
    RAISE EXCEPTION 'invalid_payment_mode'
      USING HINT = 'Payment mode must be cod, credit, or upi';
  END IF;

  IF p_payment_mode = 'upi' THEN
    v_initial_status := 'pending_payment';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 2: Fulfillment mode normalization & validation
  -- -----------------------------------------------------------------------
  IF p_fulfillment_mode IN ('self_pickup', 'counter_pickup', 'pickup') THEN
    p_fulfillment_mode := 'pickup';
  ELSIF p_fulfillment_mode NOT IN ('delivery', 'pickup') THEN
    p_fulfillment_mode := 'delivery';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 3: Idempotency check
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
  -- Step 4: Authorization & Role Check
  -- -----------------------------------------------------------------------
  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  v_is_self_order := (v_caller_id = p_retailer_id);

  IF NOT v_is_self_order AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only the retailer themselves or staff can place orders';
  END IF;

  -- Auto-assign to delivery rider if created by them
  IF v_caller_role = 'delivery' THEN
    v_assigned_to := v_caller_id;
  END IF;

  -- If order is created by Admin, set initial status to 'approved' directly
  IF v_caller_role = 'admin' AND p_payment_mode != 'upi' THEN
    v_initial_status := 'approved';
  END IF;

  -- If customer self-order is pickup, check settings
  IF p_fulfillment_mode = 'pickup' AND v_caller_role NOT IN ('admin', 'delivery') THEN
    SELECT COALESCE(s.pickup_enabled, true)
      INTO v_pickup_enabled
      FROM settings s LIMIT 1;
    IF v_pickup_enabled IS NOT NULL AND NOT v_pickup_enabled THEN
      RAISE EXCEPTION 'pickup_not_enabled'
        USING HINT = 'Pickup mode is not currently enabled';
    END IF;
  END IF;

  SELECT approved, COALESCE(name, business_name, 'Retailer'), COALESCE(phone, ''),
         credit_limit, credit_used, loyalty_points
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
  -- Step 5: Delivery address resolution
  -- -----------------------------------------------------------------------
  IF p_fulfillment_mode = 'delivery' THEN
    IF p_delivery IS NOT NULL AND p_delivery <> 'null'::jsonb THEN
      v_delivery_text := NULLIF(trim(COALESCE(p_delivery->>'full_address', '')), '');
      v_delivery_id := NULLIF(p_delivery->>'delivery_address_id', '')::uuid;
      v_delivery_snapshot := p_delivery;

      IF v_delivery_text IS NULL THEN
        RAISE EXCEPTION 'delivery_address_required'
          USING HINT = 'Please select a delivery shop location';
      END IF;

      IF v_delivery_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.retailer_shop_locations
           WHERE id = v_delivery_id
             AND retailer_account_id = p_retailer_id
         ) THEN
          RAISE EXCEPTION 'invalid_delivery_address'
            USING HINT = 'Delivery location does not belong to this retailer';
        END IF;
      END IF;
    ELSIF p_address IS NULL OR trim(p_address) = '' THEN
      RAISE EXCEPTION 'delivery_address_required'
        USING HINT = 'Please select a delivery shop location';
    ELSE
      v_delivery_text := trim(p_address);
      v_delivery_id := NULL;
      v_delivery_snapshot := NULL;
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 6: Settings
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true),
         COALESCE(s.loyalty_redemption_rate, 0.5),
         COALESCE(s.max_redemption_percent, 20)
    INTO v_gst_enabled, v_redemption_rate, v_max_pct
    FROM settings s
   LIMIT 1;

  IF v_gst_enabled IS NULL THEN v_gst_enabled := true; END IF;
  IF v_redemption_rate IS NULL THEN v_redemption_rate := 0.5; END IF;
  IF v_max_pct IS NULL THEN v_max_pct := 20; END IF;

  -- -----------------------------------------------------------------------
  -- Step 7: Validate stock + compute totals (first pass)
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    -- If packaging level provided, compute base-unit qty
    v_units_per_level := COALESCE((v_item ->> 'units_per_level')::integer, 1);
    IF v_units_per_level < 1 THEN v_units_per_level := 1; END IF;
    v_base_qty := v_qty * v_units_per_level;

    IF v_base_qty IS NULL OR v_base_qty <= 0 THEN
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

    IF v_stock < v_base_qty THEN
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('Product %s: requested %s but only %s in stock', v_product_id, v_base_qty, v_stock);
    END IF;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_base_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;

    v_line_total := ROUND(v_unit_price * v_base_qty, 2) + v_line_gst;
    v_subtotal   := v_subtotal + ROUND(v_unit_price * v_base_qty, 2);
    v_gst_total  := v_gst_total + v_line_gst;
  END LOOP;

  v_grand_total := v_subtotal + v_gst_total;

  -- -----------------------------------------------------------------------
  -- Step 8: Loyalty redemption
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
  -- Step 9: Credit check
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s',
                            v_credit_used, v_grand_total, v_credit_limit);
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 10: Create the order
  -- -----------------------------------------------------------------------
  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_address_id, delivery_snapshot,
    delivery_type, payment_mode,
    fulfillment_mode, discount_amount,
    notes,
    status, idempotency_key, created_by, assigned_to
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_text END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_id END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_snapshot END,
    p_fulfillment_mode, p_payment_mode,
    p_fulfillment_mode, v_discount,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    v_initial_status, p_idempotency_key, v_caller_id, v_assigned_to
  );

  -- -----------------------------------------------------------------------
  -- Step 11: Credit update
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 12: Loyalty transaction log
  -- -----------------------------------------------------------------------
  IF p_redeem_points > 0 THEN
    INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
    VALUES (p_retailer_id, v_order_id, -p_redeem_points, 'redeemed_at_checkout', 'redeemed');
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 13: Insert order_items + FEFO batch allocation + stock history
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id      := (v_item ->> 'product_id')::uuid;
    v_qty             := (v_item ->> 'qty')::integer;
    v_units_per_level := COALESCE((v_item ->> 'units_per_level')::integer, 1);
    IF v_units_per_level < 1 THEN v_units_per_level := 1; END IF;
    v_base_qty        := v_qty * v_units_per_level;

    SELECT selling_price, gst_percent INTO v_unit_price, v_gst_pct
      FROM products WHERE id = v_product_id;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_base_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;
    v_line_total := ROUND(v_unit_price * v_base_qty, 2) + v_line_gst;

    -- FEFO batch allocation
    v_remaining    := v_base_qty;
    v_allocations  := '[]'::jsonb;

    FOR v_batch IN
      SELECT id AS batch_id, quantity AS batch_qty
        FROM product_batches
       WHERE product_id = v_product_id
          AND is_active = true
          AND quantity > 0
       ORDER BY expiry_date ASC NULLS LAST, created_at ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;

      v_take := LEAST(v_remaining, v_batch.batch_qty);

      UPDATE product_batches
         SET quantity = quantity - v_take
       WHERE id = v_batch.batch_id;

      v_allocations := v_allocations || jsonb_build_array(
        jsonb_build_object('batch_id', v_batch.batch_id, 'qty', v_take)
      );

      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('FEFO allocation failed for product %s: %s units unallocated', v_product_id, v_remaining);
    END IF;

    -- Insert order_item with batch_allocations
    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total, batch_allocations)
    VALUES (v_order_id, v_product_id, v_base_qty, v_unit_price, v_gst_pct, v_line_total, v_allocations);

    -- Stock history audit
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, -v_base_qty, 'Order ' || v_order_number);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 14: Clear the retailer's cart
  -- -----------------------------------------------------------------------
  DELETE FROM cart_items WHERE user_id = p_retailer_id;

  -- -----------------------------------------------------------------------
  -- Step 15: Log initial status event
  -- -----------------------------------------------------------------------
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (v_order_id, NULL, v_initial_status, v_caller_id);

  -- -----------------------------------------------------------------------
  -- Done
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

GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text) TO authenticated;

COMMIT;
