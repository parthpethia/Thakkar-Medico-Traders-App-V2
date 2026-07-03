import { Stack, Redirect } from 'expo-router';
import { useAuthStore } from '../../src/store/authStore';
import { useThemedStackScreenOptions } from '../../src/theme/useThemedStackScreenOptions';

export default function AdminLayout() {
  const { user } = useAuthStore();
  const screenOptions = useThemedStackScreenOptions({ headerShown: true });

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role !== 'admin') {
    return <Redirect href="/" />;
  }

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="products" options={{ headerShown: false }} />
    </Stack>
  );
}
