// =============================================================================
// FIX B — Notification provider configuration
// =============================================================================

export type NotifyProvider = 'twilio' | 'msg91';

export interface TwilioConfig {
  provider: 'twilio';
  accountSid: string;
  authToken: string;
  from: string;
}

export interface Msg91Config {
  provider: 'msg91';
  apiKey: string;
  senderId: string;
  templateIds: Record<string, string>;
}

export type ProviderConfig = TwilioConfig | Msg91Config;

export function getProviderConfig(): ProviderConfig {
  const provider = (Deno.env.get('NOTIFY_PROVIDER') || 'twilio') as NotifyProvider;

  if (provider === 'msg91') {
    const apiKey = Deno.env.get('MSG91_API_KEY');
    const senderId = Deno.env.get('MSG91_SENDER_ID');
    const templateIdsRaw = Deno.env.get('MSG91_TEMPLATE_IDS');

    if (!apiKey) throw new Error('MSG91_API_KEY is required when NOTIFY_PROVIDER=msg91');
    if (!senderId) throw new Error('MSG91_SENDER_ID is required when NOTIFY_PROVIDER=msg91');

    let templateIds: Record<string, string> = {};
    if (templateIdsRaw) {
      try {
        templateIds = JSON.parse(templateIdsRaw);
      } catch {
        throw new Error('MSG91_TEMPLATE_IDS must be valid JSON: {"approved":"tpl_xxx",...}');
      }
    }

    return { provider: 'msg91', apiKey, senderId, templateIds };
  }

  // Default: Twilio
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');

  if (!accountSid) throw new Error('TWILIO_ACCOUNT_SID is required when NOTIFY_PROVIDER=twilio');
  if (!authToken) throw new Error('TWILIO_AUTH_TOKEN is required when NOTIFY_PROVIDER=twilio');
  if (!from) throw new Error('TWILIO_FROM is required when NOTIFY_PROVIDER=twilio');

  return { provider: 'twilio', accountSid, authToken, from };
}

export const MESSAGE_TEMPLATES: Record<string, string> = {
  approved:   '✅ Order #{{order_number}} approved. We\'ll pack it shortly.',
  packed:     '📦 Order #{{order_number}} is packed and ready for dispatch.',
  dispatched: '🚚 Order #{{order_number}} is on the way!',
  delivered:  '✅ Order #{{order_number}} delivered. Thank you!',
  cancelled:  '❌ Order #{{order_number}} has been cancelled. Contact us for help.',
  rejected:
    'Your order #{{order_number}} was not accepted. Reason: {{rejection_reason}}. Please contact us or place a new order.',
};
