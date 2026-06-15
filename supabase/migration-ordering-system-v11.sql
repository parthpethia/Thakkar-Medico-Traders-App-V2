-- ============================================================================
-- Migration v11: RLS auth initplan performance (Supabase Security Advisor)
-- ============================================================================
-- Wrap auth.uid() as (select auth.uid()) so the value is computed once per
-- query, not per row. Same semantics; fixes "Auth RLS Initialization Plan".
-- Idempotent — safe to re-run.
-- ============================================================================

-- profiles
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_select_staff" ON public.profiles;
CREATE POLICY "profiles_select_staff" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_update_admin" ON public.profiles;
CREATE POLICY "profiles_update_admin" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- products
DROP POLICY IF EXISTS "products_write_admin" ON public.products;
CREATE POLICY "products_write_admin" ON public.products
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- cart_items
DROP POLICY IF EXISTS "cart_own" ON public.cart_items;
CREATE POLICY "cart_own" ON public.cart_items
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- orders
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
CREATE POLICY "orders_select_own" ON public.orders
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "orders_select_staff" ON public.orders;
CREATE POLICY "orders_select_staff" ON public.orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND (created_by IS NULL OR created_by = (select auth.uid()))
  );

DROP POLICY IF EXISTS "orders_update_staff" ON public.orders;
CREATE POLICY "orders_update_staff" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "orders_insert_staff" ON public.orders;
CREATE POLICY "orders_insert_staff" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
    AND EXISTS (
      SELECT 1 FROM public.profiles r
      WHERE r.id = user_id AND r.role = 'retailer'
    )
  );

DROP POLICY IF EXISTS "orders_update_own_cancel" ON public.orders;
CREATE POLICY "orders_update_own_cancel" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (select auth.uid()) = user_id
    AND status IN ('pending', 'approved')
  )
  WITH CHECK (
    (select auth.uid()) = user_id
    AND status IN ('pending', 'approved')
  );

-- settings
DROP POLICY IF EXISTS "settings_write_admin" ON public.settings;
CREATE POLICY "settings_write_admin" ON public.settings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- password_reset_events
DROP POLICY IF EXISTS "password_reset_events_insert_own" ON public.password_reset_events;
CREATE POLICY "password_reset_events_insert_own" ON public.password_reset_events
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "password_reset_events_select_own" ON public.password_reset_events;
CREATE POLICY "password_reset_events_select_own" ON public.password_reset_events
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "password_reset_events_select_admin" ON public.password_reset_events;
CREATE POLICY "password_reset_events_select_admin" ON public.password_reset_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- order_items
DROP POLICY IF EXISTS "order_items_select_own" ON public.order_items;
CREATE POLICY "order_items_select_own" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id AND o.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "order_items_select_staff" ON public.order_items;
CREATE POLICY "order_items_select_staff" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

-- order_status_events
DROP POLICY IF EXISTS "order_status_events_select_own" ON public.order_status_events;
CREATE POLICY "order_status_events_select_own" ON public.order_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_events.order_id AND o.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "order_status_events_select_staff" ON public.order_status_events;
CREATE POLICY "order_status_events_select_staff" ON public.order_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

-- loyalty_transactions
DROP POLICY IF EXISTS "loyalty_transactions_select_own" ON public.loyalty_transactions;
CREATE POLICY "loyalty_transactions_select_own" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (retailer_id = (select auth.uid()));

DROP POLICY IF EXISTS "loyalty_transactions_select_admin" ON public.loyalty_transactions;
CREATE POLICY "loyalty_transactions_select_admin" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- notifications_log
DROP POLICY IF EXISTS "notifications_log_select_admin" ON public.notifications_log;
CREATE POLICY "notifications_log_select_admin" ON public.notifications_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- credit_adjustments
DROP POLICY IF EXISTS "credit_adjustments_select_admin" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_select_admin" ON public.credit_adjustments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "credit_adjustments_select_own" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_select_own" ON public.credit_adjustments
  FOR SELECT TO authenticated
  USING (retailer_id = (select auth.uid()));

DROP POLICY IF EXISTS "credit_adjustments_insert_admin" ON public.credit_adjustments;
CREATE POLICY "credit_adjustments_insert_admin" ON public.credit_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- stock_adjustments
DROP POLICY IF EXISTS "stock_adjustments_select_staff" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_select_staff" ON public.stock_adjustments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "stock_adjustments_insert_admin" ON public.stock_adjustments;
CREATE POLICY "stock_adjustments_insert_admin" ON public.stock_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- login_audit
DROP POLICY IF EXISTS "login_audit_select_own" ON public.login_audit;
CREATE POLICY "login_audit_select_own" ON public.login_audit
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "login_audit_select_admin" ON public.login_audit;
CREATE POLICY "login_audit_select_admin" ON public.login_audit
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );
