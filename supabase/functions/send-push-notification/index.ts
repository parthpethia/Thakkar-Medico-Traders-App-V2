import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    const { order_id, event_type, recipient_role, recipient_user_id, data = {} } = await req.json();

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch token(s) for recipient
    let tokenQuery = supabase
      .from('push_tokens')
      .select('expo_push_token, user_id')
      .eq('is_active', true);

    if (recipient_user_id) {
      tokenQuery = tokenQuery.eq('user_id', recipient_user_id);
    } else if (recipient_role) {
      tokenQuery = tokenQuery.eq('app_role', recipient_role);
    }

    const { data: tokens, error: tokenErr } = await tokenQuery;

    if (tokenErr) {
      console.error('Error fetching push tokens:', tokenErr);
    }

    if (!tokens || tokens.length === 0) {
      // Log as skipped
      if (recipient_user_id || recipient_role) {
        const { title, body } = buildMessage(event_type, data);
        await supabase.from('notification_log').insert({
          order_id: order_id || null,
          recipient_user_id: recipient_user_id || null,
          recipient_role: recipient_role || null,
          event_type,
          title,
          body,
          status: 'skipped',
          expo_receipt_id: null,
        });
      }
      return new Response(
        JSON.stringify({ status: 'skipped', reason: 'no_active_tokens' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { title, body } = buildMessage(event_type, data);

    const messages = tokens.map((t) => ({
      to: t.expo_push_token,
      sound: 'default',
      title,
      body,
      data: { order_id, event_type, ...data },
      priority: 'high',
      channelId: 'delivery-alerts',
    }));

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();

    // Log to notification_log
    const logs = tokens.map((t, i) => {
      const ticket = result.data?.[i];
      const isOk = ticket?.status === 'ok';
      return {
        order_id: order_id || null,
        recipient_user_id: t.user_id,
        recipient_role: recipient_role || null,
        event_type,
        title,
        body,
        status: isOk ? 'sent' : 'failed',
        expo_receipt_id: ticket?.id ?? null,
      };
    });

    await supabase.from('notification_log').insert(logs);

    return new Response(
      JSON.stringify({ status: 'ok', sent: logs.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('send-push-notification error:', errorMsg);
    return new Response(
      JSON.stringify({ status: 'error', error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});

function buildMessage(
  event_type: string,
  data: Record<string, any> = {},
): { title: string; body: string } {
  const orderNum = data.order_number || 'Delivery';
  const shop = data.shop_name || 'Destination';
  const rider = data.rider_name || 'Delivery Partner';

  const messages: Record<string, { title: string; body: string }> = {
    order_assigned: {
      title: '📦 New Delivery Assigned',
      body: `Order #${orderNum} → ${shop}. Pickup from Thakkar Medico.`,
    },
    order_dispatched: {
      title: '🛵 Your Order is On the Way!',
      body: `${rider} is heading to ${shop}. ETA: ~${data.eta_minutes ?? '15'} min.`,
    },
    rider_arriving_soon: {
      title: '🔔 Rider Arriving Soon',
      body: `Your delivery partner is less than 500m away. Please be ready to receive.`,
    },
    signal_lost: {
      title: '📡 Rider Signal Lost',
      body: `Order #${orderNum} — ${rider}'s location is unavailable for 2+ minutes.`,
    },
    delivery_completed: {
      title: '✅ Order Delivered',
      body: `Order #${orderNum} delivered to ${shop}${data.delivered_time ? ` at ${data.delivered_time}` : ''}.`,
    },
    delivery_failed: {
      title: '❌ Delivery Failed',
      body: `Order #${orderNum} to ${shop}. Reason: ${data.failed_reason || 'Could not deliver'}.`,
    },
    order_late_sla: {
      title: '⚠️ Delivery Running Late',
      body: `Order #${orderNum} may miss the ${data.preferred_window || 'preferred'} window. ETA: ${data.eta_time || 'delayed'}.`,
    },
  };

  return (
    messages[event_type] ?? {
      title: 'Thakkar Medico',
      body: 'Delivery tracking update.',
    }
  );
}
