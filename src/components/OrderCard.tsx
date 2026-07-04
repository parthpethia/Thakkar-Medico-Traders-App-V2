import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Order, OrderStatus } from '../types';
import { format } from 'date-fns';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface OrderCardProps {
  order: Order;
  onPress: () => void;
}

const getStatusConfig = (colors: AppColors): Record<OrderStatus, { color: string; icon: keyof typeof Ionicons.glyphMap; label: string }> => ({
  pending: { color: colors.warning, icon: 'time', label: 'Pending' },
  pending_payment: { color: '#9B59B6', icon: 'card', label: 'Pending Payment' },
  payment_failed: { color: '#E53935', icon: 'alert-circle', label: 'Payment Failed' },
  assigned: { color: '#5C6BC0', icon: 'person', label: 'Assigned' },
  accepted: { color: '#00897B', icon: 'checkmark-circle', label: 'Accepted' },
  approved: { color: '#42A5F5', icon: 'checkmark-circle', label: 'Approved' },
  packed: { color: '#7E57C2', icon: 'cube', label: 'Packed' },
  picked_up: { color: '#00897B', icon: 'bag-check', label: 'Picked Up' },
  dispatched: { color: '#26A69A', icon: 'car', label: 'Dispatched' },
  delivered: { color: colors.success, icon: 'checkmark-done', label: 'Delivered' },
  cancelled: { color: '#EF5350', icon: 'close-circle', label: 'Cancelled' },
  rejected: { color: '#EF5350', icon: 'close-circle', label: 'Rejected' },
  delivery_failed: { color: '#E53935', icon: 'alert-circle', label: 'Delivery Failed' },
});

export const OrderCard: React.FC<OrderCardProps> = React.memo(({ order, onPress }) => {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const config = getStatusConfig(colors)[order.status];
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
          <Ionicons name={config.icon} size={14} color={colors.onPrimary} />
          <Text style={styles.statusText}>{config.label}</Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.body}>
        <View style={styles.infoRow}>
          <Ionicons name="cube-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.infoText}>{itemCount} items</Text>
        </View>

        <View style={styles.infoRow}>
          <Ionicons
            name={order.delivery_type === 'delivery' ? 'car-outline' : 'storefront-outline'}
            size={16}
            color={colors.textSecondary}
          />
          <Text style={styles.infoText}>
            {order.delivery_type === 'delivery' ? 'Delivery' : 'Pickup'}
          </Text>
        </View>

        <View style={styles.infoRow}>
          <Ionicons name="card-outline" size={16} color={colors.textSecondary} />
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
});

function createStyles(c: AppColors) {
  return {
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    header: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'flex-start' as const,
    },
    orderNumber: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: c.text,
    },
    date: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 4,
    },
    statusBadge: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 20,
      gap: 4,
    },
    statusText: {
      color: c.onPrimary,
      fontSize: 12,
      fontWeight: '600' as const,
    },
    divider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 12,
    },
    body: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between',
    },
    infoRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
    },
    infoText: {
      fontSize: 13,
      color: c.textSecondary,
    },
    footer: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between',
      alignItems: 'center' as const,
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    totalLabel: {
      fontSize: 14,
      color: c.textSecondary,
    },
    totalAmount: {
      fontSize: 18,
      fontWeight: '700' as const,
      color: c.primary,
    },
  } as const;
}
