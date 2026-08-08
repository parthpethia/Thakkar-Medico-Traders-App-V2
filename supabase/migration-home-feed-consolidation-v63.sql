-- =============================================================================
-- Thakkar Medico — V63: Home Feed Query Consolidation & Load Reduction
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_home_dashboard_data(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_categories jsonb;
  v_featured jsonb;
  v_restock jsonb;
  v_brand_discovery jsonb;
  v_company_summary jsonb;
  v_cohort jsonb;
  v_popular jsonb;
BEGIN
  -- 1. Gather active categories
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_categories FROM (
    SELECT id, name
    FROM public.categories
    WHERE is_active = true
    ORDER BY name
  ) t;

  -- 2. Gather featured products (new arrivals)
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_featured FROM (
    SELECT id, name, company, category, sku, pack_size, image, mrp, selling_price, gst_percent, stock_quantity, is_active, created_at
    FROM public.products
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT 10
  ) t;

  -- 3. Gather popular products
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_popular FROM (
    SELECT product_id, name, company, category, pack_size, image, mrp, selling_price, gst_percent, stock_quantity, is_active, created_at, order_count, total_qty
    FROM public.get_popular_products(10)
  ) t;

  -- Recommendations are only relevant if user is logged in
  IF p_user_id IS NOT NULL THEN
    -- 4. Gather restock recommendations
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_restock FROM (
      SELECT product_id, name, company, image, selling_price, stock_quantity, avg_interval_days, last_ordered_at, days_since_last_order, restock_urgency
      FROM public.get_restock_recommendations(p_user_id)
    ) t;

    -- 5. Gather brand discovery recommendations
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_brand_discovery FROM (
      SELECT product_id, name, image, selling_price, stock_quantity, created_at, company_id, company_name, is_new_arrival
      FROM public.get_brand_discovery_recommendations(p_user_id)
    ) t;

    -- 6. Gather company purchase summary
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_company_summary FROM (
      SELECT company_name, order_count
      FROM public.get_company_purchase_summary(p_user_id)
    ) t;

    -- 7. Gather cohort recommendations
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_cohort FROM (
      SELECT product_id, name, image, selling_price, stock_quantity, cohort_score
      FROM public.get_cohort_recommendations(p_user_id)
    ) t;
  ELSE
    v_restock := '[]'::jsonb;
    v_brand_discovery := '[]'::jsonb;
    v_company_summary := '[]'::jsonb;
    v_cohort := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'categories', v_categories,
    'featured', v_featured,
    'popular', v_popular,
    'restock', v_restock,
    'brand_discovery', v_brand_discovery,
    'company_summary', v_company_summary,
    'cohort', v_cohort
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_home_dashboard_data(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_home_dashboard_data(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_home_dashboard_data(uuid) TO authenticated;

COMMIT;
