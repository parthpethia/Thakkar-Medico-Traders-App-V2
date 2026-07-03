import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'delivery_otp:';

export async function setDeliveryOtpForOrder(orderId: string, otp: string): Promise<void> {
  const code = otp.replace(/\D/g, '').slice(0, 4);
  if (code.length !== 4) return;
  await AsyncStorage.setItem(`${KEY_PREFIX}${orderId}`, code);
}

export async function getDeliveryOtpForOrder(orderId: string): Promise<string | null> {
  const raw = await AsyncStorage.getItem(`${KEY_PREFIX}${orderId}`);
  if (!raw) return null;
  const code = raw.replace(/\D/g, '').slice(0, 4);
  return code.length === 4 ? code : null;
}

export async function clearDeliveryOtpForOrder(orderId: string): Promise<void> {
  await AsyncStorage.removeItem(`${KEY_PREFIX}${orderId}`);
}
