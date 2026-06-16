-- ============================================================================
-- Migration v17: SECURITY DEFINER RPC exposure (Security Advisor)
-- ============================================================================
-- 1) Revoke EXECUTE from PUBLIC + anon on all public functions (fixes
--    "Public Can Execute SECURITY DEFINER Function").
-- 2) Revoke EXECUTE from authenticated on trigger/internal functions only.
-- 3) Switch admin/reporting RPCs to SECURITY INVOKER (they already check
--    role inside; RLS applies as the signed-in user). Fixes warnings like
--    get_daily_revenue for signed-in users.
--    Exceptions (SECURITY DEFINER — see v21/v23): get_top_products (order_items),
--    get_order_timeline (order_status_events); authenticated has no table SELECT.
-- 4) Re-grant EXECUTE TO authenticated on app RPCs; anon only on phone login.
-- Run after v16. Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Lock down default grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.proc);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.proc);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Trigger / internal — not callable via PostgREST
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'handle_new_user',
        'enforce_order_status_transition',
        'rls_auto_enable',
        'set_updated_at',
        '_drop_all_policies'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.proc);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Prefer SECURITY INVOKER (admin/staff checks remain in function body)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_daily_revenue',
        'get_sales_summary',
        'get_top_retailers',
        'get_status_breakdown',
        'get_low_stock_products',
        'get_delivery_summary',
        'get_product_categories',
        'get_product_by_sku',
        'get_retailer_stats',
        'adjust_credit_limit',
        'reset_credit_used',
        'update_settings',
        'adjust_stock',
        'batch_adjust_stock',
        'batch_update_order_status',
        'upsert_product',
        'deactivate_product',
        'search_products',
        'get_orders_page',
        'current_user_is_admin',
        'current_user_is_staff',
        'current_auth_user_id'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', r.proc);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Re-grant EXECUTE to authenticated (app RPC allowlist)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_email_by_phone',
        'log_login_event',
        'log_password_reset_event',
        'place_order',
        'search_products',
        'get_orders_page',
        'get_order_timeline',
        'get_retailer_stats',
        'redeem_loyalty_points',
        'restore_credit',
        'get_daily_revenue',
        'get_sales_summary',
        'get_top_retailers',
        'get_status_breakdown',
        'get_low_stock_products',
        'get_delivery_summary',
        'get_product_categories',
        'get_product_by_sku',
        'adjust_credit_limit',
        'reset_credit_used',
        'update_settings',
        'adjust_stock',
        'batch_adjust_stock',
        'batch_update_order_status',
        'upsert_product',
        'deactivate_product',
        'current_user_is_admin',
        'current_user_is_staff',
        'current_auth_user_id'
      )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.proc);
  END LOOP;
END $$;

-- Phone login before session exists
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_email_by_phone'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', r.proc);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Extra dashboard-only functions (if present)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('set_credit_limit', 'set_user_credit_limit')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', r.proc);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.proc);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.proc);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.proc);
  END LOOP;
END $$;
