-- Normalize phone lookup for login (E.164, 10-digit, 91-prefix)
-- Run after v25. Idempotent.

CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_digits text;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    v_digits := substring(v_digits from 3);
  ELSIF length(v_digits) = 11 AND v_digits LIKE '0%' THEN
    v_digits := substring(v_digits from 2);
  END IF;

  SELECT email INTO v_email
  FROM public.profiles
  WHERE phone = p_phone
     OR phone = v_digits
     OR phone = '+91' || v_digits
     OR phone = '91' || v_digits
     OR regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = v_digits
  LIMIT 1;

  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO authenticated;
