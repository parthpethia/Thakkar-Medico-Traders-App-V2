// Legacy deep link — unapproved retailers use (tabs) with in-app verification banners.
import React from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
import { routeForUser } from '../_layout';

export default function PendingApprovalScreen() {
  const { user } = useAuthStore();

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role !== 'retailer' || user.approved) {
    return <Redirect href={routeForUser(user)} />;
  }

  return <Redirect href="/(tabs)" />;
}
