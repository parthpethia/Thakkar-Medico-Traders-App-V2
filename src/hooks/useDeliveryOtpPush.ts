import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { setDeliveryOtpForOrder } from '../utils/deliveryOtpStore';

function pushSupportedOnThisBuild(): boolean {
  if (Platform.OS === 'web') return false;
  if (Constants.appOwnership === 'expo') return false;
  return true;
}

function extractOtpFromData(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const raw = data.otp ?? data.code;
  if (raw == null) return null;
  const code = String(raw).replace(/\D/g, '').slice(0, 4);
  return code.length === 4 ? code : null;
}

function extractOtpFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/\b(\d{4})\b/);
  return match?.[1] ?? null;
}

async function persistOtpFromNotification(
  data: Record<string, unknown> | undefined,
  body: string | null | undefined,
): Promise<void> {
  const orderId = data?.orderId ?? data?.order_id;
  if (!orderId) return;
  const otp = extractOtpFromData(data) ?? extractOtpFromBody(body);
  if (!otp) return;
  await setDeliveryOtpForOrder(String(orderId), otp);
}

export function useDeliveryOtpPush(userId: string | undefined): void {
  const router = useRouter();

  useEffect(() => {
    if (!userId || !pushSupportedOnThisBuild()) return;

    let receiveSub: { remove: () => void } | undefined;
    let responseSub: { remove: () => void } | undefined;

    (async () => {
      try {
        const Notifications = await import('expo-notifications');

        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
            shouldShowBanner: true,
            shouldShowList: true,
          }),
        });

        receiveSub = Notifications.addNotificationReceivedListener((notification) => {
          const content = notification.request.content;
          const data = content.data as Record<string, unknown> | undefined;
          if (data?.type !== 'delivery_otp') return;
          void persistOtpFromNotification(data, content.body ?? null);
        });

        responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
          const content = response.notification.request.content;
          const data = content.data as Record<string, unknown> | undefined;
          if (data?.type !== 'delivery_otp') return;

          void persistOtpFromNotification(data, content.body ?? null).then(() => {
            const orderId = data.orderId ?? data.order_id;
            if (orderId) {
              router.push({ pathname: '/delivery/[id]', params: { id: String(orderId) } });
            }
          });
        });
      } catch {
        /* fire-and-forget */
      }
    })();

    return () => {
      receiveSub?.remove();
      responseSub?.remove();
    };
  }, [userId, router]);
}
