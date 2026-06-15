import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuthStore } from '../store/authStore';

const POLL_INTERVAL_MS = 30_000;
/** Avoid competing with initAuth / cart load right after tabs mount. */
const FIRST_POLL_DELAY_MS = 8_000;

/**
 * Keeps `profiles.approved` in sync when an admin approves the account
 * without requiring sign-out / sign-in.
 */
export function useRefreshProfileWhilePending() {
  const authReady = useAuthStore((s) => s.authReady);
  const userId = useAuthStore((s) => s.user?.id);
  const role = useAuthStore((s) => s.user?.role);
  const approved = useAuthStore((s) => s.user?.approved);
  const fetchUser = useAuthStore((s) => s.fetchUser);

  const shouldPoll = authReady && role === 'retailer' && approved === false;

  useEffect(() => {
    if (!shouldPoll || !userId) return;

    const refresh = () => {
      void fetchUser({ silent: true });
    };

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') refresh();
    };

    const firstPollTimer = setTimeout(refresh, FIRST_POLL_DELAY_MS);
    const intervalId = setInterval(refresh, POLL_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', onAppStateChange);

    return () => {
      clearTimeout(firstPollTimer);
      clearInterval(intervalId);
      subscription.remove();
    };
  }, [shouldPoll, userId, fetchUser]);
}
