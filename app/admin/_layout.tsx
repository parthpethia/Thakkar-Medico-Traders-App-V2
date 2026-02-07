import React from 'react';
import { Stack } from 'expo-router';

export default function AdminLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Admin Dashboard' }} />
      <Stack.Screen name="users" options={{ title: 'User Management' }} />
      <Stack.Screen name="products" options={{ title: 'Product Management' }} />
      <Stack.Screen name="orders" options={{ title: 'Order Management' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}
