-- PA migration: staging readiness fixes (idempotent — safe to re-run on staging)

-- 1. log_login_event: caller must match authenticated user
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
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

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

-- 2. enforce_order_status_transition: ensure pending_payment → cancelled is allowed
CREATE OR REPLACE FUNCTION public.enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid       boolean := false;
  v_points      int;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled')    THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled')    THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled')      THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled')  THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')   THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % → %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);
  END IF;

  IF NEW.status = 'delivered' THEN
    v_points := FLOOR(NEW.grand_total / 100);
    IF v_points > 0 THEN
      INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason)
      VALUES (NEW.user_id, NEW.id, v_points, 'order_delivered');

      UPDATE profiles
         SET loyalty_points = loyalty_points + v_points
       WHERE id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Composite index for admin/retailer order list queries (no table lock)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_created
  ON public.orders (status, created_at DESC, id DESC);
