import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from './supabase';

export type PushRole = 'rider' | 'admin' | 'retailer';

function pushSupportedOnThisBuild(): boolean {
  if (Platform.OS === 'web') return false;
  if (Constants.appOwnership === 'expo') return false;
  return true;
}

/**
 * Registers device push notification token and syncs to Supabase `push_tokens` table.
 * Called once on app startup or login for both rider and admin roles.
 */
export async function registerPushToken(
  userId: string,
  role: PushRole,
): Promise<string | null> {
  try {
    if (!pushSupportedOnThisBuild()) return null;

    // Android Notification Channel (required for Android 8.0+)
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('delivery-alerts', {
        name: 'Delivery Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
        lightColor: '#1565C0',
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
      });
    }

    // Request push notification permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[pushTokenService] Push notification permission not granted:', finalStatus);
      return null;
    }

    // Retrieve Expo Push Token
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );

    const token = tokenResponse.data;
    if (!token) return null;

    // Upsert token to Supabase `push_tokens` table
    const { error: upsertError } = await supabase.from('push_tokens').upsert(
      {
        user_id: userId,
        expo_push_token: token,
        device_platform: Platform.OS,
        app_role: role,
        last_seen_at: new Date().toISOString(),
        is_active: true,
      },
      { onConflict: 'user_id,expo_push_token' },
    );

    if (upsertError) {
      console.warn('[pushTokenService] push_tokens upsert warning:', upsertError.message);
    }

    // Sync to profiles for backward compatibility
    try {
      await supabase
        .from('profiles')
        .update({ push_token: token, push_enabled: true })
        .eq('id', userId);
    } catch {
      /* ignore */
    }

    return token;
  } catch (err: unknown) {
    console.error('[pushTokenService] Failed to register push token:', err);
    return null;
  }
}
