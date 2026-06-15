import { useEffect, useState, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '../services/supabase';

type PushStatus = {
  token: string | null;
  permissionStatus: 'granted' | 'denied' | 'undetermined' | null;
};

/** Remote push is not available in Expo Go (SDK 53+). Use a development build. */
function pushSupportedOnThisBuild(): boolean {
  if (Platform.OS === 'web') return false;
  if (Constants.appOwnership === 'expo') return false;
  return true;
}

export function usePushNotifications(userId: string | undefined): PushStatus {
  const [token, setToken] = useState<string | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<PushStatus['permissionStatus']>(null);
  const didRun = useRef(false);

  useEffect(() => {
    if (!userId || didRun.current || !pushSupportedOnThisBuild()) return;
    didRun.current = true;

    (async () => {
      try {
        const Notifications = await import('expo-notifications');

        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        setPermissionStatus(finalStatus as PushStatus['permissionStatus']);

        if (finalStatus !== 'granted') {
          await supabase
            .from('profiles')
            .update({ push_enabled: false })
            .eq('id', userId);
          return;
        }

        const pushToken = await Notifications.getExpoPushTokenAsync();
        const tokenString = pushToken.data;
        setToken(tokenString);

        await supabase
          .from('profiles')
          .update({ push_token: tokenString, push_enabled: true })
          .eq('id', userId);
      } catch {
        /* fire-and-forget */
      }
    })();
  }, [userId]);

  return { token, permissionStatus };
}
