import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
export default function DeliveryLayout() {
  const { user } = useAuthStore();

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role !== 'delivery') {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: true,
      }}
    />
  );
}
