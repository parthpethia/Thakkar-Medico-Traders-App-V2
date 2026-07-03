import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Switch,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { Order, OrderStatus } from '../../src/types';
import { runSheetPriority } from '../../src/constants/orderFlow';
import {
  googleMapsDirUrl,
  resolveOrderCoords,
} from '../../src/utils/orderDeliveryCoords';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';

const ACTIVE_STATUSES: OrderStatus[] = [
  'assigned',
  'accepted',
  'picked_up',
  'dispatched',
];

export default function DeliveryDashboard() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isOnDuty, setIsOnDuty] = useState(false);
  const [dutyLoading, setDutyLoading] = useState(true);
  const [dutyToggling, setDutyToggling] = useState(false);
  const [nextCoords, setNextCoords] = useState<{ lat: number; lng: number } | null>(null);

  const loadDuty = useCallback(async () => {
    try {
      const uid = user?.id;
      if (!uid) return;
      const { data, error } = await supabase
        .from('profiles')
        .select('is_on_duty')
        .eq('id', uid)
        .single();
      if (error) throw error;
      setIsOnDuty(!!data?.is_on_duty);
    } catch {
      /* ignore */
    } finally {
      setDutyLoading(false);
    }
  }, [user?.id]);

  const fetchRunSheet = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('get_orders_page', {
        p_role: 'delivery',
        p_user_id: null as unknown as string,
        p_status: null,
        p_cursor: null,
        p_cursor_id: null,
        p_page_size: 80,
        p_from_date: null,
        p_to_date: null,
        p_area: null,
      });
      if (error) throw error;

      const rows = ((data || []) as Order[]).filter(
        (o) =>
          o.fulfillment_mode === 'delivery' &&
          ACTIVE_STATUSES.includes(o.status),
      );

      rows.sort(
        (a, b) =>
          runSheetPriority(a.status) - runSheetPriority(b.status) ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      setOrders(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load run sheet';
      Alert.alert('Error', msg);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchRunSheet(), loadDuty()]);
  }, [fetchRunSheet, loadDuty]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refreshAll();
      setLoading(false);
    })();
  }, [refreshAll]);

  const userId = user?.id;
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    filter: userId ? `assigned_to=eq.${userId}` : undefined,
    enabled: !!userId,
    onUpdate: () => {
      void fetchRunSheet();
    },
  });

  const nextStop = useMemo(() => {
    const nav =
      orders.find((o) => o.status === 'dispatched') ||
      orders.find((o) => o.status === 'picked_up') ||
      orders.find((o) => o.status === 'accepted') ||
      orders.find((o) => o.status === 'assigned');
    return nav ?? null;
  }, [orders]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!nextStop) {
        setNextCoords(null);
        return;
      }
      const coords = await resolveOrderCoords(supabase, nextStop);
      if (!cancelled) {
        setNextCoords(coords ? { lat: coords.lat, lng: coords.lng } : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nextStop?.id, nextStop?.delivery_snapshot, nextStop?.delivery_address_id]);

  const applyDutyChange = async (nextOnDuty: boolean) => {
    setDutyToggling(true);
    try {
      const uid = user?.id;
      if (!uid) throw new Error('Not signed in');
      const { error } = await supabase
        .from('profiles')
        .update({ is_on_duty: nextOnDuty })
        .eq('id', uid);
      if (error) throw error;
      setIsOnDuty(nextOnDuty);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not update duty status';
      Alert.alert('Error', msg);
    } finally {
      setDutyToggling(false);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshAll();
    setRefreshing(false);
  }, [refreshAll]);

  const handleLogout = async () => {
    await logout();
    router.replace('/(auth)/login');
  };

  const acceptOrder = async (order: Order) => {
    try {
      const { error } = await supabase.rpc('delivery_accept_order', {
        p_order_id: order.id,
      });
      if (error) throw error;
      await fetchRunSheet();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Accept failed';
      if (msg.includes('off_duty')) {
        Alert.alert('Go on duty', 'Turn on duty before accepting orders.');
      } else {
        Alert.alert('Error', msg);
      }
    }
  };

  const rejectOrder = (order: Order) => {
    Alert.prompt?.(
      'Decline assignment',
      'Optional reason for admin:',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async (reason) => {
            try {
              const { error } = await supabase.rpc('delivery_reject_order', {
                p_order_id: order.id,
                p_reason: reason ?? null,
              });
              if (error) throw error;
              await fetchRunSheet();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Decline failed';
              Alert.alert('Error', msg);
            }
          },
        },
      ],
      'plain-text',
    );

    if (!Alert.prompt) {
      Alert.alert('Decline assignment?', `Order #${order.order_number}`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.rpc('delivery_reject_order', {
              p_order_id: order.id,
              p_reason: null,
            });
            if (!error) await fetchRunSheet();
          },
        },
      ]);
    }
  };

  const advanceStatus = (order: Order, next: OrderStatus, label: string) => {
    Alert.alert(label, `Order #${order.order_number}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          const { error } = await supabase
            .from('orders')
            .update({ status: next })
            .eq('id', order.id);
          if (error) {
            Alert.alert('Error', error.message);
            return;
          }
          await fetchRunSheet();
        },
      },
    ]);
  };

  const openNavigate = () => {
    if (!nextCoords) {
      Alert.alert('No GPS', 'This order has no stored coordinates. Use Today\'s Path or call the retailer.');
      return;
    }
    Linking.openURL(googleMapsDirUrl(nextCoords.lat, nextCoords.lng)).catch(() =>
      Alert.alert('Error', 'Could not open maps'),
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const pendingAccept = orders.filter((o) => o.status === 'assigned').length;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Run sheet</Text>
            <Text style={styles.subtitle}>{user?.name || 'Delivery Partner'}</Text>
          </View>
          <TouchableOpacity onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={24} color={colors.error} />
          </TouchableOpacity>
        </View>

        <View style={styles.dutyCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dutyTitle}>{isOnDuty ? 'On duty' : 'Off duty'}</Text>
            <Text style={styles.dutySub}>
              {pendingAccept > 0
                ? `${pendingAccept} assignment(s) need your response`
                : isOnDuty
                  ? `${orders.length} active on your sheet`
                  : 'Turn on when ready for deliveries'}
            </Text>
          </View>
          {dutyLoading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Switch
              value={isOnDuty}
              onValueChange={(v) => void applyDutyChange(v)}
              disabled={dutyToggling}
              trackColor={{ false: colors.switchTrackOff, true: colors.primaryMuted }}
              thumbColor={isOnDuty ? colors.switchThumbOn : colors.switchThumbOff}
            />
          )}
        </View>

        {nextStop ? (
          <View style={styles.nextCard}>
            <Text style={styles.nextLabel}>Next stop</Text>
            <Text style={styles.nextTitle}>
              #{nextStop.order_number} · {nextStop.user_name}
            </Text>
            <Text style={styles.nextMeta} numberOfLines={2}>
              {nextStop.delivery_address || '—'}
            </Text>
            <View style={styles.badgeRow}>
              <View style={styles.statusBadge}>
                <Text style={styles.statusBadgeText}>{nextStop.status}</Text>
              </View>
              <Text style={styles.nextAmount}>₹{(nextStop.grand_total || 0).toFixed(0)}</Text>
            </View>

            <View style={styles.nextActions}>
              {nextStop.status === 'assigned' && (
                <>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={() => void acceptOrder(nextStop)}
                  >
                    <Text style={styles.btnPrimaryText}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnOutline]}
                    onPress={() => rejectOrder(nextStop)}
                  >
                    <Text style={styles.btnOutlineText}>Decline</Text>
                  </TouchableOpacity>
                </>
              )}
              {nextStop.status === 'accepted' && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { flex: 1 }]}
                  onPress={() => advanceStatus(nextStop, 'picked_up', 'Mark picked up from warehouse?')}
                >
                  <Text style={styles.btnPrimaryText}>Mark picked up</Text>
                </TouchableOpacity>
              )}
              {nextStop.status === 'picked_up' && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { flex: 1 }]}
                  onPress={() => advanceStatus(nextStop, 'dispatched', 'Start delivery run?')}
                >
                  <Text style={styles.btnPrimaryText}>Mark dispatched</Text>
                </TouchableOpacity>
              )}
              {(nextStop.status === 'dispatched' || nextStop.status === 'picked_up') && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnMaps, { flex: 1 }]}
                  onPress={openNavigate}
                >
                  <Ionicons name="navigate" size={18} color={colors.onPrimary} />
                  <Text style={styles.btnPrimaryText}>Navigate</Text>
                </TouchableOpacity>
              )}
              {nextStop.status === 'dispatched' && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnSuccess, { flex: 1 }]}
                  onPress={() => router.push('/delivery/orders')}
                >
                  <Text style={styles.btnPrimaryText}>Deliver (OTP)</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.emptyNext}>
            <Ionicons name="checkmark-done-circle" size={48} color={colors.success} />
            <Text style={styles.emptyTitle}>No active deliveries</Text>
            <Text style={styles.emptySub}>New assignments appear here when admin assigns you.</Text>
          </View>
        )}

        <View style={styles.quickRow}>
          <TouchableOpacity
            style={styles.quickBtn}
            onPress={() => router.push('/delivery/todays-path')}
          >
            <Ionicons name="map-outline" size={20} color={colors.primary} />
            <Text style={styles.quickText}>Route</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickBtn}
            onPress={() => router.push('/delivery/orders')}
          >
            <Ionicons name="list-outline" size={20} color={colors.primary} />
            <Text style={styles.quickText}>All orders</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickBtn}
            onPress={() => router.push('/delivery/create-order')}
          >
            <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
            <Text style={styles.quickText}>Field order</Text>
          </TouchableOpacity>
        </View>

        {orders.length > 1 && (
          <View style={styles.queueSection}>
            <Text style={styles.queueTitle}>Queue ({orders.length})</Text>
            {orders.slice(1, 6).map((o) => (
              <TouchableOpacity
                key={o.id}
                style={styles.queueRow}
                onPress={() => router.push(`/order/${o.id}`)}
              >
                <Text style={styles.queueOrder}>#{o.order_number}</Text>
                <Text style={styles.queueStatus}>{o.status}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    header: {
      padding: 20,
      backgroundColor: c.surface,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },
    title: { fontSize: 24, fontWeight: '700' as const, color: c.text },
    subtitle: { fontSize: 14, color: c.textSecondary, marginTop: 4 },
    dutyCard: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      margin: 16,
      padding: 14,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.cardBorder,
    },
    dutyTitle: { fontSize: 15, fontWeight: '700' as const, color: c.text },
    dutySub: { fontSize: 12, color: c.textSecondary, marginTop: 4 },
    nextCard: {
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 16,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.primaryMuted,
    },
    nextLabel: { fontSize: 12, fontWeight: '600' as const, color: c.primary, textTransform: 'uppercase' as const },
    nextTitle: { fontSize: 18, fontWeight: '700' as const, color: c.text, marginTop: 6 },
    nextMeta: { fontSize: 13, color: c.textSecondary, marginTop: 6, lineHeight: 18 },
    badgeRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      marginTop: 10,
    },
    statusBadge: {
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
    },
    statusBadgeText: { color: c.primary, fontWeight: '600' as const, fontSize: 12, textTransform: 'capitalize' as const },
    nextAmount: { fontSize: 16, fontWeight: '700' as const, color: c.success },
    nextActions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8, marginTop: 14 },
    btn: {
      paddingVertical: 11,
      paddingHorizontal: 14,
      borderRadius: 10,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      flexDirection: 'row' as const,
      gap: 6,
    },
    btnPrimary: { backgroundColor: c.primary },
    btnPrimaryText: { color: c.onPrimary, fontWeight: '700' as const, fontSize: 14 },
    btnOutline: { borderWidth: 1, borderColor: c.error, backgroundColor: c.surface },
    btnOutlineText: { color: c.error, fontWeight: '600' as const },
    btnMaps: { backgroundColor: c.primary },
    btnSuccess: { backgroundColor: c.success },
    emptyNext: { alignItems: 'center' as const, padding: 32 },
    emptyTitle: { fontSize: 17, fontWeight: '600' as const, color: c.text, marginTop: 12 },
    emptySub: { fontSize: 13, color: c.textMuted, textAlign: 'center' as const, marginTop: 6 },
    quickRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-around' as const,
      marginHorizontal: 16,
      marginBottom: 16,
      padding: 12,
      backgroundColor: c.surface,
      borderRadius: 12,
    },
    quickBtn: { alignItems: 'center' as const, gap: 4 },
    quickText: { fontSize: 12, color: c.textSecondary, fontWeight: '600' as const },
    queueSection: { marginHorizontal: 16, marginBottom: 24 },
    queueTitle: { fontSize: 14, fontWeight: '700' as const, color: c.text, marginBottom: 8 },
    queueRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    queueOrder: { fontWeight: '600' as const, color: c.text },
    queueStatus: { color: c.textMuted, textTransform: 'capitalize' as const },
  };
}
