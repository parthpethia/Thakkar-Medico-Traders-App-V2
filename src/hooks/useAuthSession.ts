// PA: CRIT-1 — Fix setUser shadowing Sentry errorReporting import

import { useState, useEffect } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { setUser as setSentryUser, clearUser as clearSentryUser } from '../utils/errorReporting';

export function useAuthSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setSessionUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let lastUserId: string | null = null;
    let initialEventHandled = false;

    const finishInitialLoad = () => {
      if (!initialEventHandled) {
        initialEventHandled = true;
        setIsLoading(false);
      }
    };

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setSessionUser(data.session?.user ?? null);
      finishInitialLoad();
    }).catch(() => {
      if (!cancelled) finishInitialLoad();
    });

    const failsafe = setTimeout(() => {
      if (!cancelled) finishInitialLoad();
    }, 8000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (cancelled) return;

        setSession(newSession);
        setSessionUser(newSession?.user ?? null);
        finishInitialLoad();

        if (event === 'SIGNED_IN' && newSession?.user) {
          lastUserId = newSession.user.id;
          setSentryUser(newSession.user.id, (newSession.user as any).role);
          try {
            await supabase.rpc('log_login_event', {
              p_user_id: newSession.user.id,
              p_event: 'login',
              p_ip: '',
              p_user_agent: '',
            });
          } catch {}
        }

        if (event === 'SIGNED_OUT') {
          clearSentryUser();
          const uid = lastUserId;
          lastUserId = null;
          if (uid) {
            try {
              await supabase.rpc('log_login_event', {
                p_user_id: uid,
                p_event: 'logout',
                p_ip: '',
                p_user_agent: '',
              });
            } catch {}
          }
        }

        if (event === 'USER_UPDATED' && newSession?.user) {
          try {
            await supabase.rpc('log_login_event', {
              p_user_id: newSession.user.id,
              p_event: 'password_reset',
              p_ip: '',
              p_user_agent: '',
            });
          } catch {}
        }
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      subscription.unsubscribe();
    };
  }, []);

  return { session, user, isLoading };
}
