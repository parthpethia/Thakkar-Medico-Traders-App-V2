import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  ScrollView,
  Modal,
  TextInput,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { supabase } from '../../../src/services/supabase';
import { useAuthStore } from '../../../src/store/authStore';
import { Order, OrderStatus } from '../../../src/types';
import { withRetry } from '../../../src/utils/retryable';
import { trackRpc } from '../../../src/utils/performanceMonitor';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import { driverActionForStatus, driverSecondaryActionForStatus } from '../../../src/constants/orderFlow';
import { useRealtimeOrders } from '../../../src/hooks/useRealtimeOrders';
import { googleMapsDirUrl, resolveOrderCoords } from '../../../src/utils/orderDeliveryCoords';
import { useDeliveryDuty } from '../../../src/hooks/useDeliveryDuty';
import { DeliveryOtpModal } from '../../../src/components/delivery/DeliveryOtpModal';
import { DeliveryFailedModal } from '../../../src/components/delivery/DeliveryFailedModal';
import { ReportReturnModal } from '../../../src/components/delivery/ReportReturnModal';
import { TAB_BAR_LAYOUT, tabScrollBottomPadding } from '../../../src/theme/tabBarTheme';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 20;

type StatusFilter = OrderStatus | 'all' | 'to_deliver' | 'pickup' | 'by_area';  // CHANGED: added by_area

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'to_deliver', label: 'To Deliver' },
  { key: 'by_area', label: 'By Area' },           // CHANGED: FIX D — Area grouping tab
  { key: 'pickup', label: 'Pickup' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'picked_up', label: 'Picked Up' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivery_failed', label: 'Failed' },
  { key: 'delivered', label: 'Delivered' },
];

type AreaSummary = {
  area: string;
  pending_count: number;
  approved_count: number;
  total_orders: number;
  retailer_names: string[];
};

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  assigned: '#5C6BC0',
  accepted: '#00897B',
  picked_up: '#00897B',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
  delivery_failed: '#E53935',
};

type PageCursor = { created_at: string; id: string } | null;

/* ================= SCREEN ================= */

