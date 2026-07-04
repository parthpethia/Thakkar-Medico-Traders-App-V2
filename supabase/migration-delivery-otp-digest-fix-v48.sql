-- =============================================================================
-- Thakkar Medico — V48: Fix digest(text, unknown) does not exist error by
-- adding 'extensions' schema to functions search_path
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. generate_delivery_otp (Update search_path to search in extensions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_delivery_otp(p_order_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_status text;
  v_assigned_to uuid;
  v_code int;
  v_hash text;
  v_expires timestamptz;
BEGIN
  SELECT status, assigned_to
    INTO v_status, v_assigned_to
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.delivery_proofs dp
     WHERE dp.order_id = p_order_id
       AND dp.otp_expires_at > now() - interval '2 minutes'
  ) THEN
    RAISE EXCEPTION 'otp_too_soon';
  END IF;

  v_code := floor(random() * 9000 + 1000)::int;
  v_hash := encode(digest(v_code::text, 'sha256'), 'hex');
  v_expires := now() + interval '30 minutes';

  INSERT INTO public.delivery_proofs (
    order_id,
    otp_code_hash,
    otp_expires_at,
    otp_verified_at,
    otp_attempts,
    updated_at
  )
  VALUES (
    p_order_id,
    v_hash,
    v_expires,
    NULL,
    0,
    now()
  )
  ON CONFLICT (order_id) DO UPDATE SET
    otp_code_hash = EXCLUDED.otp_code_hash,
    otp_expires_at = EXCLUDED.otp_expires_at,
    otp_verified_at = NULL,
    otp_attempts = 0,
    updated_at = now();

  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_delivery_otp(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_delivery_otp(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. verify_delivery_otp (Update search_path to search in extensions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_delivery_otp(p_order_id uuid, p_otp text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_status text;
  v_assigned_to uuid;
  v_proof public.delivery_proofs%ROWTYPE;
  v_hash text;
BEGIN
  SELECT status, assigned_to
    INTO v_status, v_assigned_to
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  SELECT *
    INTO v_proof
    FROM public.delivery_proofs
   WHERE order_id = p_order_id;

  IF v_proof.id IS NULL THEN
    RAISE EXCEPTION 'otp_invalid';
  END IF;

  IF v_proof.otp_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'otp_already_verified';
  END IF;

  IF v_proof.otp_attempts >= 5 THEN
    RAISE EXCEPTION 'otp_max_attempts';
  END IF;

  IF now() >= v_proof.otp_expires_at THEN
    RAISE EXCEPTION 'otp_expired';
  END IF;

  v_hash := encode(digest(trim(p_otp), 'sha256'), 'hex');

  IF v_hash IS DISTINCT FROM v_proof.otp_code_hash THEN
    UPDATE public.delivery_proofs
       SET otp_attempts = otp_attempts + 1,
           updated_at = now()
     WHERE order_id = p_order_id;
    RAISE EXCEPTION 'otp_invalid';
  END IF;

  UPDATE public.delivery_proofs
     SET otp_verified_at = now(),
         updated_at = now()
   WHERE order_id = p_order_id;

  UPDATE public.orders
     SET status = 'delivered'
   WHERE id = p_order_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_delivery_otp(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_delivery_otp(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. storage.buckets & policies for delivery-photos
-- ---------------------------------------------------------------------------

-- Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-photos', 'delivery-photos', false)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Allow delivery drivers to insert delivery photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow admin to select delivery photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow assigned delivery drivers to select delivery photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow order owners to select delivery photos" ON storage.objects;

-- Create policies
CREATE POLICY "Allow delivery drivers to insert delivery photos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'delivery-photos'
  AND (SELECT public.current_user_is_delivery())
  AND EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id::text = path_tokens[1]
      AND o.assigned_to = auth.uid()
  )
);

CREATE POLICY "Allow admin to select delivery photos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'delivery-photos'
  AND (SELECT public.current_user_is_admin())
);

CREATE POLICY "Allow assigned delivery drivers to select delivery photos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'delivery-photos'
  AND (SELECT public.current_user_is_delivery())
  AND EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id::text = path_tokens[1]
      AND o.assigned_to = auth.uid()
  )
);

CREATE POLICY "Allow order owners to select delivery photos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'delivery-photos'
  AND EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id::text = path_tokens[1]
      AND o.user_id = auth.uid()
  )
);

COMMIT;
