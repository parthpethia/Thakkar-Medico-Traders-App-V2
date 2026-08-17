import { supabase } from './supabase';

export type NotificationEventType =
  | 'order_assigned'
  | 'order_dispatched'
  | 'rider_arriving_soon'
  | 'signal_lost'
  | 'delivery_completed'
  | 'delivery_failed'
  | 'order_late_sla';

export interface TriggerNotificationParams {
  order_id: string;
  event_type: NotificationEventType;
  recipient_role?: 'rider' | 'admin' | 'retailer';
  recipient_user_id?: string;
  data?: Record<string, any>;
}

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/send-push-notification`;

/**
 * Client-side helper to trigger server-side push notification dispatch via Edge Function.
 * Completely fire-and-forget / non-blocking so caller is never stalled.
 */
export async function triggerNotification(
  params: TriggerNotificationParams,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!params.order_id || !params.event_type) {
      return { success: false, error: 'Missing required parameters (order_id, event_type)' };
    }

    // Try via supabase.functions.invoke first (handles session JWT automatically)
    try {
      const { data, error } = await supabase.functions.invoke('send-push-notification', {
        body: params,
      });

      if (!error && data) {
        return { success: true };
      }
    } catch {
      // Fall through to manual fetch fallback
    }

    if (!SUPABASE_URL) {
      console.warn('[notificationTriggerService] Missing SUPABASE_URL');
      return { success: false, error: 'Supabase URL not configured' };
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token || SUPABASE_ANON_KEY;

    const res = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      console.warn(`[notificationTriggerService] Edge function returned ${res.status}:`, errText);
      return { success: false, error: errText };
    }

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[notificationTriggerService] Failed to trigger notification:', msg);
    return { success: false, error: msg };
  }
}
