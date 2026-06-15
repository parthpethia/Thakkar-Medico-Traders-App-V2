// =============================================================================
// FIX B — Edge Function: notify-order-status
// Triggered by a Database Webhook on order_status_events INSERT.
// Sends WhatsApp/SMS to the retailer when their order status changes.
// CHANGED: Added low stock alert check after delivered/packed status.
// CHANGED: Added retry logic for external API calls.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getProviderConfig, MESSAGE_TEMPLATES, type ProviderConfig } from './config.ts';

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: {
    id: string;
    order_id: string;
    from_status: string | null;
    to_status: string;
    actor_id: string | null;
    created_at: string;
  };
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const LOW_STOCK_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

Deno.serve(async (req) => {
  try {
    const payload: WebhookPayload = await req.json();
    const { order_id, to_status } = payload.record;

    if (to_status === 'pending' || to_status === 'pending_payment') {
      return new Response(JSON.stringify({ skipped: true, reason: 'no notification for pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const template = MESSAGE_TEMPLATES[to_status];
    if (!template) {
      return new Response(JSON.stringify({ skipped: true, reason: `no template for ${to_status}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch order details
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('order_number, user_id')
      .eq('id', order_id)
      .single();

    if (orderErr || !order) {
      await logNotification(supabase, order_id, to_status, null, 'unknown', 'failed', `Order not found: ${orderErr?.message}`);
      return new Response(JSON.stringify({ error: 'order_not_found' }), { status: 500 });
    }

    // Fetch retailer phone
    const { data: profile } = await supabase
      .from('profiles')
      .select('phone')
      .eq('id', order.user_id)
      .single();

    const phone = profile?.phone;

    if (!phone) {
      await logNotification(supabase, order_id, to_status, null, 'none', 'skipped', 'skipped: no phone');
      return new Response(JSON.stringify({ skipped: true, reason: 'no phone number' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const orderLink = `thakkarmedico://order/${order_id}`;
    const message =
      template.replace('{{order_number}}', order.order_number) +
      `\n\nView order: ${orderLink}`;

    // Send via configured provider with retry
    let providerConfig: ProviderConfig;
    try {
      providerConfig = getProviderConfig();
    } catch (err: any) {
      await logNotification(supabase, order_id, to_status, phone, 'unconfigured', 'failed', err.message);
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }

    try {
      await withRetryInternal(async () => {
        if (providerConfig.provider === 'twilio') {
          await sendViaTwilio(providerConfig, phone, message);
        } else {
          await sendViaMsg91(providerConfig, phone, message, to_status);
        }
      });

      await logNotification(supabase, order_id, to_status, phone, providerConfig.provider, 'sent', null);
    } catch (err: any) {
      await logNotification(supabase, order_id, to_status, phone, providerConfig.provider, 'failed', err.message);
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }

    // CHANGED: FIX B — Low stock alert check after delivered/packed
    if (to_status === 'delivered' || to_status === 'packed') {
      try {
        await checkLowStockAlerts(supabase, order_id, providerConfig);
      } catch (err) {
        console.error('Low stock alert check failed:', err);
      }
    }

    return new Response(JSON.stringify({ sent: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('notify-order-status error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});

// =============================================================================
// CHANGED: Low stock alert logic
// =============================================================================

async function checkLowStockAlerts(supabase: any, orderId: string, providerConfig: ProviderConfig) {
  // Fetch order items for this order
  const { data: orderItems } = await supabase
    .from('order_items')
    .select('product_id')
    .eq('order_id', orderId);

  if (!orderItems || orderItems.length === 0) return;

  // Fetch low stock threshold from settings
  const { data: settings } = await supabase
    .from('settings')
    .select('low_stock_threshold, support_phone')
    .limit(1)
    .single();

  const threshold = settings?.low_stock_threshold ?? 10;
  const supportPhone = settings?.support_phone;

  if (!supportPhone) return;

  const productIds = orderItems.map((item: any) => item.product_id);

  // Check which products are now below threshold
  const { data: products } = await supabase
    .from('products')
    .select('id, name, stock_quantity, last_alerted_at')
    .in('id', productIds)
    .lte('stock_quantity', threshold);

  if (!products || products.length === 0) return;

  const now = new Date();

  for (const product of products) {
    // Debounce: skip if alerted within the last hour
    if (product.last_alerted_at) {
      const lastAlerted = new Date(product.last_alerted_at);
      if (now.getTime() - lastAlerted.getTime() < LOW_STOCK_ALERT_COOLDOWN_MS) {
        continue;
      }
    }

    const alertMessage =
      `⚠️ Low stock alert: ${product.name} has ${product.stock_quantity} units remaining` +
      `\n\nManage stock: thakkarmedico://admin/stock`;

    try {
      await withRetryInternal(async () => {
        if (providerConfig.provider === 'twilio') {
          await sendViaTwilio(providerConfig, supportPhone, alertMessage);
        } else {
          await sendViaMsg91(providerConfig, supportPhone, alertMessage, 'low_stock');
        }
      });

      // Update last_alerted_at
      await supabase
        .from('products')
        .update({ last_alerted_at: now.toISOString() })
        .eq('id', product.id);

      // Log notification with reason
      await supabase.from('notifications_log').insert({
        order_id: orderId,
        to_status: 'low_stock',
        phone: supportPhone,
        provider: providerConfig.provider,
        status: 'sent',
        error: null,
        reason: 'low_stock',
      });
    } catch (err: any) {
      await supabase.from('notifications_log').insert({
        order_id: orderId,
        to_status: 'low_stock',
        phone: supportPhone,
        provider: providerConfig.provider,
        status: 'failed',
        error: err.message,
        reason: 'low_stock',
      });
    }
  }
}

// =============================================================================
// CHANGED: Retry logic for internal fetch calls
// =============================================================================

async function withRetryInternal(fn: () => Promise<void>): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn();
      return;
    } catch (err: any) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// =============================================================================
// Provider implementations
// =============================================================================

async function sendViaTwilio(
  config: { accountSid: string; authToken: string; from: string },
  to: string,
  body: string,
) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = btoa(`${config.accountSid}:${config.authToken}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: config.from,
      To: to,
      Body: body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio error ${res.status}: ${text}`);
  }
}

async function sendViaMsg91(
  config: { apiKey: string; senderId: string; templateIds: Record<string, string> },
  to: string,
  _message: string,
  status: string,
) {
  const templateId = config.templateIds[status];
  if (!templateId) {
    throw new Error(`No MSG91 template ID configured for status: ${status}`);
  }

  const res = await fetch('https://api.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      authkey: config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      flow_id: templateId,
      sender: config.senderId,
      mobiles: to,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MSG91 error ${res.status}: ${text}`);
  }
}

// =============================================================================
// Notification logging
// =============================================================================

async function logNotification(
  supabase: any,
  orderId: string,
  toStatus: string,
  phone: string | null,
  provider: string,
  status: 'sent' | 'failed' | 'skipped',
  error: string | null,
) {
  try {
    await supabase.from('notifications_log').insert({
      order_id: orderId,
      to_status: toStatus,
      phone,
      provider,
      status,
      error,
    });
  } catch (e) {
    console.error('Failed to log notification:', e);
  }
}
