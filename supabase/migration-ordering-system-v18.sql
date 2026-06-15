-- ============================================================================
-- Migration v18: Remaining Security Advisor items (partial cleanup)
-- ============================================================================
-- GraphQL table warnings: Expo uses REST only. @graphql ignore + disabling
-- GraphQL in Dashboard is the only way to clear those without breaking .from().
--   Dashboard → Project Settings → API → GraphQL → OFF
--
-- SECURITY DEFINER RPC warnings that MUST stay (transaction / pre-auth):
--   get_email_by_phone (anon), place_order, redeem_loyalty_points,
--   restore_credit, log_password_reset_event (reads auth.users)
--
-- This migration:
--   • Re-applies @graphql ignore on public relations
--   • log_login_event → SECURITY INVOKER + RLS insert policy
--   • Re-revokes EXECUTE from PUBLIC/anon on sensitive DEFINER RPCs
-- Run after v17.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. GraphQL ignore comments (re-apply; advisor may still warn until GraphQL OFF)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  kind text;
BEGIN
  FOR r IN
    SELECT c.relname AS name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm')
      AND c.relname NOT LIKE 'pg_%'
  LOOP
    kind := CASE r.relkind
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'COMMENT ON %s public.%I IS %L',
      kind,
      r.name,
      '@graphql({"ignore": true})'
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. log_login_event: INVOKER + insert policy (clears DEFINER warning)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "login_audit_insert_own" ON public.login_audit;
CREATE POLICY "login_audit_insert_own" ON public.login_audit
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select public.current_auth_user_id()));

CREATE OR REPLACE FUNCTION public.log_login_event(
  p_user_id    uuid,
  p_event      text,
  p_ip         text      DEFAULT NULL,
  p_user_agent text      DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id <> (select auth.uid()) THEN
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
REVOKE ALL ON FUNCTION public.log_login_event(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.log_login_event(uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Lock EXECUTE on DEFINER RPCs that must remain (no PUBLIC / anon except phone)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS proc, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'place_order',
        'redeem_loyalty_points',
        'restore_credit',
        'log_password_reset_event',
        'get_email_by_phone'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.proc);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.proc);
    IF r.proname <> 'get_email_by_phone' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.proc);
    END IF;
  END LOOP;
END $$;

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
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.proc);
  END LOOP;
END $$;
