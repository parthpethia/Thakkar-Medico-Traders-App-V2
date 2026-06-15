/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  name: 'Thakkar Medico',
  slug: 'thakkar-medico-traders',
  scheme: 'thakkarmedico',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  splash: {
    image: './assets/icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.thakkarmedico.app',
    buildNumber: '1',
    associatedDomains: ['applinks:thakkarmedico.com'],
    infoPlist: {
      NSFaceIDUsageDescription: 'Use Face ID to sign in quickly.',
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
    package: 'com.thakkarmedico.app',
    versionCode: 1,
    permissions: [
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'CAMERA',
      'POST_NOTIFICATIONS',
      'USE_BIOMETRIC',
      'USE_FINGERPRINT',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'thakkarmedico' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  web: {
    favicon: './assets/favicon.png',
  },
  extra: {
    eas: {
      projectId: 'c80e16b7-f2e2-40fc-aee5-0a571f2f13c9',
    },
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        backgroundColor: '#ffffff',
        image: './assets/icon.png',
        imageWidth: 200,
      },
    ],
    'expo-secure-store',
    'expo-localization',
    [
      'expo-notifications',
      {
        icon: './assets/icon.png',
        color: '#4C51C9',
      },
    ],
    'expo-local-authentication',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Allow Thakkar Medico Traders to use your location to optimize delivery routes.',
        locationWhenInUsePermission:
          'Allow Thakkar Medico Traders to use your location to optimize delivery routes.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow access to your photos to scan product images.',
        cameraPermission: 'Allow access to your camera to capture product photos.',
      },
    ],
    'expo-router',
    ['@sentry/react-native/expo', { organization: '', project: 'thakkar-medico' }],
  ],
});
