import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const CREDENTIALS_KEY = 'biometric_credentials';

export async function checkBiometricAvailable(): Promise<{ available: boolean; type: string }> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { available: false, type: 'none' };

    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!isEnrolled) return { available: false, type: 'none' };

    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    let typeName = 'biometric';
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      typeName = 'face';
    } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      typeName = 'fingerprint';
    } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
      typeName = 'iris';
    }

    return { available: true, type: typeName };
  } catch {
    return { available: false, type: 'none' };
  }
}

export async function authenticateWithBiometric(): Promise<{ success: boolean; email?: string; password?: string }> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Authenticate to sign in',
      fallbackLabel: 'Use passcode',
      cancelLabel: 'Cancel',
    });

    if (!result.success) return { success: false };

    const stored = await SecureStore.getItemAsync(CREDENTIALS_KEY);
    if (!stored) return { success: true };

    const credentials = JSON.parse(stored) as { email: string; password: string };
    return { success: true, email: credentials.email, password: credentials.password };
  } catch {
    return { success: false };
  }
}

export async function storeCredentials(email: string, password: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify({ email, password }));
  } catch {}
}

export async function clearCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
  } catch {}
}

export async function hasStoredCredentials(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(CREDENTIALS_KEY);
    return stored !== null;
  } catch {
    return false;
  }
}
