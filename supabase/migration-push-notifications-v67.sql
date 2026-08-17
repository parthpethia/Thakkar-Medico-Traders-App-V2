-- =============================================================================
-- Migration v67: Push Notifications System
-- Tables: push_tokens, notification_log
-- Edge Function: send-push-notification
-- =============================================================================

-- 1. Push Tokens Table
CREATE TABLE IF NOT EXISTS public.push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL,
  device_platform TEXT,             -- 'ios' | 'android' | 'web'
  app_role TEXT NOT NULL,           -- 'rider' | 'admin' | 'retailer'
  is_active BOOLEAN DEFAULT true,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, expo_push_token)
);

-- Indexing for fast token lookups
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON public.push_tokens(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_push_tokens_app_role ON public.push_tokens(app_role) WHERE is_active = true;

-- 2. Notification Log Table
CREATE TABLE IF NOT EXISTS public.notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_role TEXT,              -- 'rider' | 'admin' | 'retailer'
  event_type TEXT NOT NULL,         -- 'order_assigned' | 'order_dispatched' | 'rider_arriving_soon' | 'signal_lost' | 'delivery_completed' | 'delivery_failed' | 'order_late_sla'
  title TEXT,
  body TEXT,
  status TEXT DEFAULT 'sent',       -- 'sent' | 'failed' | 'skipped'
  expo_receipt_id TEXT,             -- for Expo delivery receipt checking
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- Indexing for notification log queries
CREATE INDEX IF NOT EXISTS idx_notification_log_order_id ON public.notification_log(order_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_recipient_user ON public.notification_log(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON public.notification_log(sent_at DESC);

-- =============================================================================
-- Row Level Security (RLS)
-- =============================================================================

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

-- push_tokens policies
DROP POLICY IF EXISTS "Users can manage their own push tokens" ON public.push_tokens;
CREATE POLICY "Users can manage their own push tokens"
  ON public.push_tokens
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all push tokens" ON public.push_tokens;
CREATE POLICY "Admins can view all push tokens"
  ON public.push_tokens
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- notification_log policies
DROP POLICY IF EXISTS "Users can view their own notification logs" ON public.notification_log;
CREATE POLICY "Users can view their own notification logs"
  ON public.notification_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = recipient_user_id);

DROP POLICY IF EXISTS "Admins can view all notification logs" ON public.notification_log;
CREATE POLICY "Admins can view all notification logs"
  ON public.notification_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Authenticated users can insert notification logs" ON public.notification_log;
CREATE POLICY "Authenticated users can insert notification logs"
  ON public.notification_log
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
