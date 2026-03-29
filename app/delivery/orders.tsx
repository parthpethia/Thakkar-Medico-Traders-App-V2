import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';

type FilterType = 'all' | 'today' | 'to_deliver' | 'delivered';

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

export default function DeliveryOrders() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profileAddresses, setProfileAddresses] = useState<Record<string, string>>({});

  const getTodayRange = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return { start: start.toISOString(), end: end.toISOString() };
  };

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { start, end } = getTodayRange();

      let query = supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filter === 'today') {
        query = query.gte('created_at', start).lte('created_at', end);
      }

      if (filter === 'to_deliver') {
        query = query
          .gte('created_at', start)
          .lte('created_at', end)
          .not('status', 'in', '(delivered,cancelled)');
      }

      if (filter === 'delivered') {
        query = query.eq('status', 'delivered');
      }

      const { data, error } = await query;
      if (error) throw error;

      setOrders(data || []);

      // Fetch latest profile addresses for all retailers
      const userIds = [...new Set((data || []).map((o: any) => o.user_id).filter(Boolean))];
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
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [filter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrders();
    setRefreshing(false);
  }, [filter]);

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
            Alert.alert('Error', error.message);
            return;
          }

          fetchOrders();
        },
      },
    ]);
  };

  const renderActions = (item: Order) => {
    const canEdit = item.status !== 'delivered' && item.status !== 'cancelled';

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
            <Text style={styles.actionBtnText}>Mark Dispatched</Text>
          </TouchableOpacity>
        )}

        {item.status === 'dispatched' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#66BB6A', flex: 1 }]}
            onPress={() => updateStatus(item, 'delivered')}
          >
            <Text style={styles.actionBtnText}>Mark Delivered</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: "Today's Orders" }} />

      <View style={styles.filterRow}>
        <FilterPill title="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterPill title="Today" active={filter === 'today'} onPress={() => setFilter('today')} />
        <FilterPill title="To Deliver" active={filter === 'to_deliver'} onPress={() => setFilter('to_deliver')} />
        <FilterPill title="Delivered" active={filter === 'delivered'} onPress={() => setFilter('delivered')} />
      </View>

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.8}
              onPress={() => router.push(`/order/${item.id}`)}
            >
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderNo}>#{item.order_number}</Text>
                  <Text style={styles.dateText}>
                    {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: statusColor[item.status] || '#777' }]}>
                  <Text style={styles.badgeText}>{item.status}</Text>
                </View>
              </View>

              <Text style={styles.metaText}>{item.user_name || 'Unknown Retailer'} · {item.user_phone || '—'}</Text>
              {(profileAddresses[item.user_id] || item.delivery_address) ? (
                <Text style={styles.addressText} numberOfLines={2}>
                  {profileAddresses[item.user_id] || item.delivery_address}
                </Text>
              ) : null}
              <Text style={styles.totalText}>₹{(item.grand_total || 0).toFixed(2)}</Text>

              {renderActions(item)}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="receipt-outline" size={52} color="#ccc" />
              <Text style={styles.emptyText}>No orders found for today</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function FilterPill({ title, active, onPress }: { title: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.filterPill, active && styles.filterPillActive]}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>{title}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  filterRow: {
    flexDirection: 'row',
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
  emptyWrap: { alignItems: 'center', marginTop: 100 },
  emptyText: { marginTop: 10, color: '#888' },
});