export default function DeliveryOrders() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const nextCursor = useRef<PageCursor>(null);
  const [profileAddresses, setProfileAddresses] = useState<Record<string, string>>({});

  // CHANGED: FIX D — Area grouping state
  const [areaSummary, setAreaSummary] = useState<AreaSummary[]>([]);
  const [loadingAreas, setLoadingAreas] = useState(false);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);

  const [otpModalOrder, setOtpModalOrder] = useState<Order | null>(null);
  const [failedModalOrder, setFailedModalOrder] = useState<Order | null>(null);
  const [returnModalOrder, setReturnModalOrder] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const { isOnDuty, dutyLoading, dutyToggling, loadDutyStatus, toggleOnDuty } = useDeliveryDuty();


  const showToast = useCallback((message: string) => {
    setToast(message);
    toastOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  const fetchOrders = useCallback(async (cursor: PageCursor = null, append = false) => {
    try {
      if (!append) setLoading(true);
      else setIsLoadingMore(true);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      let p_status: string | null = null;
      let p_from_date: string | null = null;
      let p_to_date: string | null = null;

      let rows: Order[] = [];
      let dbError: any = null;

      if (filter === 'pickup' || filter === 'to_deliver') {
        if (!user?.id) {
          setLoading(false);
          return;
        }

        let q = supabase
          .from('orders')
          .select('*')
          .or(`assigned_to.eq.${user.id},created_by.eq.${user.id}`)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);

        if (filter === 'pickup') {
          q = q.or('fulfillment_mode.eq.pickup,delivery_type.eq.pickup');
        } else {
          // to_deliver: all active delivery orders assigned to/created by this rider
          q = q.eq('fulfillment_mode', 'delivery')
               .not('status', 'in', '("delivered","cancelled","rejected","delivery_failed")');
        }

        if (cursor) {
          q = q.lt('created_at', cursor.created_at);
        }

        const res = await withRetry(() => Promise.resolve(q), { retries: 1, delayMs: 300 });
        rows = (res.data || []) as Order[];
        dbError = res.error;
      } else {
        let p_status: string | null = null;
        let p_from_date: string | null = null;
        let p_to_date: string | null = null;

        if (filter === 'by_area') {
          p_from_date = todayStart.toISOString();
          p_to_date = todayEnd.toISOString();
        } else if (filter !== 'all') {
          p_status = filter;
        }

        const res = await withRetry(
          () => trackRpc('get_orders_page', () =>
            supabase.rpc('get_orders_page', {
              p_role: 'delivery',
              p_user_id: null as unknown as string,
              p_status,
              p_cursor: cursor?.created_at ?? null,
              p_cursor_id: cursor?.id ?? null,
              p_page_size: PAGE_SIZE,
              p_from_date,
              p_to_date,
              p_area: selectedArea,
            })
          ),
          { retries: 1, delayMs: 300 },
        );
        rows = (res.data || []) as Order[];
        dbError = res.error;
      }

      if (dbError) throw dbError;

      const filtered = rows;

      if (append) {
        setOrders((prev) => [...prev, ...filtered]);
      } else {
        setOrders(filtered);

        const userIds = [...new Set(filtered.map((o) => o.user_id).filter(Boolean))];
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, address, city, state, pincode')
            .in('id', userIds);

          const addrMap: Record<string, string> = {};
          (profiles || []).forEach((p: any) => {
            const fullAddr = [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ');
            if (fullAddr.trim()) addrMap[p.id] = fullAddr;
          });
          setProfileAddresses(addrMap);
        }
      }

      if (rows.length < PAGE_SIZE) {
        setHasMore(false);
        nextCursor.current = null;
      } else {
        const last = rows[rows.length - 1];
        nextCursor.current = { created_at: last.created_at, id: last.id };
        setHasMore(true);
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to fetch orders');
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  }, [filter, selectedArea]);

  const uid = user?.id;
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    filter: uid ? `assigned_to=eq.${uid}` : undefined,
    enabled: !!uid,
    onUpdate: () => {
      nextCursor.current = null;
      setHasMore(true);
      void fetchOrders(null, false);
    },
  });

  // CHANGED: FIX D — Fetch area summary
  const fetchAreaSummary = useCallback(async () => {
    setLoadingAreas(true);
    try {
      const { data, error } = await supabase.rpc('get_delivery_summary', {});
      if (error) throw error;
      setAreaSummary((data || []) as AreaSummary[]);
    } catch (err: any) {
      console.error('Area summary error:', err.message);
    } finally {
      setLoadingAreas(false);
    }
  }, []);

  useEffect(() => {
    nextCursor.current = null;
    setHasMore(true);
    if (filter === 'by_area' && !selectedArea) {
      fetchAreaSummary();
    } else {
      fetchOrders(null, false);
    }
  }, [filter, selectedArea]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    nextCursor.current = null;
    setHasMore(true);
    await Promise.all([fetchOrders(null, false), loadDutyStatus()]);
    setRefreshing(false);
  }, [fetchOrders, loadDutyStatus]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

  const filteredOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return orders;
    return orders.filter((o) => {
      const matchNo = (o.order_number || '').toLowerCase().includes(query);
      const matchName = (o.user_name || '').toLowerCase().includes(query);
      const matchPhone = (o.user_phone || '').toLowerCase().includes(query);
      const matchAddr = (profileAddresses[o.user_id] || o.delivery_address || '').toLowerCase().includes(query);
      return matchNo || matchName || matchPhone || matchAddr;
    });
  }, [orders, searchQuery, profileAddresses]);

  const updateStatus = async (order: Order, newStatus: OrderStatus) => {
    const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

    Alert.alert('Update Delivery Status', `Mark #${order.order_number} as ${label}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          const { error } = await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', order.id);

          if (error) {
            if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
              Alert.alert('Invalid Transition', 'This status change is not allowed. The order may have been updated by someone else.');
            } else {
              Alert.alert('Error', error.message);
            }
            return;
          }

          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
        },
      },
    ]);
  };

  const renderActions = (item: Order) => {
    const isPickup =
      (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';
    const action = driverActionForStatus(item.status, item.fulfillment_mode);

    const navigate = async () => {
      const coords = await resolveOrderCoords(supabase, item);
      if (!coords) {
        Alert.alert('No GPS', 'No coordinates on this order.');
        return;
      }
      const url = googleMapsDirUrl(coords.lat, coords.lng, coords.address || item.delivery_address);
      if (!url) {
        Alert.alert('Error', 'Could not generate a navigation URL. Address may be incomplete.');
        return;
      }
      Linking.openURL(url).catch(() =>
        Alert.alert('Error', 'Could not open maps'),
      );
    };

    return (
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {action === 'accept' && (
          <>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
              onPress={async () => {
                const { error } = await supabase.rpc('delivery_accept_order', {
                  p_order_id: item.id,
                });
                if (error) {
                  Alert.alert('Error', error.message);
                  return;
                }
                fetchOrders(null, false);
              }}
            >
              <Text style={styles.actionBtnText}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.error, flex: 1 }]}
              onPress={() => {
                Alert.alert('Decline?', `Order #${item.order_number}`, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Decline',
                    style: 'destructive',
                    onPress: async () => {
                      const { error } = await supabase.rpc('delivery_reject_order', {
                        p_order_id: item.id,
                        p_reason: null,
                      });
                      if (!error) fetchOrders(null, false);
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.actionBtnText}>Decline</Text>
            </TouchableOpacity>
          </>
        )}

        {action === 'mark_picked_up' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.primary, flex: 1 }]}
            onPress={() => updateStatus(item, 'picked_up')}
          >
            <Text style={styles.actionBtnText}>Mark picked up</Text>
          </TouchableOpacity>
        )}

        {action === 'mark_dispatched' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
            onPress={() => updateStatus(item, 'dispatched')}
          >
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Ready for Pickup' : 'Mark dispatched'}
            </Text>
          </TouchableOpacity>
        )}

        {action === 'mark_delivered' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
            onPress={() => setOtpModalOrder(item)}
          >
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Mark collected' : 'Mark delivered'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Can't Deliver button on dispatched orders */}
        {driverSecondaryActionForStatus(item.status) === 'report_failed' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.error, flex: 1 }]}
            onPress={() => setFailedModalOrder(item)}
          >
            <Text style={styles.actionBtnText}>Can't Deliver</Text>
          </TouchableOpacity>
        )}

        {(item.status === 'picked_up' || item.status === 'dispatched') && !isPickup && (
          <>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#1565C0', flex: 1 }]}
              onPress={() => router.push(`/delivery/active-delivery?orderId=${item.id}`)}
            >
              <Text style={styles.actionBtnText}>Live Track</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.primary, paddingHorizontal: 12 }]}
              onPress={() => void navigate()}
            >
              <Text style={styles.actionBtnText}>Maps</Text>
            </TouchableOpacity>
          </>
        )}

        {['assigned', 'accepted', 'pending', 'approved', 'packed'].includes(item.status) && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.textSecondary, flex: 1 }]}
            onPress={() => router.push(`/delivery/edit-order?orderId=${item.id}`)}
          >
            <Text style={styles.actionBtnText}>Edit Items</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      );
    }
    if (!hasMore && orders.length > 0) {
      return (
        <View style={styles.footerLoader}>
          <Text style={styles.allLoadedText}>All orders loaded</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.dutyCard}>
        <View style={styles.dutyTextCol}>
          <Text style={styles.dutyTitle}>
            {isOnDuty ? 'You are ON duty' : 'You are OFF duty'}
          </Text>
          <Text style={styles.dutySubtext}>
            {isOnDuty
              ? 'Admins can assign new orders to you'
              : 'Turn on when you are available for deliveries'}
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

      <View style={{ backgroundColor: colors.surface }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {statusFilters.map((f) => (
            <TouchableOpacity
              key={f.key}
              onPress={() => { setFilter(f.key); setSelectedArea(null); }}
              style={[styles.filterPill, filter === f.key && styles.filterPillActive]}
            >
              <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Order Search Bar */}
      {filter !== 'by_area' && (
        <View style={styles.searchSection}>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search orders by number, retailer or phone"
              placeholderTextColor={colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} style={{ padding: 4 }}>
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* CHANGED: FIX D — Show area header when filtering by area */}
      {filter === 'by_area' && selectedArea && (
        <TouchableOpacity
          style={styles.areaBackRow}
          onPress={() => setSelectedArea(null)}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primary} />
          <Text style={styles.areaBackText}>Back to areas</Text>
          <View style={styles.areaFilterBadge}>
            <Ionicons name="location" size={12} color={colors.onPrimary} />
            <Text style={styles.areaFilterBadgeText}>{selectedArea}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* CHANGED: FIX D — Area view when By Area is selected and no area chosen */}
      {filter === 'by_area' && !selectedArea ? (
        loadingAreas ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, ...tabScrollBottomPadding() }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAreaSummary().then(() => setRefreshing(false)); }} />}
          >
            {areaSummary.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="map-outline" size={52} color={colors.switchThumbOff} />
                <Text style={styles.emptyText}>No delivery orders for today</Text>
              </View>
            ) : (
              areaSummary.map((area) => (
                <TouchableOpacity
                  key={area.area}
                  style={styles.areaCard}
                  onPress={() => setSelectedArea(area.area)}
                >
                  <View style={styles.areaHeader}>
                    <Ionicons name="location" size={18} color={colors.primary} />
                    <Text style={styles.areaName}>{area.area}</Text>
                    <View style={styles.areaCountBadge}>
                      <Text style={styles.areaCountText}>{area.total_orders}</Text>
                    </View>
                  </View>
                  <View style={styles.areaStats}>
                    <Text style={styles.areaStat}>
                      Pending: <Text style={{ fontWeight: '700', color: colors.warning }}>{area.pending_count}</Text>
                    </Text>
                    <Text style={styles.areaStat}>
                      Ready: <Text style={{ fontWeight: '700', color: colors.success }}>{area.approved_count}</Text>
                    </Text>
                  </View>
                  <View style={styles.areaChips}>
                    {area.retailer_names.slice(0, 4).map((name, i) => (
                      <View key={i} style={styles.retailerChip}>
                        <Text style={styles.retailerChipText} numberOfLines={1}>{name}</Text>
                      </View>
                    ))}
                    {area.retailer_names.length > 4 && (
                      <View style={styles.retailerChip}>
                        <Text style={styles.retailerChipText}>+{area.retailer_names.length - 4}</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        )
      ) : loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredOrders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, ...tabScrollBottomPadding() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          renderItem={({ item }) => {
            const isPickup = (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';

            return (
              <TouchableOpacity
                style={[styles.card, { borderLeftWidth: 4, borderLeftColor: statusColor[item.status] || colors.textMuted }]}
                activeOpacity={0.8}
                onPress={() => router.push(`/delivery/${item.id}`)}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={styles.orderNo}>#{item.order_number}</Text>
                      {item.assigned_to === user?.id ? (
                        <View style={styles.assignedToYouBadge}>
                          <Ionicons name="person" size={10} color={colors.onPrimary} />
                          <Text style={styles.assignedToYouText}>Assigned to you</Text>
                        </View>
                      ) : item.created_by === user?.id ? (
                        <View style={[styles.assignedToYouBadge, { backgroundColor: colors.warning || '#f59e0b' }]}>
                          <Ionicons name="create" size={10} color={colors.onPrimary} />
                          <Text style={styles.assignedToYouText}>Created by you</Text>
                        </View>
                      ) : null}
                      {/* CHANGED: FIX C — PICKUP badge */}
                      {isPickup && (
                        <View style={styles.pickupBadge}>
                          <Ionicons name="storefront" size={10} color={colors.onPrimary} />
                          <Text style={styles.pickupBadgeText}>PICKUP</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.dateText}>
                      {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: statusColor[item.status] || colors.textMuted }]}>
                    <Text style={styles.badgeText}>{item.status}</Text>
                  </View>
                </View>

                <Text style={styles.metaText}>{item.user_name || 'Unknown Retailer'} · {item.user_phone || '—'}</Text>
                {!isPickup && (profileAddresses[item.user_id] || item.delivery_address) ? (
                  <Text style={styles.addressText} numberOfLines={2}>
                    {profileAddresses[item.user_id] || item.delivery_address}
                  </Text>
                ) : null}
                <Text style={styles.totalText}>₹{(item.grand_total || 0).toFixed(2)}</Text>

                {renderActions(item)}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="receipt-outline" size={52} color={colors.switchThumbOff} />
              <Text style={styles.emptyText}>No orders found</Text>
            </View>
          }
        />
      )}
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
          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
        }}
        showToast={showToast}
        onCantDeliver={() => {
          const o = otpModalOrder;
          setOtpModalOrder(null);
          if (o) setFailedModalOrder(o);
        }}
        onReportIssue={() => {
          const o = otpModalOrder;
          setOtpModalOrder(null);
          if (o) setReturnModalOrder(o);
        }}
      />
      <DeliveryFailedModal
        visible={!!failedModalOrder}
        order={failedModalOrder}
        onClose={() => setFailedModalOrder(null)}
        onSuccess={() => {
          setFailedModalOrder(null);
          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
        }}
        showToast={showToast}
      />
      <ReportReturnModal
        visible={!!returnModalOrder}
        order={returnModalOrder}
        onClose={() => setReturnModalOrder(null)}
        onSuccess={() => {
          setReturnModalOrder(null);
          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
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

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  dutyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
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
  dutyTextCol: { flex: 1, marginRight: 12 },
  dutyTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  dutySubtext: { fontSize: 12, color: c.textSecondary, marginTop: 4, lineHeight: 16 },
  filterRow: {
    flexDirection: 'row' as const,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  searchSection: {
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  searchWrap: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    backgroundColor: c.background,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    borderWidth: 1,
    borderColor: c.border,
  },
  searchInput: {
    flex: 1,
    color: c.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  filterPillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  filterText: { color: c.textSecondary, fontSize: 13, fontWeight: '500' },
  filterTextActive: { color: c.onPrimary, fontWeight: '700' },
  card: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  orderNo: { fontSize: 18, fontWeight: '800', color: c.text },
  dateText: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: c.onPrimary, fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  metaText: { marginTop: 10, color: c.text, fontSize: 15, fontWeight: '700' },
  addressText: { marginTop: 4, color: c.textMuted, fontSize: 12, lineHeight: 16 },
  totalText: { marginTop: 8, color: c.text, fontWeight: '800', fontSize: 15 },
  actionBtn: {
    marginTop: 12,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionBtnText: { color: c.surface, fontWeight: '700' },
  footerLoader: { paddingVertical: 16, alignItems: 'center' },
  allLoadedText: { fontSize: 13, color: c.textMuted, fontWeight: '500' },
  emptyWrap: { alignItems: 'center', marginTop: 100 },
  emptyText: { marginTop: 10, color: c.textMuted, fontSize: 14, fontWeight: '500' },

  /* CHANGED: FIX C — Pickup badge */
  pickupBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.primary,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pickupBadgeText: {
    color: c.surface,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  assignedToYouBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.primary,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  assignedToYouText: {
    color: c.surface,
    fontSize: 9,
    fontWeight: '700',
  },

  /* CHANGED: FIX D — Area grouping styles */
  areaCard: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  areaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  areaName: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
    flex: 1,
  },
  areaCountBadge: {
    backgroundColor: c.primary,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  areaCountText: {
    color: c.surface,
    fontSize: 13,
    fontWeight: '700',
  },
  areaStats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 8,
    marginLeft: 26,
  },
  areaStat: {
    fontSize: 13,
    color: c.textSecondary,
    fontWeight: '500',
  },
  areaChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
    marginLeft: 26,
  },
  retailerChip: {
    backgroundColor: c.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  retailerChipText: {
    fontSize: 11,
    color: c.primary,
    fontWeight: '600',
    maxWidth: 100,
  },
  areaBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  areaBackText: {
    fontSize: 13,
    color: c.primary,
    fontWeight: '600',
    flex: 1,
  },
  areaFilterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  areaFilterBadgeText: {
    color: c.surface,
    fontSize: 11,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: c.text },
  modalSubtext: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
  sendStatusText: { fontSize: 13, color: c.success, marginBottom: 8 },
  sendWarningText: { fontSize: 13, color: c.warning, marginBottom: 8, lineHeight: 18 },
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginVertical: 16,
  },
  otpBox: {
    width: 52,
    height: 56,
    borderWidth: 2,
    borderColor: c.primary,
    borderRadius: 10,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
  },
  otpBoxDisabled: {
    borderColor: c.switchThumbOff,
    backgroundColor: c.background,
    color: c.textMuted,
  },
  verifyErrorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
  confirmOtpBtn: {
    backgroundColor: c.success,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  confirmOtpBtnDisabled: { opacity: 0.5 },
  resendLink: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  resendLinkText: { color: c.primary, fontSize: 14, fontWeight: '600' },
  toast: {
    position: 'absolute',
    bottom: 32,
    left: 24,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.success,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    elevation: 4,
  },
  toastText: { color: c.surface, fontWeight: '600', fontSize: 14, flex: 1 },
  } as const;
}
