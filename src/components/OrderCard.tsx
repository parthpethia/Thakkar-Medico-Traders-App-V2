import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Order, OrderStatus } from '../types';
import { format } from 'date-fns';

interface OrderCardProps {
  order: Order;
  onPress: () => void;
}

const statusConfig: Record<OrderStatus, { color: string; icon: keyof typeof Ionicons.glyphMap; label: string }> = {
  pending: { color: '#FFA726', icon: 'time', label: 'Pending' },
  approved: { color: '#42A5F5', icon: 'checkmark-circle', label: 'Approved' },
  packed: { color: '#7E57C2', icon: 'cube', label: 'Packed' },
  dispatched: { color: '#26A69A', icon: 'car', label: 'Dispatched' },
  delivered: { color: '#66BB6A', icon: 'checkmark-done', label: 'Delivered' },
  cancelled: { color: '#EF5350', icon: 'close-circle', label: 'Cancelled' },
};

export const OrderCard: React.FC<OrderCardProps> = ({ order, onPress }) => {
  const config = statusConfig[order.status];
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.header}>
        <View>
          <Text style={styles.orderNumber}>#{order.order_number}</Text>
          <Text style={styles.date}>
            {format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
          </Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: config.color }]}>
          <Ionicons name={config.icon} size={14} color="#fff" />
          <Text style={styles.statusText}>{config.label}</Text>
        </View>
      </View>
      
      <View style={styles.divider} />
      
      <View style={styles.body}>
        <View style={styles.infoRow}>
          <Ionicons name="cube-outline" size={16} color="#666" />
          <Text style={styles.infoText}>{itemCount} items</Text>
        </View>
        
        <View style={styles.infoRow}>
          <Ionicons 
            name={order.delivery_type === 'delivery' ? 'car-outline' : 'storefront-outline'} 
            size={16} 
            color="#666" 
          />
          <Text style={styles.infoText}>
            {order.delivery_type === 'delivery' ? 'Delivery' : 'Pickup'}
          </Text>
        </View>
        
        <View style={styles.infoRow}>
          <Ionicons name="card-outline" size={16} color="#666" />
          <Text style={styles.infoText}>
            {order.payment_mode === 'cod' ? 'COD' : 
             order.payment_mode === 'credit' ? 'Credit' :
             order.payment_mode === 'upi' ? 'UPI' : 'Bank Transfer'}
          </Text>
        </View>
      </View>
      
      <View style={styles.footer}>
        <Text style={styles.totalLabel}>Total Amount</Text>
        <Text style={styles.totalAmount}>₹{order.grand_total.toFixed(2)}</Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  date: {
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
    fontSize: 12,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 12,
  },
  body: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  infoText: {
    fontSize: 13,
    color: '#666',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  totalLabel: {
    fontSize: 14,
    color: '#666',
  },
  totalAmount: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4C51C9',
  },
});
