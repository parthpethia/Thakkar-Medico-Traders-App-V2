-- ============================================================================
-- Migration v25: B2B retailer shop delivery locations + order address snapshot
-- Run after v24.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Shop locations table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retailer_shop_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_account_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  added_by text NOT NULL DEFAULT 'retailer' CHECK (added_by IN ('retailer', 'admin')),
  is_locked_by_admin boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  visible_to_group boolean NOT NULL DEFAULT false,

  branch_label text NOT NULL CHECK (
    branch_label IN ('main_shop', 'warehouse', 'branch', 'godown', 'custom')
  ),
  custom_label text,
  shop_name text NOT NULL,
  gstin text,

  lat double precision NOT NULL,
  lng double precision NOT NULL,
  formatted_address text,
  shop_no text NOT NULL,
  building text NOT NULL,
  street text,
  landmark text NOT NULL,
  area text NOT NULL,
  city text NOT NULL,
  state text NOT NULL DEFAULT '',
  pincode text NOT NULL,

  best_delivery_time_start time,
  best_delivery_time_end time,
  entry_notes text,
  parking text CHECK (parking IS NULL OR parking IN ('yes', 'no', 'street')),

  receiver_name text NOT NULL,
  receiver_phone text NOT NULL,
  alternate_phone text,

  admin_internal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_locations_retailer
  ON public.retailer_shop_locations (retailer_account_id);

CREATE INDEX IF NOT EXISTS idx_shop_locations_retailer_default
  ON public.retailer_shop_locations (retailer_account_id, is_default)
  WHERE is_default = true;

COMMENT ON TABLE public.retailer_shop_locations IS '@graphql({"ignore": true})';

-- ---------------------------------------------------------------------------
-- 2. Order snapshot columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_address_id uuid
    REFERENCES public.retailer_shop_locations (id) ON DELETE SET NULL;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_snapshot jsonb;

-- ---------------------------------------------------------------------------
-- 3. updated_at + single default per retailer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shop_locations_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_locations_updated_at ON public.retailer_shop_locations;
CREATE TRIGGER trg_shop_locations_updated_at
  BEFORE UPDATE ON public.retailer_shop_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.shop_locations_set_updated_at();

CREATE OR REPLACE FUNCTION public.shop_locations_enforce_single_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE public.retailer_shop_locations
       SET is_default = false
     WHERE retailer_account_id = NEW.retailer_account_id
       AND id IS DISTINCT FROM NEW.id
       AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_locations_single_default ON public.retailer_shop_locations;
CREATE TRIGGER trg_shop_locations_single_default
  AFTER INSERT OR UPDATE OF is_default ON public.retailer_shop_locations
  FOR EACH ROW
  WHEN (NEW.is_default)
  EXECUTE FUNCTION public.shop_locations_enforce_single_default();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.retailer_shop_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_locations_select" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_select" ON public.retailer_shop_locations
  FOR SELECT TO authenticated
  USING (
    retailer_account_id = (SELECT auth.uid())
    OR (SELECT public.current_user_is_staff())
  );

DROP POLICY IF EXISTS "shop_locations_insert" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_insert" ON public.retailer_shop_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      retailer_account_id = (SELECT auth.uid())
      AND added_by = 'retailer'
    )
    OR (SELECT public.current_user_is_admin())
  );

DROP POLICY IF EXISTS "shop_locations_update" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_update" ON public.retailer_shop_locations
  FOR UPDATE TO authenticated
  USING (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_admin())
  )
  WITH CHECK (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_admin())
  );

DROP POLICY IF EXISTS "shop_locations_delete" ON public.retailer_shop_locations;
CREATE POLICY "shop_locations_delete" ON public.retailer_shop_locations
  FOR DELETE TO authenticated
  USING (
    (
      retailer_account_id = (SELECT auth.uid())
      AND NOT is_locked_by_admin
    )
    OR (SELECT public.current_user_is_admin())
  );

