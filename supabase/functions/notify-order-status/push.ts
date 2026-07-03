// Expo push notifications for admin / delivery staff

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

type SupabaseClient = ReturnType<
  typeof import('https://esm.sh/@supabase/supabase-js@2').createClient
>;

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  data?: Record<string, unknown>;
}

interface ExpoTicketOk {
  status: 'ok';
  id?: string;
}

interface ExpoTicketError {
  status: 'error';
  message?: string;
  details?: { error?: string };
}

type ExpoTicket = ExpoTicketOk | ExpoTicketError;

function formatRupee(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 })}`;
}

function retailerDisplayName(order: { user_name?: string | null }): string {
  const name = order.user_name?.trim();
  return name || 'Retailer';
}

export async function sendStaffPushNotifications(
  supabase: SupabaseClient,
  orderId: string,
  order: {
    order_number: string;
    user_name?: string | null;
    grand_total?: number | null;
    assigned_to?: string | null;
  },
  toStatus: string,
): Promise<void> {
  const orderNumber = order.order_number;
  const retailerName = retailerDisplayName(order);
  const totalLabel = formatRupee(order.grand_total);
  const data = { orderId, toStatus };

  switch (toStatus) {
    case 'pending': {
      const body = `${orderNumber} from ${retailerName} — ${totalLabel}`;
      await sendPushToAdmins(supabase, 'New order', body, data);
      break;
    }
    case 'pending_payment': {
      const body = `${orderNumber} from ${retailerName} — ${totalLabel}`;
      await sendPushToAdmins(supabase, 'New UPI order — awaiting payment', body, data);
      break;
    }
    case 'assigned': {
      if (!order.assigned_to) return;
      await sendPushToProfileId(
        supabase,
        order.assigned_to,
        'New order assigned',
        `${orderNumber} has been assigned to you. Open the app to accept.`,
        data,
      );
      break;
    }
    case 'accepted': {
      if (!order.assigned_to) return;
      await sendPushToProfileId(
        supabase,
        order.assigned_to,
        'Order accepted',
        `${orderNumber} is on your run sheet. Mark pickup when ready.`,
        data,
      );
      break;
    }
    case 'packed': {
      if (!order.assigned_to) return;
      await sendPushToProfileId(
        supabase,
        order.assigned_to,
        'Order ready for pickup',
        `${orderNumber} is packed and ready. Come collect it.`,
        data,
      );
      break;
    }
    case 'cancelled': {
      if (!order.assigned_to) return;
      await sendPushToProfileId(
        supabase,
        order.assigned_to,
        'Order cancelled',
        `${orderNumber} has been cancelled. No action needed.`,
        data,
      );
      break;
    }
    case 'payment_failed': {
      const body = `${orderNumber} from ${retailerName} — ${totalLabel}`;
      await sendPushToAdmins(supabase, 'Payment failed', body, data);
      break;
    }
    default:
      break;
  }
}

async function sendPushToAdmins(
  supabase: SupabaseClient,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const { data: rows, error } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('role', 'admin')
    .not('push_token', 'is', null);

  if (error) {
    console.error('Failed to fetch admin push tokens:', error.message);
    return;
  }

  const tokens = (rows ?? [])
    .map((r: { push_token: string | null }) => r.push_token)
    .filter((t): t is string => !!t && t.length > 0);

  await sendPush(supabase, tokens, title, body, data);
}

async function sendPushToProfileId(
  supabase: SupabaseClient,
  profileId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', profileId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch delivery push token:', error.message);
    return;
  }

  const token = profile?.push_token;
  if (!token) return;

  await sendPush(supabase, [token], title, body, data);
}

export async function sendPush(
  supabase: SupabaseClient,
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const uniqueTokens = [...new Set(tokens.filter((t) => t.length > 0))];
  if (uniqueTokens.length === 0) return;

  for (let offset = 0; offset < uniqueTokens.length; offset += EXPO_BATCH_SIZE) {
    const batchTokens = uniqueTokens.slice(offset, offset + EXPO_BATCH_SIZE);
    const messages: ExpoPushMessage[] = batchTokens.map((to) => ({
      to,
      title,
      body,
      sound: 'default',
      ...(data ? { data } : {}),
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(messages),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        console.error('Expo push HTTP error:', res.status, json);
        continue;
      }

      const tickets: ExpoTicket[] = Array.isArray(json?.data) ? json.data : [];
      if (tickets.length !== batchTokens.length) {
        console.error('Expo push ticket count mismatch:', tickets.length, batchTokens.length);
      }

      await handleExpoTickets(supabase, batchTokens, tickets);
    } catch (err) {
      console.error('Expo push request failed:', err);
    }
  }
}

async function handleExpoTickets(
  supabase: SupabaseClient,
  tokens: string[],
  tickets: ExpoTicket[],
): Promise<void> {
  const limit = Math.min(tokens.length, tickets.length);

  for (let i = 0; i < limit; i++) {
    const ticket = tickets[i];
    const token = tokens[i];

    if (ticket.status !== 'error') continue;

    const detailError = ticket.details?.error;
    if (detailError === 'DeviceNotRegistered') {
      const { error } = await supabase.from('profiles').update({ push_token: null }).eq('push_token', token);
      if (error) {
        console.error('Failed to clear stale push_token:', token, error.message);
      }
    } else {
      console.error('Expo push error:', token, ticket.message ?? detailError ?? ticket);
    }
  }
}
