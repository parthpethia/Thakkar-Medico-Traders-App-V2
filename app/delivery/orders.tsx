import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { withRetry } from '../../src/utils/retryable';
import { trackRpc } from '../../src/utils/performanceMonitor';
import { useTranslation } from 'react-i18next';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 20;

type StatusFilter = OrderStatus | 'all' | 'to_deliver' | 'pickup' | 'by_area';  // CHANGED: added by_area

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'to_deliver', label: 'To Deliver' },
  { key: 'by_area', label: 'By Area' },           // CHANGED: FIX D — Area grouping tab
  { key: 'pickup', label: 'Pickup' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
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
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

type PageCursor = { created_at: string; id: string } | null;

/* ================= SCREEN ================= */

export default function DeliveryOrders() {
  const { t } = useTranslation();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
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

      if (filter === 'to_deliver') {
        p_from_date = todayStart.toISOString();
        p_to_date = todayEnd.toISOString();
      } else if (filter === 'pickup') {
        // CHANGED: FIX C — pickup filter handled client-side
      } else if (filter !== 'all') {
        p_status = filter;
      }

      const { data, error } = await withRetry(
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
            p_area: selectedArea,  // CHANGED: FIX D — area filter
          })
        ),
        { retries: 1, delayMs: 300 },
      );

      if (error) throw error;

      const rows = (data || []) as Order[];

      // Client-side filtering
      let filtered = rows;
      if (filter === 'to_deliver') {
        filtered = rows.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
      } else if (filter === 'pickup') {
        // CHANGED: FIX C — filter to pickup orders only
        filtered = rows.filter(
          (o) => (o as any).fulfillment_mode === 'pickup' || o.delivery_type === 'pickup',
        );
      }

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
    await fetchOrders(null, false);
    setRefreshing(false);
  }, [fetchOrders]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

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
    const canEdit = item.status === 'pending' || item.status === 'approved';
    const isPickup = (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';

    return (
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {canEdit && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#4C51C9', flex: 1 }]}
            onPress={(e) => {
              e.stopPropagation?.();
              router.push(`/delivery/edit-order?orderId=${item.id}`);
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="create-outline" size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Edit Order</Text>
            </View>
          </TouchableOpacity>
        )}

        {item.status === 'packed' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#26A69A', flex: 1 }]}
            onPress={() => updateStatus(item, 'dispatched')}
          >
            {/* CHANGED: FIX C — For pickup orders, show "Ready for Pickup" */}
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Ready for Pickup' : 'Mark Dispatched'}
            </Text>
          </TouchableOpacity>
        )}

        {item.status === 'dispatched' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#66BB6A', flex: 1 }]}
            onPress={() => updateStatus(item, 'delivered')}
          >
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Mark Collected' : 'Mark Delivered'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color="#4C51C9" />
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
      <Stack.Screen options={{ title: t('delivery.title') }} />

      <View style={styles.filterRow}>
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
      </View>

      {/* CHANGED: FIX D — Show area header when filtering by area */}
      {filter === 'by_area' && selectedArea && (
        <TouchableOpacity
          style={styles.areaBackRow}
          onPress={() => setSelectedArea(null)}
        >
          <Ionicons name="arrow-back" size={18} color="#4C51C9" />
          <Text style={styles.areaBackText}>Back to areas</Text>
          <View style={styles.areaFilterBadge}>
            <Ionicons name="location" size={12} color="#fff" />
            <Text style={styles.areaFilterBadgeText}>{selectedArea}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* CHANGED: FIX D — Area view when By Area is selected and no area chosen */}
      {filter === 'by_area' && !selectedArea ? (
        loadingAreas ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#4C51C9" />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAreaSummary().then(() => setRefreshing(false)); }} />}
          >
            {areaSummary.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="map-outline" size={52} color="#ccc" />
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
                    <Ionicons name="location" size={18} color="#4C51C9" />
                    <Text style={styles.areaName}>{area.area}</Text>
                    <View style={styles.areaCountBadge}>
                      <Text style={styles.areaCountText}>{area.total_orders}</Text>
                    </View>
                  </View>
                  <View style={styles.areaStats}>
                    <Text style={styles.areaStat}>
                      Pending: <Text style={{ fontWeight: '700', color: '#FFA726' }}>{area.pending_count}</Text>
                    </Text>
                    <Text style={styles.areaStat}>
                      Ready: <Text style={{ fontWeight: '700', color: '#66BB6A' }}>{area.approved_count}</Text>
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
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          renderItem={({ item }) => {
            const isPickup = (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.8}
                onPress={() => router.push(`/order/${item.id}`)}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.orderNo}>#{item.order_number}</Text>
                      {/* CHANGED: FIX C — PICKUP badge */}
                      {isPickup && (
                        <View style={styles.pickupBadge}>
                          <Ionicons name="storefront" size={10} color="#fff" />
                          <Text style={styles.pickupBadgeText}>PICKUP</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.dateText}>
                      {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: statusColor[item.status] || '#777' }]}>
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
              <Ionicons name="receipt-outline" size={52} color="#ccc" />
              <Text style={styles.emptyText}>No orders found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  filterPillActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  filterText: { color: '#555', fontSize: 13 },
  filterTextActive: { color: '#fff', fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  orderNo: { fontSize: 15, fontWeight: '700', color: '#333' },
  dateText: { fontSize: 12, color: '#777', marginTop: 2 },
  badge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  metaText: { marginTop: 10, color: '#666', fontSize: 13 },
  addressText: { marginTop: 4, color: '#888', fontSize: 12 },
  totalText: { marginTop: 6, color: '#333', fontWeight: '700', fontSize: 15 },
  actionBtn: {
    marginTop: 12,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionBtnText: { color: '#fff', fontWeight: '700' },
  footerLoader: { paddingVertical: 16, alignItems: 'center' },
  allLoadedText: { fontSize: 13, color: '#999' },
  emptyWrap: { alignItems: 'center', marginTop: 100 },
  emptyText: { marginTop: 10, color: '#888' },

  /* CHANGED: FIX C — Pickup badge */
  pickupBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#7E57C2',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pickupBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  /* CHANGED: FIX D — Area grouping styles */
  areaCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  areaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  areaName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    flex: 1,
  },
  areaCountBadge: {
    backgroundColor: '#4C51C9',
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  areaCountText: {
    color: '#fff',
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
    color: '#666',
  },
  areaChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
    marginLeft: 26,
  },
  retailerChip: {
    backgroundColor: '#F3F3FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  retailerChipText: {
    fontSize: 11,
    color: '#4C51C9',
    fontWeight: '500',
    maxWidth: 100,
  },
  areaBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  areaBackText: {
    fontSize: 13,
    color: '#4C51C9',
    fontWeight: '500',
    flex: 1,
  },
  areaFilterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  areaFilterBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
});