-- ---------------------------------------------------------------------------
-- 5. set_default_shop_location RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_default_shop_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_retailer_id uuid;
BEGIN
  SELECT retailer_account_id INTO v_retailer_id
    FROM public.retailer_shop_locations
   WHERE id = p_location_id;

  IF v_retailer_id IS NULL THEN
    RAISE EXCEPTION 'location_not_found';
  END IF;

  IF v_retailer_id <> auth.uid() AND NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.retailer_shop_locations
     SET is_default = false
   WHERE retailer_account_id = v_retailer_id;

  UPDATE public.retailer_shop_locations
     SET is_default = true
   WHERE id = p_location_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_default_shop_location(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_default_shop_location(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_default_shop_location(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. place_order — optional p_delivery jsonb + frozen snapshot on orders
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text, int, text);

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,
  p_address          text,
  p_idempotency_key  uuid,
  p_payment_mode     text DEFAULT 'cod',
  p_redeem_points    int  DEFAULT 0,
  p_fulfillment_mode text DEFAULT 'delivery',
  p_delivery         jsonb DEFAULT NULL
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
  v_discount         numeric := 0;
  v_redemption_rate  numeric;
  v_max_pct          numeric;
  v_max_discount     numeric;
  v_retailer_points  int;
  v_pickup_enabled   boolean;
  v_delivery_text    text;
  v_delivery_id      uuid;
  v_delivery_snapshot jsonb;
BEGIN
  IF p_payment_mode NOT IN ('cod', 'credit', 'upi') THEN
    RAISE EXCEPTION 'invalid_payment_mode'
      USING HINT = 'Payment mode must be cod, credit, or upi';
  END IF;

  IF p_payment_mode = 'upi' THEN
    v_initial_status := 'pending_payment';
  END IF;

  IF p_fulfillment_mode NOT IN ('delivery', 'pickup') THEN
    RAISE EXCEPTION 'invalid_fulfillment_mode'
      USING HINT = 'Fulfillment mode must be delivery or pickup';
  END IF;

  IF p_fulfillment_mode = 'pickup' THEN
    SELECT COALESCE(s.pickup_enabled, false)
      INTO v_pickup_enabled
      FROM settings s LIMIT 1;
    IF NOT v_pickup_enabled THEN
      RAISE EXCEPTION 'pickup_not_enabled'
        USING HINT = 'Pickup mode is not currently enabled';
    END IF;
  END IF;

  SELECT jsonb_build_object('order_id', id, 'order_number', order_number, 'already_exists', true)
    INTO v_existing_order
    FROM orders
   WHERE idempotency_key = p_idempotency_key
   LIMIT 1;

  IF v_existing_order IS NOT NULL THEN
    RETURN v_existing_order;
  END IF;

  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  v_is_self_order := (v_caller_id = p_retailer_id);

  IF NOT v_is_self_order AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only the retailer themselves or staff can place orders';
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

  SELECT COALESCE(s.gst_enabled, true),
         COALESCE(s.loyalty_redemption_rate, 0.5),
         COALESCE(s.max_redemption_percent, 20)
    INTO v_gst_enabled, v_redemption_rate, v_max_pct
    FROM settings s
   LIMIT 1;

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

  IF p_payment_mode = 'credit' THEN
    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s',
                            v_credit_used, v_grand_total, v_credit_limit);
    END IF;
  END IF;

  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_address_id, delivery_snapshot,
    delivery_type, payment_mode,
    fulfillment_mode, discount_amount,
    status, idempotency_key, created_by
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_text END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_id END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_snapshot END,
    p_fulfillment_mode, p_payment_mode,
    p_fulfillment_mode, v_discount,
    v_initial_status, p_idempotency_key, v_caller_id
  );

  IF p_payment_mode = 'credit' THEN
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = p_retailer_id;
  END IF;

  IF p_redeem_points > 0 THEN
    INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
    VALUES (p_retailer_id, v_order_id, -p_redeem_points, 'redeemed_at_checkout', 'redeemed');
  END IF;

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

  DELETE FROM cart_items WHERE user_id = p_retailer_id;

  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (v_order_id, NULL, v_initial_status, v_caller_id);

  RETURN jsonb_build_object(
    'order_id',        v_order_id,
    'order_number',    v_order_number,
    'already_exists',  false,
    'discount_amount', v_discount,
    'grand_total',     v_grand_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb) TO authenticated;
