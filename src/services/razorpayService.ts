import { supabase } from './supabase';
import { NativeModules } from 'react-native';

export type CreateRazorpayOrderResult = {
  razorpay_order_id: string;
  amount_paise: number;
  key_id: string;
  order_number?: string;
};

export async function callCreateRazorpayOrder(
  orderId: string,
): Promise<{ data?: CreateRazorpayOrderResult; error?: string }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { error: 'Not authenticated' };
  }

  const baseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!baseUrl) {
    return { error: 'Supabase URL not configured' };
  }

  const response = await fetch(`${baseUrl}/functions/v1/create-razorpay-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });

  let json: Record<string, unknown>;
  try {
    json = await response.json();
  } catch {
    return { error: 'Invalid response from server' };
  }

  if (!response.ok) {
    return { error: (json.error as string) || `Request failed (${response.status})` };
  }

  return {
    data: json as unknown as CreateRazorpayOrderResult,
  };
}

export type RazorpayCheckoutPrefill = {
  contact?: string;
  email?: string;
};

export type RazorpayCheckoutResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'error'; message?: string };

export async function openRazorpayCheckout(options: {
  keyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  orderNumber: string;
  prefill?: RazorpayCheckoutPrefill;
}): Promise<RazorpayCheckoutResult> {
  try {
    const { RNRazorpayCheckout } = NativeModules;
    if (!RNRazorpayCheckout) {
      return {
        ok: false,
        reason: 'error',
        message: 'Razorpay payment is not supported in Expo Go. Please run the app using a native development build (npx expo run:android or run:ios).',
      };
    }

    const RazorpayCheckout = (await import('react-native-razorpay')).default;
    await RazorpayCheckout.open({
      key: options.keyId,
      order_id: options.razorpayOrderId,
      amount: options.amountPaise,
      currency: 'INR',
      name: 'Thakkar Medico',
      description: options.orderNumber,
      prefill: {
        contact: options.prefill?.contact || '',
        email: options.prefill?.email || '',
      },
      theme: {
        color: '#4C51C9',
      },
    });
    return { ok: true };

  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    const description = (err as { description?: string })?.description;
    if (code === 0 || code === 2) {
      return { ok: false, reason: 'cancelled', message: description };
    }
    return {
      ok: false,
      reason: 'error',
      message: description || (err instanceof Error ? err.message : 'Payment failed'),
    };
  }
}

export async function startRazorpayPaymentForOrder(
  orderId: string,
  prefill?: RazorpayCheckoutPrefill,
): Promise<RazorpayCheckoutResult> {
  const { data, error } = await callCreateRazorpayOrder(orderId);
  if (error || !data) {
    return { ok: false, reason: 'error', message: error || 'Could not start payment' };
  }

  return openRazorpayCheckout({
    keyId: data.key_id,
    razorpayOrderId: data.razorpay_order_id,
    amountPaise: data.amount_paise,
    orderNumber: data.order_number || orderId,
    prefill,
  });
}
