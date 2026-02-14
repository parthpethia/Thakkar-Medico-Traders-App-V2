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

  // Logged in → main app
  return <Redirect href="/(tabs)" />;
}
