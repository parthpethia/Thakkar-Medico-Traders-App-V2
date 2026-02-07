import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Order, OrderStatus } from '../../src/types';
import api from '../../src/services/api';
import { format } from 'date-fns';

const statusFilters: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
];

const statusConfig: Record<OrderStatus, { color: string; icon: keyof typeof Ionicons.glyphMap; nextStatus?: OrderStatus }> = {
  pending: { color: '#FFA726', icon: 'time', nextStatus: 'approved' },
  approved: { color: '#42A5F5', icon: 'checkmark-circle', nextStatus: 'packed' },
  packed: { color: '#7E57C2', icon: 'cube', nextStatus: 'dispatched' },
  dispatched: { color: '#26A69A', icon: 'car', nextStatus: 'delivered' },
  delivered: { color: '#66BB6A', icon: 'checkmark-done' },
  cancelled: { color: '#EF5350', icon: 'close-circle' },
};

export default function AdminOrders() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | 'all'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      let url = '/orders?limit=100';
      if (selectedStatus !== 'all') url += `&status=${selectedStatus}`;
      
      const response = await api.get(url);
      setOrders(response.data);
    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [selectedStatus]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrders();
    setRefreshing(false);
  }, [selectedStatus]);

  const handleUpdateStatus = async (order: Order, newStatus: OrderStatus) => {
    Alert.alert(
      'Update Status',
      `Change order status to ${newStatus.toUpperCase()}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Update',
          onPress: async () => {
            try {
              await api.put(`/orders/${order.id}/status`, { status: newStatus });
              Alert.alert('Success', 'Order status updated');
              fetchOrders();
            } catch (error: any) {
              Alert.alert('Error', error.response?.data?.detail || 'Failed to update status');
            }
          },
        },
      ]
    );
  };

  const renderOrder = ({ item }: { item: Order }) => {
    const config = statusConfig[item.status];
    const itemCount = item.items.reduce((sum, i) => sum + i.quantity, 0);
    
    return (
      <View style={styles.orderCard}>
        <TouchableOpacity 
          style={styles.orderHeader}
          onPress={() => router.push(`/order/${item.id}`)}
        >
          <View>
            <Text style={styles.orderNumber}>#{item.order_number}</Text>
            <Text style={styles.orderDate}>
              {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
            </Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: config.color }]}>
            <Ionicons name={config.icon} size={14} color="#fff" />
            <Text style={styles.statusText}>{item.status.toUpperCase()}</Text>
          </View>
        </TouchableOpacity>
        
        <View style={styles.orderDetails}>
          <View style={styles.detailItem}>
            <Ionicons name="person-outline" size={16} color="#666" />
            <Text style={styles.detailText}>{item.user_name}</Text>
          </View>
          <View style={styles.detailItem}>
            <Ionicons name="call-outline" size={16} color="#666" />
            <Text style={styles.detailText}>{item.user_phone}</Text>
          </View>
          <View style={styles.detailItem}>
            <Ionicons name="cube-outline" size={16} color="#666" />
            <Text style={styles.detailText}>{itemCount} items</Text>
          </View>
          <View style={styles.detailItem}>
            <Ionicons 
              name={item.delivery_type === 'delivery' ? 'car-outline' : 'storefront-outline'} 
              size={16} 
              color="#666" 
            />
            <Text style={styles.detailText}>
              {item.delivery_type === 'delivery' ? 'Delivery' : 'Pickup'}
            </Text>
          </View>
        </View>
        
        <View style={styles.orderFooter}>
          <Text style={styles.totalAmount}>₹{item.grand_total.toFixed(2)}</Text>
          
          <View style={styles.orderActions}>
            {config.nextStatus && (
              <TouchableOpacity 
                style={[styles.actionBtn, { backgroundColor: statusConfig[config.nextStatus].color }]}
                onPress={() => handleUpdateStatus(item, config.nextStatus!)}
              >
                <Text style={styles.actionBtnText}>
                  Mark {config.nextStatus.charAt(0).toUpperCase() + config.nextStatus.slice(1)}
                </Text>
              </TouchableOpacity>
            )}
            
            {item.status === 'pending' && (
              <TouchableOpacity 
                style={[styles.actionBtn, { backgroundColor: '#e53935' }]}
                onPress={() => handleUpdateStatus(item, 'cancelled')}
              >
                <Text style={styles.actionBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Status Filter */}
      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={statusFilters}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.filterChip,
                selectedStatus === item.key && styles.filterChipActive,
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  selectedStatus === item.key && styles.filterChipTextActive,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={renderOrder}
          contentContainerStyle={styles.orderList}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No orders found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  filterContainer: {
    paddingVertical: 12,
    paddingLeft: 16,
    backgroundColor: '#fff',
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    marginRight: 8,
  },
  filterChipActive: {
    backgroundColor: '#1E88E5',
  },
  filterChipText: {
    fontSize: 14,
    color: '#666',
  },
  filterChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  orderList: {
    padding: 16,
  },
  orderCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  orderDate: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },
  statusText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  orderDetails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    gap: 16,
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  detailText: {
    fontSize: 13,
    color: '#666',
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  totalAmount: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E88E5',
  },
  orderActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
});
