import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
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
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAuthStore } from '../../../src/store/authStore';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import { Order, OrderStatus } from '../../../src/types';
import { runSheetPriority } from '../../../src/constants/orderFlow';
import {
  googleMapsDirUrl,
  resolveOrderCoords,
} from '../../../src/utils/orderDeliveryCoords';
import { useRealtimeOrders } from '../../../src/hooks/useRealtimeOrders';
import { useDeliveryDuty } from '../../../src/hooks/useDeliveryDuty';
import { DeliveryOtpModal } from '../../../src/components/delivery/DeliveryOtpModal';
import { tabScrollBottomPadding } from '../../../src/theme/tabBarTheme';

const ACTIVE_STATUSES: OrderStatus[] = [
  'assigned',
  'accepted',
  'picked_up',
  'dispatched',
  'out_for_delivery',
  'in_transit',
  'arriving_soon',
  'processing',
];

export default function DeliveryDashboard() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const { isOnDuty, dutyLoading, dutyToggling, loadDutyStatus, toggleOnDuty } = useDeliveryDuty();
  const [nextCoords, setNextCoords] = useState<{ lat: number; lng: number; address?: string } | null>(null);

  const [otpModalOrder, setOtpModalOrder] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [totalCollectedToday, setTotalCollectedToday] = useState(0);

  const fetchCollectionSummary = useCallback(async () => {
    try {
      if (!user?.id) return;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data, error } = await supabase
        .from('delivery_collections')
        .select('amount')
        .eq('collected_by', user.id)
        .gte('collected_at', todayStart.toISOString())
        .neq('status', 'refunded');

      if (!error && data) {
        const total = data.reduce((sum, item) => sum + Number(item.amount), 0);
        setTotalCollectedToday(total);
      }
    } catch (e) {
      console.warn('Failed to load collections summary:', e);
    }
  }, [user?.id]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    toastOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);


  const fetchRunSheet = useCallback(async () => {
    try {
      if (!user?.id) return;
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .or(`assigned_to.eq.${user.id},created_by.eq.${user.id}`)
        .eq('fulfillment_mode', 'delivery')
        .in('status', ACTIVE_STATUSES);

      if (error) throw error;

      const rows = (data || []) as Order[];

      rows.sort((a, b) => {
        // 1. Sort by Priority (Urgent first)
        const pA = a.priority ?? 3;
        const pB = b.priority ?? 3;
        if (pA !== pB) return pA - pB;

        // 2. Sort by Order Status Priority
        const statDiff = runSheetPriority(a.status) - runSheetPriority(b.status);
        if (statDiff !== 0) return statDiff;

        // 3. Sort by SLA deadline (soonest first)
        if (a.sla_deadline && b.sla_deadline) {
          return new Date(a.sla_deadline).getTime() - new Date(b.sla_deadline).getTime();
        }

        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      setOrders(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load run sheet';
      Alert.alert('Error', msg);
    }
  }, [user?.id]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchRunSheet(), loadDutyStatus(), fetchCollectionSummary()]);
  }, [fetchRunSheet, loadDutyStatus, fetchCollectionSummary]);

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
        setNextCoords(coords ? { lat: coords.lat, lng: coords.lng, address: coords.address } : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nextStop?.id, nextStop?.delivery_address_id]);


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
    if (Alert.prompt) {
      Alert.prompt(
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
    } else {
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
            if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
              Alert.alert('Invalid Transition', 'This status change is not allowed. The order may have been updated by someone else.');
            } else {
              Alert.alert('Error', error.message);
            }
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
    const url = googleMapsDirUrl(nextCoords.lat, nextCoords.lng, nextCoords.address || nextStop?.delivery_address);
    if (!url) {
      Alert.alert('Error', 'Could not generate a navigation URL. Address may be incomplete.');
      return;
    }
    Linking.openURL(url).catch(() =>
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
        contentContainerStyle={tabScrollBottomPadding(16)}
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
              onValueChange={(v) => void toggleOnDuty(v)}
              disabled={dutyToggling}
              trackColor={{ false: colors.switchTrackOff, true: colors.primaryMuted }}
              thumbColor={isOnDuty ? colors.switchThumbOn : colors.switchThumbOff}
            />
          )}
        </View>

        {/* Collections Summary Card */}
        <View style={styles.collectionCard}>
          <Ionicons name="wallet" size={22} color={colors.success} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.collectionTitle}>Daily Collections</Text>
            <Text style={styles.collectionValue}>₹{totalCollectedToday.toFixed(2)}</Text>
          </View>
        </View>

        {nextStop ? (
          <TouchableOpacity
            style={styles.nextCard}
            activeOpacity={0.92}
            onPress={() => router.push(`/delivery/${nextStop.id}`)}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.nextLabel}>Next stop · Tap for details</Text>
              <View style={styles.nextOrderNoBadge}>
                <Text style={styles.nextOrderNoText}>ORDER #{nextStop.order_number}</Text>
              </View>
            </View>
            <Text style={styles.nextTitle}>
              {nextStop.user_name}
            </Text>
            <Text style={styles.nextMeta} numberOfLines={2}>
              {nextStop.delivery_address || '—'}
            </Text>
            <View style={styles.badgeRow}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <View style={styles.statusBadge}>
                  <Text style={styles.statusBadgeText}>{nextStop.status}</Text>
                </View>
                {nextStop.priority === 1 && (
                  <View style={[styles.priorityBadge, { backgroundColor: colors.error }]}>
                    <Text style={styles.priorityText}>URGENT</Text>
                  </View>
                )}
                {nextStop.priority === 2 && (
                  <View style={[styles.priorityBadge, { backgroundColor: colors.warning }]}>
                    <Text style={styles.priorityText}>HIGH</Text>
                  </View>
                )}
              </View>
              <Text style={styles.nextAmount}>₹{(nextStop.grand_total || 0).toFixed(0)}</Text>
            </View>

            {nextStop.sla_deadline && (
              <Text style={{ fontSize: 11, fontWeight: '700', color: colors.error, marginTop: 8 }}>
                ⏱️ SLA Countdown: {new Date(nextStop.sla_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            )}

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
                <>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnLiveTracker, { flex: 1 }]}
                    onPress={() => router.push(`/delivery/active-delivery?orderId=${nextStop.id}`)}
                  >
                    <Ionicons name="navigate" size={18} color={colors.onPrimary} />
                    <Text style={styles.btnPrimaryText}>Live Navigation</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnMaps, { paddingHorizontal: 12 }]}
                    onPress={openNavigate}
                  >
                    <Ionicons name="map" size={18} color={colors.onPrimary} />
                    <Text style={styles.btnPrimaryText}>Maps</Text>
                  </TouchableOpacity>
                </>
              )}
              {nextStop.status === 'dispatched' && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnSuccess, { flex: 1 }]}
                  onPress={() => setOtpModalOrder(nextStop)}
                >
                  <Text style={styles.btnPrimaryText}>Confirm Delivery</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[styles.btn, styles.btnNextOrder]}
              onPress={() => router.push(`/delivery/create-order-items?retailerId=${nextStop.user_id}`)}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle" size={18} color={colors.primary} />
              <Text style={styles.btnNextOrderText}>Collect Next Order</Text>
            </TouchableOpacity>
          </TouchableOpacity>
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
          {nextStop && (nextStop.status === 'dispatched' || nextStop.status === 'picked_up') && (
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => router.push(`/delivery/active-delivery?orderId=${nextStop.id}`)}
            >
              <Ionicons name="navigate-circle-outline" size={20} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.primary }]}>Live Map</Text>
            </TouchableOpacity>
          )}
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
                onPress={() => router.push(`/delivery/${o.id}`)}
              >
                <Text style={styles.queueOrder}>#{o.order_number}</Text>
                <Text style={styles.queueStatus}>{o.status}</Text>
              </TouchableOpacity>
            ))}
            {orders.length > 6 && (
              <TouchableOpacity
                style={styles.queueRow}
                onPress={() => router.push('/delivery/orders')}
              >
                <Text style={[styles.queueOrder, { color: colors.primary }]}>View all {orders.length} orders →</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>

      <DeliveryOtpModal
        visible={!!otpModalOrder}
        order={otpModalOrder}
        isPickup={
          !!otpModalOrder &&
          ((otpModalOrder as any).fulfillment_mode === 'pickup' ||
            otpModalOrder.delivery_type === 'pickup')
        }
        onClose={() => setOtpModalOrder(null)}
        onSuccess={() => {
          setOtpModalOrder(null);
          void fetchRunSheet();
        }}
        showToast={showToast}
      />

      {toast ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Ionicons name="checkmark-circle" size={18} color={colors.onPrimary} />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    header: {
      paddingHorizontal: 20,
      paddingVertical: 18,
      backgroundColor: c.surface,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { fontSize: 24, fontWeight: '800' as const, color: c.text, letterSpacing: -0.5 },
    subtitle: { fontSize: 13, color: c.textSecondary, marginTop: 2, fontWeight: '500' },
    dutyCard: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      margin: 16,
      padding: 16,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 6,
      elevation: 2,
    },
    dutyTitle: { fontSize: 15, fontWeight: '700' as const, color: c.text },
    dutySub: { fontSize: 12, color: c.textSecondary, marginTop: 4, lineHeight: 16 },
    nextCard: {
      marginHorizontal: 16,
      marginBottom: 16,
      padding: 16,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      borderLeftWidth: 4,
      borderLeftColor: c.primary,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 3,
    },
    nextLabel: { fontSize: 11, fontWeight: '700' as const, color: c.primary, textTransform: 'uppercase' as const, letterSpacing: 0.8 },
    nextOrderNoBadge: {
      backgroundColor: c.primary,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    nextOrderNoText: {
      color: c.onPrimary || '#FFFFFF',
      fontSize: 11,
      fontWeight: '800',
    },
    nextTitle: { fontSize: 22, fontWeight: '800' as const, color: c.text, marginTop: 8 },
    nextMeta: { fontSize: 13, color: c.textSecondary, marginTop: 6, lineHeight: 18 },
    badgeRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      marginTop: 12,
    },
    statusBadge: {
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
    },
    statusBadgeText: { color: c.primary, fontWeight: '700' as const, fontSize: 11, textTransform: 'capitalize' as const },
    nextAmount: { fontSize: 16, fontWeight: '800' as const, color: c.success },
    nextActions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8, marginTop: 14 },
    btn: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 10,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      flexDirection: 'row' as const,
      gap: 6,
    },
    btnPrimary: { backgroundColor: c.primary },
    btnPrimaryText: { color: c.onPrimary, fontWeight: '700' as const, fontSize: 14 },
    btnOutline: { borderWidth: 1, borderColor: c.error, backgroundColor: c.surface },
    btnOutlineText: { color: c.error, fontWeight: '700' as const },
    btnMaps: { backgroundColor: c.primary },
    btnLiveTracker: { backgroundColor: '#1565C0' },
    btnSuccess: { backgroundColor: c.success },
    btnNextOrder: {
      borderWidth: 1,
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
      marginTop: 10,
    },
    btnNextOrderText: { color: c.primary, fontWeight: '700' as const, fontSize: 14 },
    emptyNext: {
      alignItems: 'center' as const,
      padding: 32,
      backgroundColor: c.surface,
      margin: 16,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
    },
    emptyTitle: { fontSize: 17, fontWeight: '700' as const, color: c.text, marginTop: 12 },
    emptySub: { fontSize: 13, color: c.textMuted, textAlign: 'center' as const, marginTop: 6, lineHeight: 18 },
    quickRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-around' as const,
      marginHorizontal: 16,
      marginBottom: 20,
      padding: 14,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 6,
      elevation: 2,
    },
    quickBtn: { alignItems: 'center' as const, gap: 4 },
    quickText: { fontSize: 12, color: c.textSecondary, fontWeight: '700' as const },
    queueSection: { marginHorizontal: 16, marginBottom: 24 },
    queueTitle: { fontSize: 14, fontWeight: '800' as const, color: c.text, marginBottom: 10, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
    queueRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    queueOrder: { fontWeight: '600' as const, color: c.text, fontSize: 14 },
    queueStatus: { color: c.textMuted, textTransform: 'capitalize' as const, fontSize: 13, fontWeight: '500' },
    toast: {
      position: 'absolute',
      bottom: 32,
      left: 24,
      right: 24,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      backgroundColor: c.success,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 10,
      elevation: 4,
    },
    toastText: { color: c.surface, fontWeight: '700' as const, fontSize: 14, flex: 1 },
    collectionCard: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginHorizontal: 16,
      marginBottom: 16,
      padding: 14,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 6,
      elevation: 2,
    },
    collectionTitle: { fontSize: 13, fontWeight: '700' as const, color: c.textSecondary },
    collectionValue: { fontSize: 16, fontWeight: '800' as const, color: c.success, marginTop: 2 },
    priorityBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
    },
    priorityText: {
      fontSize: 9,
      fontWeight: '900' as const,
      color: '#FFFFFF',
    },
  } as const;
}
