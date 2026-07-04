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
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="create-order" options={{ title: 'Select Retailer' }} />
      <Stack.Screen name="create-order-items" options={{ title: 'New Order' }} />
      <Stack.Screen name="create-retailer" options={{ title: 'Create Retailer' }} />
      <Stack.Screen name="edit-order" options={{ title: 'Edit Order' }} />
    </Stack>
  );
}
