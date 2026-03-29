import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/store/authStore';

export default function Index() {
  const { user, isLoading } = useAuthStore();

  // Prevent flicker while auth state is loading
  if (isLoading) {
    return null;
  }

  // Not logged in → go to login
  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role === 'admin') {
    return <Redirect href="/admin" />;
  }

  if (user.role === 'delivery') {
    return <Redirect href="/delivery" />;
  }

  // Logged in retailer → main app
  return <Redirect href="/(tabs)" />;
}
