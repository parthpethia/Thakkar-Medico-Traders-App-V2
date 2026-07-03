import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

function pushSupportedOnThisBuild(): boolean {
  if (Platform.OS === 'web') return false;
  if (Constants.appOwnership === 'expo') return false;
  return true;
}

export function usePaymentFailedPush(userId: string | undefined): void {
  const router = useRouter();

  useEffect(() => {
    if (!userId || !pushSupportedOnThisBuild()) return;

    let responseSub: { remove: () => void } | undefined;

    (async () => {
      try {
        const Notifications = await import('expo-notifications');

        responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
          const data = response.notification.request.content.data as Record<string, unknown> | undefined;
          if (data?.type !== 'payment_failed') return;

          const orderId = data.orderId ?? data.order_id;
          if (orderId) {
            router.push({
              pathname: '/order/[id]',
              params: { id: String(orderId), retryPayment: '1' },
            });
          }
        });
      } catch {
        /* fire-and-forget */
      }
    })();

    return () => {
      responseSub?.remove();
    };
  }, [userId, router]);
}
