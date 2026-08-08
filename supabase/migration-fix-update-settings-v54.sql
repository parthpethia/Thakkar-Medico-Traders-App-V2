-- =============================================================================
-- Thakkar Medico — V54: Fix update_settings dynamic SQL type mismatch error
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_settings(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_settings_id uuid;
  v_result      jsonb;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only admins can update settings';
  END IF;

  IF p_key NOT IN (
    'gst_enabled', 'gst_percent',
    'credit_enabled', 'loyalty_enabled',
    'delivery_enabled', 'pickup_enabled',
    'pickup_address', 'pickup_hours',
    'payment_modes_enabled',
    'loyalty_redemption_rate', 'max_redemption_percent',
    'support_phone',
    'show_prices_to_unverified'
  ) THEN
    RAISE EXCEPTION 'invalid_setting_key'
      USING HINT = format('Key "%s" is not an allowed setting', p_key);
  END IF;

  SELECT id INTO v_settings_id FROM settings LIMIT 1;

  IF p_key IN ('gst_enabled', 'credit_enabled', 'loyalty_enabled',
                'delivery_enabled', 'pickup_enabled', 'show_prices_to_unverified') THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = ($1 #>> ''{}'')::boolean, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSIF p_key IN ('gst_percent', 'loyalty_redemption_rate', 'max_redemption_percent') THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = ($1 #>> ''{}'')::numeric, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSIF p_key = 'payment_modes_enabled' THEN
    EXECUTE format(
      'UPDATE public.settings SET %I = $1, updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  ELSE
    EXECUTE format(
      'UPDATE public.settings SET %I = $1 #>> ''{}'', updated_at = now() WHERE id = $2',
      p_key
    ) USING p_value, v_settings_id;
  END IF;

  SELECT row_to_json(s) INTO v_result FROM settings s WHERE s.id = v_settings_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.update_settings(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_settings(text, jsonb) TO authenticated;

COMMIT;
