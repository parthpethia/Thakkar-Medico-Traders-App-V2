import React, { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import CartItemComponent from '../../src/components/CartItem';
import { useCartStore } from '../../src/store/cartStore';

export default function CartScreen() {
  const router = useRouter();
  const {
    items,
    loading,
    fetchCart,
    updateQuantity,
    removeFromCart,
  } = useCartStore();

  useEffect(() => {
    fetchCart();
  }, []);

  const subtotal = useMemo(
    () => items.reduce((sum, i) => sum + i.selling_price * i.quantity, 0),
    [items]
  );

  const gst = useMemo(
    () => items.reduce((sum, i) => sum + (i.selling_price * i.quantity * i.gst_percent) / 100, 0),
    [items]
  );

  const total = subtotal + gst;

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16 }}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews
        renderItem={({ item }) => (
          <CartItemComponent
            item={item}
            onUpdateQuantity={(qty) => updateQuantity(item.id, qty)}
            onRemove={() => removeFromCart(item.id)}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="cart-outline" size={64} color="#ccc" />
              <Text style={styles.emptyTitle}>Your cart is empty</Text>
              <Text style={styles.emptySubtitle}>
                Browse products and add items to your cart
              </Text>
              <TouchableOpacity
                style={styles.browseBtn}
                onPress={() => router.push('/(tabs)/products')}
              >
                <Text style={styles.browseBtnText}>Browse Products</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />

      {items.length > 0 && (
        <View style={styles.footer}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>GST</Text>
            <Text style={styles.summaryValue}>₹{gst.toFixed(2)}</Text>
          </View>
          <View style={[styles.summaryRow, styles.totalRow]}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>₹{total.toFixed(2)}</Text>
          </View>

          <TouchableOpacity
            style={styles.placeOrderBtn}
            onPress={() => router.push('/checkout')}
          >
            <Text style={styles.placeOrderText}>Place Order</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#666',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#999',
    marginTop: 6,
    textAlign: 'center',
  },
  browseBtn: {
    marginTop: 20,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  browseBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderColor: '#eee',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, color: '#333' },
  totalRow: {
    borderTopWidth: 1,
    borderColor: '#eee',
    paddingTop: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  totalLabel: { fontWeight: '700', fontSize: 16, color: '#333' },
  totalValue: { fontWeight: '700', fontSize: 16, color: '#4C51C9' },
  placeOrderBtn: {
    backgroundColor: '#4C51C9',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  placeOrderText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
});
