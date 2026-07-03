import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../store/authStore';

/**
 * Shared duty-toggle hook for the delivery portal.
 *
 * Encapsulates:
 *  – loading the current on/off-duty state from the profiles table
 *  – toggling duty (with an active-orders check when going *off* duty)
 *  – a low-level `applyDutyChange` for cases that skip the check
 */
export function useDeliveryDuty() {
  const userId = useAuthStore((s) => s.user?.id);
  const [isOnDuty, setIsOnDuty] = useState(false);
  const [dutyLoading, setDutyLoading] = useState(true);
  const [dutyToggling, setDutyToggling] = useState(false);

  const loadDutyStatus = useCallback(async () => {
    try {
      if (!userId) return;
      const { data, error } = await supabase
        .from('profiles')
        .select('is_on_duty')
        .eq('id', userId)
        .single();
      if (error) throw error;
      setIsOnDuty(!!data?.is_on_duty);
    } catch (err: unknown) {
      console.warn(
        'Duty status load error:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      setDutyLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadDutyStatus();
  }, [loadDutyStatus]);

  const applyDutyChange = useCallback(
    async (nextOnDuty: boolean) => {
      setDutyToggling(true);
      try {
        if (!userId) throw new Error('Not signed in');
        const { error } = await supabase
          .from('profiles')
          .update({ is_on_duty: nextOnDuty })
          .eq('id', userId);
        if (error) throw error;
        setIsOnDuty(nextOnDuty);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Could not update duty status';
        Alert.alert('Error', msg);
      } finally {
        setDutyToggling(false);
      }
    },
    [userId],
  );

  /**
   * Smart toggle: going ON is immediate; going OFF first checks whether the
   * driver has active orders and shows a confirmation dialog.
   */
  const toggleOnDuty = useCallback(
    async (nextOnDuty: boolean) => {
      if (nextOnDuty) {
        await applyDutyChange(true);
        return;
      }

      try {
        if (!userId) return;
        const { data, error } = await supabase
          .from('profiles')
          .select('current_order_count')
          .eq('id', userId)
          .single();
        if (error) throw error;
        const active = data?.current_order_count ?? 0;

        if (active > 0) {
          Alert.alert(
            'Go off duty?',
            `You have ${active} active orders. Going off duty will not unassign them.`,
            [
              { text: 'Stay on duty', style: 'cancel' },
              {
                text: 'Go off duty',
                onPress: () => void applyDutyChange(false),
              },
            ],
          );
          return;
        }

        await applyDutyChange(false);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Could not check active orders';
        Alert.alert('Error', msg);
      }
    },
    [userId, applyDutyChange],
  );

  return {
    isOnDuty,
    dutyLoading,
    dutyToggling,
    loadDutyStatus,
    toggleOnDuty,
    applyDutyChange,
  };
}
