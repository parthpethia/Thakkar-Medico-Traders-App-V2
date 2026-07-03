-- =============================================================================
-- Thakkar Medico — Cohort Recommendations foundation (v37)
-- Tier 3 recommendation engine using collaborative filtering via scheduled job
-- =============================================================================

BEGIN;

-- 1. Add column to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS retailer_type text 
  CONSTRAINT check_profiles_retailer_type 
  CHECK (retailer_type IN ('pharmacy', 'hospital', 'clinic', 'wholesaler', 'other'))
  DEFAULT NULL;

-- 2. Create cohort_recommendations table
CREATE TABLE IF NOT EXISTS public.cohort_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  cohort_score numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_id)
);

-- 3. Create index for performance
CREATE INDEX IF NOT EXISTS idx_cohort_recs_user 
  ON public.cohort_recommendations(user_id, cohort_score DESC);

-- 4. Enable RLS on cohort_recommendations
ALTER TABLE public.cohort_recommendations ENABLE ROW LEVEL SECURITY;

-- 5. RLS policies on cohort_recommendations
DROP POLICY IF EXISTS "cohort_recs_select" ON public.cohort_recommendations;
CREATE POLICY "cohort_recs_select" ON public.cohort_recommendations
  FOR SELECT TO authenticated
  USING (
    user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- 6. Cohort computation function
CREATE OR REPLACE FUNCTION public.refresh_cohort_recommendations()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Truncate existing recommendations
  DELETE FROM public.cohort_recommendations;

  -- Compute and insert new recommendations
  INSERT INTO public.cohort_recommendations (user_id, product_id, cohort_score)
  WITH retailer_cohorts AS (
    SELECT id AS user_id, area, retailer_type
    FROM public.profiles
    WHERE role = 'retailer' AND area IS NOT NULL
  ),
  retailer_orders AS (
    SELECT o.user_id, oi.product_id, SUM(oi.qty) AS qty
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
    GROUP BY o.user_id, oi.product_id
  ),
  cohort_product_stats AS (
    SELECT
      rc1.user_id AS target_user,
      ro2.product_id,
      COUNT(DISTINCT ro2.user_id) AS buyer_count,
      SUM(ro2.qty) AS total_qty
    FROM retailer_cohorts rc1
    JOIN retailer_cohorts rc2
      ON rc2.area = rc1.area
      AND (rc2.retailer_type = rc1.retailer_type OR rc1.retailer_type IS NULL)
      AND rc2.user_id != rc1.user_id
    JOIN retailer_orders ro2 ON ro2.user_id = rc2.user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM retailer_orders ro1
      WHERE ro1.user_id = rc1.user_id AND ro1.product_id = ro2.product_id
    )
    GROUP BY rc1.user_id, ro2.product_id
    HAVING COUNT(DISTINCT ro2.user_id) >= 2
  ),
  ranked AS (
    SELECT
      target_user AS user_id,
      product_id,
      buyer_count * LN(total_qty + 1) AS cohort_score,
      ROW_NUMBER() OVER (
        PARTITION BY target_user ORDER BY buyer_count * LN(total_qty + 1) DESC
      ) AS rn
    FROM cohort_product_stats
  )
  SELECT user_id, product_id, cohort_score
  FROM ranked
  WHERE rn <= 12;
END;
$$;

-- 7. Admin trigger RPC for testing/on-demand run
CREATE OR REPLACE FUNCTION public.trigger_refresh_cohort_recommendations()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  PERFORM public.refresh_cohort_recommendations();
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_refresh_cohort_recommendations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_refresh_cohort_recommendations() FROM anon;
GRANT EXECUTE ON FUNCTION public.trigger_refresh_cohort_recommendations() TO authenticated;

-- 8. Read RPC for client consumption
CREATE OR REPLACE FUNCTION public.get_cohort_recommendations(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  product_id      uuid,
  name            text,
  image           text,
  selling_price   numeric,
  stock_quantity  integer,
  cohort_score    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_user_id IS NULL THEN
    p_user_id := auth.uid();
  END IF;

  IF auth.uid() = p_user_id
     OR EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.role = 'admin'
     ) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
  SELECT
    cr.product_id, p.name, p.image, p.selling_price,
    p.stock_quantity, cr.cohort_score
  FROM public.cohort_recommendations cr
  JOIN public.products p ON p.id = cr.product_id
  WHERE cr.user_id = p_user_id
    AND p.is_active = true
    AND p.stock_quantity > 0
  ORDER BY cr.cohort_score DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_cohort_recommendations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_cohort_recommendations(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_cohort_recommendations(uuid) TO authenticated;

-- 9. Setup weekly scheduled cron job (runs every Monday at 3 AM)
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'refresh-cohort-recommendations',
  '0 3 * * 1',
  'SELECT public.refresh_cohort_recommendations();'
);

COMMIT;
