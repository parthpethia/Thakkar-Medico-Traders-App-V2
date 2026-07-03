import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../src/store/authStore';
import { AppLoadingScreen } from '../src/components/AppLoadingScreen';
import { routeForUser } from './_layout';

const ONBOARDING_KEY = 'onboarding_complete';

export default function Index() {
  const authReady = useAuthStore((s) => s.authReady);
  const user = useAuthStore((s) => s.user);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((value) => {
        if (!cancelled) setOnboardingDone(value === 'true');
      })
      .catch(() => {
        if (!cancelled) setOnboardingDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady || onboardingDone === null) {
    return <AppLoadingScreen message="Starting app…" />;
  }

  if (!onboardingDone) {
    return <Redirect href="/onboarding" />;
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  return <Redirect href={routeForUser(user)} />;
}
