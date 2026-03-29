import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';

type Product = {
  id: string;
  name: string;
  selling_price: number;
  gst_percent: number;
  is_active: boolean;
};

type OrderItem = {
  product_id: string;
  name: string;
  quantity: number;
  selling_price: number;
  gst_percent: number;
};

type ExistingOrder = {
  id: string;
  order_number: string;
  user_id: string;
  user_name: string;
  user_phone: string;
  items: OrderItem[];
  subtotal: number;
  gst: number;
  grand_total: number;
  delivery_address: string;
  delivery_type: string;
  payment_mode: string;
  notes?: string;
  status: string;
};

export default function DeliveryEditOrder() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState<ExistingOrder | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [qtyByProduct, setQtyByProduct] = useState<Record<string, number>>({});

  const selectedItems = useMemo(() => {
    return products
      .filter((product) => (qtyByProduct[product.id] || 0) > 0)
      .map((product) => ({
        product_id: product.id,
        name: product.name,
        quantity: qtyByProduct[product.id] || 0,
        selling_price: product.selling_price,
        gst_percent: product.gst_percent,
      }));
  }, [products, qtyByProduct]);

  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    if (!query) return products;
    return products.filter((p) => p.name.toLowerCase().includes(query));
  }, [products, productSearch]);

  const subtotal = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.quantity * item.selling_price, 0),
    [selectedItems]
  );

  const gst = useMemo(
    () =>
      selectedItems.reduce(
        (sum, item) => sum + (item.quantity * item.selling_price * (item.gst_percent || 0)) / 100,
        0
      ),
    [selectedItems]
  );

  const grandTotal = subtotal + gst;

  const fetchData = async () => {
    if (!orderId) {
      Alert.alert('Order missing', 'No order ID provided.');
      router.back();
      return;
    }

    try {
      setLoading(true);

      const [orderRes, productsRes] = await Promise.all([
        supabase
          .from('orders')
          .select('*')
          .eq('id', orderId)
          .single(),
        supabase
          .from('products')
          .select('id, name, selling_price, gst_percent, is_active')
          .eq('is_active', true)
          .order('name', { ascending: true }),
      ]);

      if (orderRes.error) throw orderRes.error;
      if (productsRes.error) throw productsRes.error;

      const existingOrder = orderRes.data as ExistingOrder;

      // Fetch current profile address (may have been updated by retailer)
      if (existingOrder.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('address, city, state, pincode, name, phone, business_name')
          .eq('id', existingOrder.user_id)
          .single();

        if (profile) {
          const liveAddress = [profile.address, profile.city, profile.state, profile.pincode]
            .filter(Boolean)
            .join(', ');
          if (liveAddress.trim()) {
            existingOrder.delivery_address = liveAddress;
          }
          // Also sync name and phone
          existingOrder.user_name = profile.name || profile.business_name || existingOrder.user_name;
          existingOrder.user_phone = profile.phone || existingOrder.user_phone;
        }
      }

      setOrder(existingOrder);
      setProducts(productsRes.data || []);

      // Pre-populate quantities from existing order items
      const initialQty: Record<string, number> = {};
      if (Array.isArray(existingOrder.items)) {
        existingOrder.items.forEach((item: OrderItem) => {
          if (item.product_id) {
            initialQty[item.product_id] = item.quantity || 0;
          }
        });
      }
      setQtyByProduct(initialQty);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load order');
      router.back();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [orderId]);

  const changeQty = (productId: string, diff: number) => {
    setQtyByProduct((prev) => {
      const nextValue = Math.max(0, (prev[productId] || 0) + diff);
      return { ...prev, [productId]: nextValue };
    });
  };

  const saveOrder = async () => {
    if (!order) return;

    if (!selectedItems.length) {
      Alert.alert('No Items', 'Add at least one product to save.');
      return;
    }

    setSaving(true);

    try {
      const { error } = await supabase
        .from('orders')
        .update({
          items: selectedItems,
          subtotal,
          gst,
          grand_total: grandTotal,
          delivery_address: order.delivery_address,
          user_name: order.user_name,
          user_phone: order.user_phone,
        })
        .eq('id', order.id);

      if (error) throw error;

      Alert.alert('Success', 'Order updated successfully.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update order');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color="#ccc" />
          <Text style={{ color: '#888', marginTop: 10 }}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: `Edit #${order.order_number}` }} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Order info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Info</Text>
          <Text style={styles.retailerTitle}>#{order.order_number}</Text>
          <Text style={styles.retailerMeta}>
            {order.user_name || 'Retailer'} · {order.user_phone || '—'}
          </Text>
          <Text style={styles.retailerMeta}>Status: {order.status}</Text>
        </View>

        {/* Products list */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Edit Items</Text>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color="#888" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search product"
              placeholderTextColor="#999"
              value={productSearch}
              onChangeText={setProductSearch}
            />
          </View>

          {filteredProducts.map((product) => {
            const qty = qtyByProduct[product.id] || 0;

            return (
              <View key={product.id} style={styles.productRow}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={styles.productName}>{product.name}</Text>
                  <Text style={styles.productMeta}>
                    ₹{product.selling_price.toFixed(2)} · GST {product.gst_percent}%
                  </Text>
                </View>

                <View style={styles.qtyRow}>
                  <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, -1)}>
                    <Ionicons name="remove" size={16} color="#333" />
                  </TouchableOpacity>
                  <Text style={styles.qtyText}>{qty}</Text>
                  <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, 1)}>
                    <Ionicons name="add" size={16} color="#333" />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}

          {filteredProducts.length === 0 && (
            <Text style={styles.emptyText}>No products found.</Text>
          )}
        </View>

        {/* Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Updated Summary</Text>
          <SummaryRow label="Items" value={`${selectedItems.length}`} />
          <SummaryRow label="Subtotal" value={`₹${subtotal.toFixed(2)}`} />
          <SummaryRow label="GST" value={`₹${gst.toFixed(2)}`} />
          <SummaryRow label="Grand Total" value={`₹${grandTotal.toFixed(2)}`} bold />
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.submitBtn, (saving || selectedItems.length === 0) && { opacity: 0.6 }]}
          disabled={saving || selectedItems.length === 0}
          onPress={saveOrder}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>Save Changes</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, bold && styles.summaryBold]}>{label}</Text>
      <Text style={[styles.summaryValue, bold && styles.summaryBold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#333', marginBottom: 10 },
  retailerTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  retailerMeta: { marginTop: 3, color: '#666', fontSize: 13 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    color: '#333',
    fontSize: 14,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  productName: { fontSize: 14, color: '#333', fontWeight: '600' },
  productMeta: { marginTop: 2, fontSize: 12, color: '#777' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f2',
  },
  qtyText: { minWidth: 20, textAlign: 'center', fontWeight: '700', color: '#333' },
  emptyText: { marginTop: 8, color: '#888' },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryLabel: { color: '#666' },
  summaryValue: { color: '#333', fontWeight: '600' },
  summaryBold: { fontWeight: '700', color: '#111' },
  footer: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    padding: 16,
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
