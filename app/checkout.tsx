import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { v4 as uuidv4 } from 'uuid';

import { useCartStore } from '../src/store/cartStore';
import { useAuthStore } from '../src/store/authStore';
import { supabase } from '../src/services/supabase';

export default function Checkout() {
  const router = useRouter();
  const { items, clearCart, loading } = useCartStore();
  const { user } = useAuthStore();

  const [address, setAddress] = useState(user?.address || '');
  const [notes, setNotes] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);

  /* ================= TOTALS ================= */

  const subtotal = useMemo(() => {
    return items.reduce((sum, i) => sum + i.quantity * i.selling_price, 0);
  }, [items]);

  const gst = useMemo(() => {
    return items.reduce(
      (sum, i) => sum + (i.selling_price * i.quantity * i.gst_percent) / 100,
      0
    );
  }, [items]);

  const grandTotal = subtotal + gst;

  /* ================= ACTION ================= */

  const placeOrder = async () => {
    if (!items.length) {
      Alert.alert('Cart empty', 'Add items before checkout');
      return;
    }

    if (!address.trim()) {
      Alert.alert('Address required', 'Please enter delivery address');
      return;
    }

    setPlacingOrder(true);

    try {
      // Verify stock availability before placing order
      const productIds = items.map((i) => i.product_id);
      const { data: stockData } = await supabase
        .from('products')
        .select('id, name, stock_quantity')
        .in('id', productIds);

      if (stockData) {
        const outOfStock = stockData.filter((p) => {
          const cartItem = items.find((i) => i.product_id === p.id);
          return cartItem && p.stock_quantity < cartItem.quantity;
        });

        if (outOfStock.length > 0) {
          const names = outOfStock.map((p) => p.name).join(', ');
          Alert.alert(
            'Stock Unavailable',
            `The following items are out of stock or have insufficient quantity: ${names}. Please update your cart.`,
          );
          setPlacingOrder(false);
          return;
        }
      }

      const orderItems = items.map((i) => ({
        product_id: i.product_id,
        name: i.name,
        quantity: i.quantity,
        selling_price: i.selling_price,
        gst_percent: i.gst_percent,
      }));

      // UUID-based order number (collision-safe under concurrent load)
      const orderNumber = `ORD-${uuidv4().substring(0, 8).toUpperCase()}`;

      const { error } = await supabase.from('orders').insert({
        order_number: orderNumber,
        user_id: user?.id,
        user_name: user?.name || '',
        user_phone: user?.phone || '',
        items: orderItems,
        subtotal,
        gst,
        grand_total: grandTotal,
        delivery_address: address,
        delivery_type: 'delivery',
        payment_mode: 'cod',
        notes,
        status: 'pending',
      });

      if (error) throw error;

      await clearCart();

      Alert.alert('Success', 'Order placed successfully', [
        {
          text: 'OK',
          onPress: () => router.replace('/(tabs)'),
        },
      ]);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to place order');
    } finally {
      setPlacingOrder(false);
    }
  };

  /* ================= UI ================= */

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Checkout' }} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Cart Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>

          {items.map((item) => (
            <View key={item.id} style={styles.row}>
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name} x {item.quantity}
              </Text>
              <Text style={styles.rowText}>
                ₹{(item.selling_price * item.quantity).toFixed(2)}
              </Text>
            </View>
          ))}

          <View style={styles.divider} />

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          <View style={[styles.totalRow, { marginTop: 4 }]}>
            <Text style={styles.totalLabel}>GST</Text>
            <Text style={styles.totalValue}>₹{gst.toFixed(2)}</Text>
          </View>
          <View style={[styles.totalRow, { marginTop: 8 }]}>
            <Text style={[styles.totalLabel, { fontWeight: '700', fontSize: 16 }]}>Total</Text>
            <Text style={[styles.totalValue, { fontWeight: '700', fontSize: 16, color: '#4C51C9' }]}>₹{grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        {/* Address */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Address</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter delivery address"
            placeholderTextColor="#999"
            value={address}
            onChangeText={setAddress}
            multiline
          />
        </View>

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="Any instructions?"
            placeholderTextColor="#999"
            value={notes}
            onChangeText={setNotes}
          />
        </View>
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[
            styles.placeBtn,
            (placingOrder || loading) && styles.disabled,
          ]}
          onPress={placeOrder}
          disabled={placingOrder || loading}
        >
          {placingOrder ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.placeText}>Place Order</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  rowText: {
    fontSize: 13,
    color: '#444',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 12,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  totalLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  totalValue: {
    fontSize: 15,
    fontWeight: '700',
  },
  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    minHeight: 48,
    textAlignVertical: 'top',
  },
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  placeBtn: {
    backgroundColor: '#4C51C9',
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.6,
  },
});
