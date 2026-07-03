import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../notify-order-status/push.ts';
import { sendSmsMessage } from '../notify-order-status/sms.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse({ sent: false, error: 'method_not_allowed' });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ sent: false, error: 'unauthorized' });
    }

    const userToken = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabaseAuth.auth.getUser(userToken);

    if (userErr || !user) {
      return jsonResponse({ sent: false, error: 'unauthorized' });
    }

    let body: { order_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ sent: false, error: 'invalid_json' });
    }

    const orderId = body.order_id;
    if (!orderId) {
      return jsonResponse({ sent: false, error: 'order_id_required' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, user_id, assigned_to, order_number')
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr || !order) {
      return jsonResponse({ sent: false, error: 'order_not_found' });
    }

    if (order.assigned_to !== user.id) {
      return jsonResponse({ sent: false, error: 'access_denied' });
    }

    const supabaseAsCaller = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    const { data: code, error: otpErr } = await supabaseAsCaller.rpc('generate_delivery_otp', {
      p_order_id: orderId,
    });

    if (otpErr) {
      const msg = otpErr.message || '';
      if (msg.includes('otp_too_soon')) {
        return jsonResponse({ sent: false, reason: 'otp_too_soon' });
      }
      return jsonResponse({ sent: false, error: msg || 'otp_generation_failed' });
    }

    const otpCode = String(code);
    const otpMessage = `Thakkar Medico: Your delivery OTP for order #${order.order_number} is ${otpCode}. Share it with the delivery person.`;

    const { data: profile } = await supabase
      .from('profiles')
      .select('push_token, phone')
      .eq('id', order.user_id)
      .maybeSingle();

    const pushToken = profile?.push_token;
    const phone = profile?.phone?.trim();

    if (pushToken) {
      try {
        await sendPush(
          supabase,
          [pushToken],
          'Delivery OTP',
          `Your delivery OTP is ${otpCode}. Show this to the delivery person.`,
          { orderId, type: 'delivery_otp', otp: otpCode },
        );
        return jsonResponse({ sent: true, channel: 'push' });
      } catch (err) {
        console.error('OTP push failed, trying SMS:', err);
      }
    }

    if (phone) {
      try {
        await sendSmsMessage(phone, otpMessage);
        return jsonResponse({ sent: true, channel: 'sms' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('OTP SMS failed:', message);
        return jsonResponse({
          sent: false,
          reason: 'sms_failed',
          otp_generated: true,
          error: message,
        });
      }
    }

    return jsonResponse({
      sent: false,
      reason: 'no_push_token',
      otp_generated: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('send-delivery-otp error:', message);
    return jsonResponse({ sent: false, error: message });
  }
});

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
