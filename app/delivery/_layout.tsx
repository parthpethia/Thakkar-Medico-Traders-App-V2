import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
import { useThemedStackScreenOptions } from '../../src/theme/useThemedStackScreenOptions';
import { useDriverLocationTracking } from '../../src/hooks/useDriverLocationTracking';

export default function DeliveryLayout() {
  const { user } = useAuthStore();
  const screenOptions = useThemedStackScreenOptions({ headerShown: true });

  useDriverLocationTracking(user?.role === 'delivery');

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role !== 'delivery') {
    return <Redirect href="/" />;
  }

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
