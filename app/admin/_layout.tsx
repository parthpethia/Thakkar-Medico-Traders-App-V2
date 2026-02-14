import { Stack, Redirect } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';

export default function AdminLayout() {
  const { user, isLoading } = useAuthStore();

  // Avoid flicker
  if (isLoading) return null;

  // Not logged in
  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  // Not admin
  if (user.role !== 'admin') {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: true,
      }}
    />
  );
}
