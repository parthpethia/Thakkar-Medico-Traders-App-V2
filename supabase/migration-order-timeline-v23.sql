-- get_order_timeline reads order_status_events (no direct SELECT for authenticated).

CREATE OR REPLACE FUNCTION public.get_order_timeline(p_order_id uuid)
RETURNS TABLE (
  from_status  text,
  to_status    text,
  actor_name   text,
  created_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    (SELECT public.current_user_is_staff())
    OR EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = p_order_id
        AND o.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Not allowed to view this order timeline';
  END IF;

  RETURN QUERY
    SELECT
      e.from_status,
      e.to_status,
      COALESCE(pr.name, pr.business_name, 'System') AS actor_name,
      e.created_at
    FROM public.order_status_events e
    LEFT JOIN public.profiles pr ON pr.id = e.actor_id
    WHERE e.order_id = p_order_id
    ORDER BY e.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_order_timeline(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_timeline(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_order_timeline(uuid) TO authenticated;
