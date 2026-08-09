// =============================================================================
// Edge Function: notify-canary-alert
// Triggered on INSERT into delivery_telemetry_events.
// Immediately sends high-priority Expo push notifications to all admins
// when critical canary thresholds are tripped or riders report route issues.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

interface TelemetryWebhookPayload {
  type: 'INSERT';
  table: string;
  record: {
    id: string;
    event_type: string;
    rider_id: string | null;
    order_id: string | null;
    metadata: Record<string, any>;
    created_at: string;
  };
}

Deno.serve(async (req) => {
  try {
    const payload: TelemetryWebhookPayload = await req.json();
    const event = payload.record;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let alertTitle: string | null = null;
    let alertBody: string | null = null;

    if (event.event_type === 'auto_circuit_breaker_triggered') {
      alertTitle = '🚨 Canary Rollback: Auto Circuit Breaker Tripped';
      const reason = event.metadata?.reason || 'Threshold exceeded';
      alertBody = `Rider ${event.rider_id ? event.rider_id.slice(0, 8) : 'Unknown'} auto-reverted to baseline mode (${reason}).`;
    } else if (event.event_type === 'rider_reported_issue') {
      alertTitle = '⚠️ Canary Notice: Rider Reported Route Issue';
      alertBody = `Rider reported navigation issue on Order ${event.order_id ? event.order_id.slice(0, 8) : 'in-flight'}. Review dispatch.`;
    } else if (event.event_type === 'realtime_reconnect') {
      // Check if this rider has > 2 reconnects in past 24 hours
      if (event.rider_id) {
        const { count } = await supabase
          .from('delivery_telemetry_events')
          .select('id', { count: 'exact', head: true })
          .eq('rider_id', event.rider_id)
          .eq('event_type', 'realtime_reconnect')
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

        if (count && count > 2) {
          alertTitle = '⚠️ Canary Warning: High Reconnect Frequency';
          alertBody = `Rider ${event.rider_id.slice(0, 8)} recorded ${count} reconnects in 24h (Threshold: >2). Consider manual toggle off.`;
        }
      }
    }

    if (!alertTitle || !alertBody) {
      return new Response(JSON.stringify({ skipped: true, event_type: event.event_type }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch admin push tokens
    const { data: admins } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('role', 'admin')
      .not('push_token', 'is', null);

    const tokens = (admins ?? [])
      .map((r: { push_token: string | null }) => r.push_token)
      .filter((t): t is string => !!t && t.length > 0);

    if (tokens.length === 0) {
      console.log('No admin push tokens found for alert dispatch.');
      return new Response(JSON.stringify({ sent: false, reason: 'no_admin_tokens' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messages = tokens.map((to) => ({
      to,
      title: alertTitle,
      body: alertBody,
      sound: 'default',
      priority: 'high',
      channelId: 'admin_alerts',
      data: {
        eventType: event.event_type,
        riderId: event.rider_id,
        orderId: event.order_id,
        timestamp: event.created_at,
      },
    }));

    const pushRes = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    });

    return new Response(JSON.stringify({ sent: true, admin_count: tokens.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('notify-canary-alert error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
