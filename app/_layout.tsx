import { Slot } from 'expo-router';
import { useEffect } from 'react';
import { useAuthStore } from '../src/store/authStore';

export default function RootLayout() {
  const { fetchUser } = useAuthStore();

useEffect(() => {
  fetchUser();
}, []);


  return <Slot />;
}
