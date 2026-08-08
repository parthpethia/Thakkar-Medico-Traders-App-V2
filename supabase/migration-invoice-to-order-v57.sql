-- =============================================================================
-- Thakkar Medico — V57: Intelligent Invoice-to-Order Integration Schema
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Create storage bucket for invoice uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-uploads',
  'invoice-uploads',
  true,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 2. Create invoice_uploads table
CREATE TABLE IF NOT EXISTS public.invoice_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  upload_time timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL DEFAULT 'uploaded' CHECK (processing_status IN ('uploaded', 'extracted', 'validated', 'completed', 'failed')),
  linked_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Create invoice_extractions table
CREATE TABLE IF NOT EXISTS public.invoice_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_upload_id uuid NOT NULL REFERENCES public.invoice_uploads(id) ON DELETE CASCADE,
  extraction_provider text NOT NULL,
  raw_json jsonb NOT NULL,
  parsed_json jsonb NOT NULL,
  edited_json jsonb,
  confidence_score numeric CHECK (confidence_score >= 0 AND confidence_score <= 1),
  validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'success', 'warning', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Create invoice_validation_logs table
CREATE TABLE IF NOT EXISTS public.invoice_validation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES public.invoice_extractions(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  extracted_value text,
  matched_value text,
  validation_result text NOT NULL CHECK (validation_result IN ('match', 'warning', 'error')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Indexes for fast retrieval
CREATE INDEX IF NOT EXISTS idx_invoice_uploads_status ON public.invoice_uploads (processing_status);
CREATE INDEX IF NOT EXISTS idx_invoice_uploads_linked_order ON public.invoice_uploads (linked_order_id);
CREATE INDEX IF NOT EXISTS idx_invoice_extractions_upload_id ON public.invoice_extractions (invoice_upload_id);
CREATE INDEX IF NOT EXISTS idx_invoice_validation_logs_extraction_id ON public.invoice_validation_logs (extraction_id);

-- GIN indexes for JSON query capability (useful for duplicate detection and audit lookup)
CREATE INDEX IF NOT EXISTS idx_invoice_extractions_parsed_json_gin ON public.invoice_extractions USING gin (parsed_json);
CREATE INDEX IF NOT EXISTS idx_invoice_extractions_edited_json_gin ON public.invoice_extractions USING gin (edited_json);

-- 6. Row Level Security (RLS)
ALTER TABLE public.invoice_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_validation_logs ENABLE ROW LEVEL SECURITY;

-- Select policies: readable by admin role
DROP POLICY IF EXISTS "invoice_uploads_select_admin" ON public.invoice_uploads;
CREATE POLICY "invoice_uploads_select_admin" ON public.invoice_uploads
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "invoice_extractions_select_admin" ON public.invoice_extractions;
CREATE POLICY "invoice_extractions_select_admin" ON public.invoice_extractions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "invoice_validation_logs_select_admin" ON public.invoice_validation_logs;
CREATE POLICY "invoice_validation_logs_select_admin" ON public.invoice_validation_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- All actions policy: only admin can modify/insert
DROP POLICY IF EXISTS "invoice_uploads_all_admin" ON public.invoice_uploads;
CREATE POLICY "invoice_uploads_all_admin" ON public.invoice_uploads
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "invoice_extractions_all_admin" ON public.invoice_extractions;
CREATE POLICY "invoice_extractions_all_admin" ON public.invoice_extractions
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "invoice_validation_logs_all_admin" ON public.invoice_validation_logs;
CREATE POLICY "invoice_validation_logs_all_admin" ON public.invoice_validation_logs
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMIT;
