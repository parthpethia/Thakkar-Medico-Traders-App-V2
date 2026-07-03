import { getProviderConfig, type ProviderConfig } from './config.ts';

export async function sendSmsMessage(phone: string, body: string): Promise<void> {
  const config = getProviderConfig();
  if (config.provider === 'twilio') {
    await sendViaTwilio(config, phone, body);
    return;
  }
  // MSG91 flow templates — use generic SMS body via flow if configured, else throw
  const templateId = config.templateIds['delivery_otp'];
  if (!templateId) {
    throw new Error('MSG91 delivery_otp template not configured; use NOTIFY_PROVIDER=twilio for OTP SMS');
  }
  await sendViaMsg91(config, phone, body, 'delivery_otp');
}

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
  config: ProviderConfig & { provider: 'msg91' },
  to: string,
  _message: string,
  status: string,
) {
  const templateId = config.templateIds[status];
  if (!templateId) {
    throw new Error(`No MSG91 template ID configured for: ${status}`);
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
