-- Fix PL/pgSQL ambiguity: RETURNS TABLE (id ...) shadows unqualified "id" in profiles lookup.

CREATE OR REPLACE FUNCTION public.get_low_stock_products(
  p_threshold int DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  name            text,
  company         text,
  stock_quantity  int,
  threshold       int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold int;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can access low stock products';
  END IF;

  IF p_threshold IS NOT NULL THEN
    v_threshold := p_threshold;
  ELSE
    SELECT COALESCE(s.low_stock_threshold, 10) INTO v_threshold
    FROM public.settings s
    LIMIT 1;
  END IF;

  RETURN QUERY
    SELECT
      p.id,
      p.name,
      p.company,
      p.stock_quantity,
      v_threshold AS threshold
    FROM public.products p
    WHERE p.stock_quantity <= v_threshold
      AND p.is_active = true
    ORDER BY p.stock_quantity ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_low_stock_products(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_low_stock_products(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_low_stock_products(int) TO authenticated;
