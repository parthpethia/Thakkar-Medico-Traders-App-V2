// Jest global setup — mock native modules unavailable in test environment
import 'react-native-get-random-values';

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-localization
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en', languageTag: 'en-US' }],
}));

// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'undetermined' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'ExponentPushToken[mock]' }),
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// Mock expo-camera
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: jest.fn(() => [{ granted: true }, jest.fn()]),
}));

// Mock expo-local-authentication
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock @react-native-async-storage/async-storage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiGet: jest.fn().mockResolvedValue([]),
  multiSet: jest.fn().mockResolvedValue(undefined),
}));

// Mock @sentry/react-native
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  withScope: jest.fn((cb) => cb({ setExtra: jest.fn() })),
  setUser: jest.fn(),
}));

// Mock supabase client
jest.mock('../src/services/supabase', () => {
  const createQueryBuilder = () => {
    const builder: any = {
      select: jest.fn().mockImplementation(() => builder),
      eq: jest.fn().mockImplementation(() => builder),
      is: jest.fn().mockImplementation(() => builder),
      in: jest.fn().mockImplementation(() => builder),
      gte: jest.fn().mockImplementation(() => builder),
      order: jest.fn().mockImplementation(() => builder),
      limit: jest.fn().mockImplementation(() => builder),
      range: jest.fn().mockImplementation(() => builder),
      ilike: jest.fn().mockImplementation(() => builder),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockImplementation(() => builder),
      upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return builder;
  };

  return {
    supabase: {
      auth: {
        getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
        signInWithPassword: jest.fn(),
        signOut: jest.fn(),
      },
      from: jest.fn(() => createQueryBuilder()),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      channel: jest.fn(() => ({
        on: jest.fn().mockReturnThis(),
        subscribe: jest.fn(),
      })),
      removeChannel: jest.fn(),
      getChannels: jest.fn(() => []),
    },
  };
});

// Silence console.warn in tests
const originalWarn = console.warn;
console.warn = (...args: any[]) => {
  // Filter out noisy React Native / Expo warnings in tests
  const msg = args[0]?.toString?.() || '';
  if (
    msg.includes('Animated') ||
    msg.includes('NativeModule') ||
    msg.includes('ViewManagerResolver')
  ) {
    return;
  }
  originalWarn.apply(console, args);
};
