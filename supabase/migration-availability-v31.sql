-- =============================================================================
-- Thakkar Medico — V31: Delivery on-duty availability + active order counts
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-razorpay-v30.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Availability columns on profiles
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_on_duty boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_order_count int NOT NULL DEFAULT 0;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_current_order_count_nonneg;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_current_order_count_nonneg
  CHECK (current_order_count >= 0);

-- Backfill counts from active assignments
UPDATE public.profiles p
   SET current_order_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT o.assigned_to AS id, COUNT(*)::int AS cnt
      FROM public.orders o
     WHERE o.assigned_to IS NOT NULL
       AND o.status NOT IN ('delivered', 'cancelled')
     GROUP BY o.assigned_to
  ) sub
 WHERE p.id = sub.id;

UPDATE public.profiles
   SET current_order_count = 0
 WHERE role = 'delivery'
   AND id NOT IN (
     SELECT DISTINCT assigned_to
       FROM public.orders
      WHERE assigned_to IS NOT NULL
        AND status NOT IN ('delivered', 'cancelled')
   );

-- ---------------------------------------------------------------------------
-- 2. Profiles UPDATE rules — block manual count; delivery may toggle is_on_duty
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_delivery_order_count(
  p_profile_id uuid,
  p_delta int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_profile_id IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;

  PERFORM set_config('app.adjusting_delivery_count', '1', true);

  UPDATE public.profiles
     SET current_order_count = GREATEST(0, current_order_count + p_delta)
   WHERE id = p_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_delivery_order_count(uuid, int) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_profiles_update_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.adjusting_delivery_count', true) = '1' THEN
    RETURN NEW;
  END IF;

  IF (SELECT public.current_user_is_admin()) THEN
    RETURN NEW;
  END IF;

  IF NEW.current_order_count IS DISTINCT FROM OLD.current_order_count THEN
    RAISE EXCEPTION 'profile_count_update_denied'
      USING HINT = 'Active order count is managed automatically';
  END IF;

  IF NEW.is_on_duty IS DISTINCT FROM OLD.is_on_duty THEN
    IF NOT (
      (SELECT public.current_user_is_delivery())
      AND NEW.id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'profile_duty_update_denied'
        USING HINT = 'Only delivery staff can change their own on-duty status';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_profiles_update_rules ON public.profiles;
CREATE TRIGGER trg_enforce_profiles_update_rules
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profiles_update_rules();

-- ---------------------------------------------------------------------------
-- 3. Order assignment → current_order_count (separate from status transition trigger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_delivery_order_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal constant text[] := ARRAY['delivered', 'cancelled'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NOT NULL
       AND NOT (NEW.status = ANY (v_terminal)) THEN
      PERFORM public.adjust_delivery_order_count(NEW.assigned_to, 1);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    IF OLD.assigned_to IS NOT NULL
       AND NOT (OLD.status = ANY (v_terminal)) THEN
      PERFORM public.adjust_delivery_order_count(OLD.assigned_to, -1);
    END IF;

    IF NEW.assigned_to IS NOT NULL
       AND NOT (NEW.status = ANY (v_terminal)) THEN
      PERFORM public.adjust_delivery_order_count(NEW.assigned_to, 1);
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status = ANY (v_terminal)
        AND NOT (OLD.status = ANY (v_terminal)) THEN
    IF NEW.assigned_to IS NOT NULL THEN
      PERFORM public.adjust_delivery_order_count(NEW.assigned_to, -1);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_delivery_order_count ON public.orders;
CREATE TRIGGER trg_update_delivery_order_count
  AFTER INSERT OR UPDATE OF status, assigned_to ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_delivery_order_count();

COMMIT;
