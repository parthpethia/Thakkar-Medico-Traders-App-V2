-- =============================================================================
-- Thakkar Medico — Ordering System V7 (P5) Migration
-- Product Management, Authentication Hardening, Batch Operations, Localisation
--
-- Covers: FIX A (Product Management), FIX C (Auth Hardening),
--         FIX D (Batch Operations), FIX F (Localisation)
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-ordering-system-v6.sql must have been run first
-- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE)
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION: FIX A — Product Management
-- =============================================================================

-- A1. upsert_product: create or update a product row
CREATE OR REPLACE FUNCTION public.upsert_product(
  p_id              uuid     DEFAULT NULL,
  p_name            text     DEFAULT NULL,
  p_company         text     DEFAULT NULL,
  p_category        text     DEFAULT NULL,
  p_selling_price   numeric  DEFAULT NULL,
  p_mrp             numeric  DEFAULT NULL,
  p_gst_percent     numeric  DEFAULT NULL,
  p_unit            text     DEFAULT NULL,
  p_stock_quantity  int      DEFAULT NULL,
  p_active          boolean  DEFAULT true
)
RETURNS SETOF public.products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_id   uuid;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can manage products';
  END IF;

  IF COALESCE(TRIM(p_name), '') = '' THEN
    RAISE EXCEPTION 'validation_error' USING HINT = 'Product name cannot be empty';
  END IF;
  IF p_selling_price IS NULL OR p_selling_price <= 0 THEN
    RAISE EXCEPTION 'validation_error' USING HINT = 'Selling price must be greater than 0';
  END IF;
  IF p_mrp IS NULL OR p_mrp < p_selling_price THEN
    RAISE EXCEPTION 'validation_error' USING HINT = 'MRP must be >= selling price';
  END IF;
  IF p_gst_percent IS NULL OR p_gst_percent NOT IN (0, 5, 12, 18, 28) THEN
    RAISE EXCEPTION 'validation_error' USING HINT = 'GST percent must be one of: 0, 5, 12, 18, 28';
  END IF;
  IF p_stock_quantity IS NULL OR p_stock_quantity < 0 THEN
    RAISE EXCEPTION 'validation_error' USING HINT = 'Stock quantity must be >= 0';
  END IF;

  IF p_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO public.products (
      id, name, company, category, selling_price, mrp,
      gst_percent, pack_size, stock_quantity, is_active
    ) VALUES (
      v_id, p_name, p_company, p_category, p_selling_price, p_mrp,
      p_gst_percent, p_unit, p_stock_quantity, p_active
    );

    RETURN QUERY SELECT * FROM public.products WHERE id = v_id;
  ELSE
    UPDATE public.products
    SET name           = COALESCE(p_name, name),
        company        = COALESCE(p_company, company),
        category       = COALESCE(p_category, category),
        selling_price  = COALESCE(p_selling_price, selling_price),
        mrp            = COALESCE(p_mrp, mrp),
        gst_percent    = COALESCE(p_gst_percent, gst_percent),
        pack_size      = COALESCE(p_unit, pack_size),
        stock_quantity = COALESCE(p_stock_quantity, stock_quantity),
        is_active      = COALESCE(p_active, is_active)
    WHERE id = p_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found' USING HINT = 'No product with given id';
    END IF;

    RETURN QUERY SELECT * FROM public.products WHERE id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_product(uuid, text, text, text, numeric, numeric, numeric, text, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_product(uuid, text, text, text, numeric, numeric, numeric, text, int, boolean) TO authenticated;


-- A2. deactivate_product: soft-delete a product
CREATE OR REPLACE FUNCTION public.deactivate_product(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can deactivate products';
  END IF;

  UPDATE public.products SET is_active = false WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found' USING HINT = 'No product with given id';
  END IF;

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_product(uuid) TO authenticated;


-- A3. get_product_categories: distinct active categories
CREATE OR REPLACE FUNCTION public.get_product_categories()
RETURNS TABLE (category text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT DISTINCT p.category
    FROM public.products p
    WHERE p.is_active = true
      AND p.category IS NOT NULL
    ORDER BY p.category;
END;
$$;

REVOKE ALL ON FUNCTION public.get_product_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_categories() TO authenticated;


-- =============================================================================
-- SECTION: FIX C — Authentication Hardening
-- =============================================================================

-- C1. login_audit table
CREATE TABLE IF NOT EXISTS public.login_audit (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  event       text        NOT NULL CHECK (event IN ('login', 'logout', 'failed', 'password_reset')),
  ip_text     text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_audit_user_created
  ON public.login_audit (user_id, created_at DESC);

ALTER TABLE public.login_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "login_audit_select_own" ON public.login_audit;
CREATE POLICY "login_audit_select_own" ON public.login_audit
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "login_audit_select_admin" ON public.login_audit;
CREATE POLICY "login_audit_select_admin" ON public.login_audit
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- C2. log_login_event: record a login/logout/failed event
CREATE OR REPLACE FUNCTION public.log_login_event(
  p_user_id    uuid,
  p_event      text,
  p_ip         text      DEFAULT NULL,
  p_user_agent text      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_event NOT IN ('login', 'logout', 'failed', 'password_reset') THEN
    RAISE EXCEPTION 'invalid_event' USING HINT = 'Event must be login, logout, failed, or password_reset';
  END IF;

  INSERT INTO public.login_audit (user_id, event, ip_text, user_agent)
  VALUES (p_user_id, p_event, p_ip, p_user_agent)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_login_event(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_login_event(uuid, text, text, text) TO authenticated;


-- =============================================================================
-- SECTION: FIX D — Batch Operations
-- =============================================================================

-- D1. batch_update_order_status: transition multiple orders to a new status
CREATE OR REPLACE FUNCTION public.batch_update_order_status(
  p_order_ids  uuid[],
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_updated    uuid[] := '{}';
  v_failed     jsonb  := '[]'::jsonb;
  v_order_id   uuid;
  v_cur_status text;
  v_valid      boolean;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can batch-update order status';
  END IF;

  FOREACH v_order_id IN ARRAY p_order_ids
  LOOP
    SELECT status INTO v_cur_status FROM public.orders WHERE id = v_order_id;

    IF v_cur_status IS NULL THEN
      v_failed := v_failed || jsonb_build_object('id', v_order_id, 'reason', 'Order not found');
      CONTINUE;
    END IF;

    -- Validate transition against the status matrix
    v_valid := false;
    IF p_new_status = 'cancelled' THEN
      IF v_cur_status NOT IN ('delivered', 'cancelled') THEN
        v_valid := true;
      END IF;
    ELSIF p_new_status = 'approved' AND v_cur_status = 'pending' THEN
      v_valid := true;
    ELSIF p_new_status = 'packed' AND v_cur_status = 'approved' THEN
      v_valid := true;
    ELSIF p_new_status = 'dispatched' AND v_cur_status = 'packed' THEN
      v_valid := true;
    ELSIF p_new_status = 'delivered' AND v_cur_status = 'dispatched' THEN
      v_valid := true;
    END IF;

    IF NOT v_valid THEN
      v_failed := v_failed || jsonb_build_object(
        'id', v_order_id,
        'reason', format('Cannot transition from %s to %s', v_cur_status, p_new_status)
      );
      CONTINUE;
    END IF;

    -- Update individual row (fires existing status trigger for audit trail)
    UPDATE public.orders SET status = p_new_status WHERE id = v_order_id;
    v_updated := array_append(v_updated, v_order_id);
  END LOOP;

  RETURN jsonb_build_object('updated', to_jsonb(v_updated), 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.batch_update_order_status(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_update_order_status(uuid[], text) TO authenticated;


-- D2. batch_adjust_stock: adjust stock for multiple products in one call
CREATE OR REPLACE FUNCTION public.batch_adjust_stock(p_adjustments jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_updated    uuid[] := '{}';
  v_failed     jsonb  := '[]'::jsonb;
  v_item       jsonb;
  v_product_id uuid;
  v_delta      int;
  v_reason     text;
  v_new_stock  int;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only admins can batch-adjust stock';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    BEGIN
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_delta      := (v_item ->> 'delta')::int;
      v_reason     := v_item ->> 'reason';

      v_new_stock := public.adjust_stock(v_product_id, v_delta, v_reason);
      v_updated := array_append(v_updated, v_product_id);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_object(
        'id', v_product_id,
        'reason', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object('updated', to_jsonb(v_updated), 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.batch_adjust_stock(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_adjust_stock(jsonb) TO authenticated;


-- =============================================================================
-- SECTION: FIX F — Localisation
-- =============================================================================

-- F1. Add preferred_language column to profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'preferred_language'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN preferred_language text DEFAULT 'en';
  END IF;
END $$;


COMMIT;
