import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Order, OrderStatus } from '../../src/types';
import api from '../../src/services/api';
import { format } from 'date-fns';

const statusConfig: Record<OrderStatus, { color: string; icon: keyof typeof Ionicons.glyphMap; label: string }> = {
  pending: { color: '#FFA726', icon: 'time', label: 'Pending' },
  approved: { color: '#42A5F5', icon: 'checkmark-circle', label: 'Approved' },
  packed: { color: '#7E57C2', icon: 'cube', label: 'Packed' },
  dispatched: { color: '#26A69A', icon: 'car', label: 'Dispatched' },
  delivered: { color: '#66BB6A', icon: 'checkmark-done', label: 'Delivered' },
  cancelled: { color: '#EF5350', icon: 'close-circle', label: 'Cancelled' },
};

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>() as { id: string };
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrder();
  }, [id]);

  const fetchOrder = async () => {
    try {
      const response = await api.get(`/orders/${id}`);
      setOrder(response.data);
    } catch (error) {
      console.error('Error fetching order:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.loadingContainer}>
          <Ionicons name="alert-circle" size={64} color="#ccc" />
          <Text style={styles.errorText}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const config = statusConfig[order.status];

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: `#${order.order_number}` }} />
      
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Status Card */}
        <View style={styles.statusCard}>
          <View style={[styles.statusIcon, { backgroundColor: config.color }]}>
            <Ionicons name={config.icon} size={32} color="#fff" />
          </View>
          <Text style={styles.statusLabel}>{config.label}</Text>
          <Text style={styles.orderDate}>
            {format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
          </Text>
        </View>

        {/* Delivery Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Information</Text>
          
          <View style={styles.infoRow}>
            <Ionicons 
              name={order.delivery_type === 'delivery' ? 'car' : 'storefront'} 
              size={20} 
              color="#1E88E5" 
            />
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Delivery Type</Text>
              <Text style={styles.infoValue}>
                {order.delivery_type === 'delivery' ? 'Home Delivery' : 'Store Pickup'}
              </Text>
            </View>
          </View>

          {order.delivery_type === 'delivery' && order.delivery_address && (
            <View style={styles.infoRow}>
              <Ionicons name="location" size={20} color="#1E88E5" />
              <View style={styles.infoContent}>
                <Text style={styles.infoLabel}>Delivery Address</Text>
                <Text style={styles.infoValue}>{order.delivery_address}</Text>
              </View>
            </View>
          )}

          <View style={styles.infoRow}>
            <Ionicons name="card" size={20} color="#1E88E5" />
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Payment Mode</Text>
              <Text style={styles.infoValue}>
                {order.payment_mode === 'cod' ? 'Cash on Delivery' : 
                 order.payment_mode === 'credit' ? 'Credit' :
                 order.payment_mode === 'upi' ? 'UPI' : 'Bank Transfer'}
              </Text>
            </View>
          </View>
        </View>

        {/* Order Items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Items</Text>
          
          {order.items.map((item, index) => (
            <View key={index} style={styles.itemCard}>
              <View style={styles.itemHeader}>
                <Text style={styles.itemName} numberOfLines={2}>{item.product_name}</Text>
                <Text style={styles.itemSku}>SKU: {item.sku}</Text>
              </View>
              <View style={styles.itemDetails}>
                <View style={styles.itemQty}>
                  <Text style={styles.qtyLabel}>Qty</Text>
                  <Text style={styles.qtyValue}>{item.quantity}</Text>
                </View>
                <View style={styles.itemPrice}>
                  <Text style={styles.priceLabel}>₹{item.selling_price} x {item.quantity}</Text>
                  <Text style={styles.priceValue}>₹{item.total.toFixed(2)}</Text>
                  <Text style={styles.gstText}>incl. GST ₹{item.gst_amount.toFixed(2)}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        {/* Order Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{order.subtotal.toFixed(2)}</Text>
          </View>
          
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>CGST</Text>
            <Text style={styles.summaryValue}>₹{order.cgst.toFixed(2)}</Text>
          </View>
          
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>SGST</Text>
            <Text style={styles.summaryValue}>₹{order.sgst.toFixed(2)}</Text>
          </View>
          
          {order.delivery_charge > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Delivery Charge</Text>
              <Text style={styles.summaryValue}>₹{order.delivery_charge.toFixed(2)}</Text>
            </View>
          )}
          
          {order.points_discount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: '#43A047' }]}>Points Discount</Text>
              <Text style={[styles.summaryValue, { color: '#43A047' }]}>
                -₹{order.points_discount.toFixed(2)}
              </Text>
            </View>
          )}
          
          <View style={styles.divider} />
          
          <View style={styles.summaryRow}>
            <Text style={styles.totalLabel}>Grand Total</Text>
            <Text style={styles.totalValue}>₹{order.grand_total.toFixed(2)}</Text>
          </View>
        </View>

        {order.notes && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{order.notes}</Text>
          </View>
        )}

        <View style={styles.bottomPadding} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollView: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
  statusCard: {
    backgroundColor: '#fff',
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  statusIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statusLabel: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  orderDate: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  infoContent: {
    flex: 1,
    marginLeft: 12,
  },
  infoLabel: {
    fontSize: 12,
    color: '#888',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginTop: 2,
  },
  itemCard: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  itemHeader: {
    marginBottom: 12,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  itemSku: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  itemDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemQty: {
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  qtyLabel: {
    fontSize: 10,
    color: '#888',
  },
  qtyValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  itemPrice: {
    alignItems: 'flex-end',
  },
  priceLabel: {
    fontSize: 12,
    color: '#888',
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E88E5',
  },
  gstText: {
    fontSize: 10,
    color: '#888',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#666',
  },
  summaryValue: {
    fontSize: 14,
    color: '#333',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 12,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E88E5',
  },
  notesText: {
    fontSize: 14,
    color: '#666',
    lineHeight: 22,
  },
  bottomPadding: {
    height: 40,
  },
});
