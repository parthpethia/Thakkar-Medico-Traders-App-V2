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

type Retailer = {
  id: string;
  name: string | null;
  phone: string | null;
  business_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

type Product = {
  id: string;
  name: string;
  selling_price: number;
  gst_percent: number;
  is_active: boolean;
};

export default function DeliveryCreateOrderItems() {
  const router = useRouter();
  const { retailerId } = useLocalSearchParams<{ retailerId: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retailer, setRetailer] = useState<Retailer | null>(null);
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

    return products.filter((product) => {
      return product.name.toLowerCase().includes(query);
    });
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
    if (!retailerId) {
      Alert.alert('Retailer missing', 'Please select retailer first.');
      router.replace('/delivery/create-order');
      return;
    }

    try {
      setLoading(true);

      const [retailerRes, productsRes] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, name, phone, business_name, address, city, state, pincode')
          .eq('id', retailerId)
          .single(),

        supabase
          .from('products')
          .select('id, name, selling_price, gst_percent, is_active')
          .eq('is_active', true)
          .order('name', { ascending: true }),
      ]);

      if (retailerRes.error) throw retailerRes.error;
      if (productsRes.error) throw productsRes.error;

      setRetailer(retailerRes.data);
      setProducts(productsRes.data || []);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load data');
      router.replace('/delivery/create-order');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [retailerId]);

  const changeQty = (productId: string, diff: number) => {
    setQtyByProduct((prev) => {
      const nextValue = Math.max(0, (prev[productId] || 0) + diff);
      return { ...prev, [productId]: nextValue };
    });
  };

  const createOrder = async () => {
    if (!retailer) {
      Alert.alert('Retailer missing', 'Please select retailer first.');
      return;
    }

    if (!selectedItems.length) {
      Alert.alert('No Items', 'Add at least one product to create order.');
      return;
    }

    const fullAddress = [retailer.address, retailer.city, retailer.state, retailer.pincode]
      .filter(Boolean)
      .join(', ');

    setSaving(true);

    try {
      const { error } = await supabase.from('orders').insert({
        order_number: `ORD-${Date.now()}`,
        user_id: retailer.id,
        user_name: retailer.name || retailer.business_name || 'Retailer',
        user_phone: retailer.phone || '',
        items: selectedItems,
        subtotal,
        gst,
        grand_total: grandTotal,
        delivery_address: fullAddress,
        delivery_type: 'delivery',
        payment_mode: 'cod',
        notes: 'Created by delivery portal',
        status: 'pending',
      });

      if (error) throw error;

      Alert.alert('Success', 'Order created successfully.', [
        { text: 'OK', onPress: () => router.replace('/delivery/orders') },
      ]);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create order');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Add Items' }} />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Retailer Selected</Text>
          <Text style={styles.retailerTitle}>{retailer?.business_name || retailer?.name || 'Retailer'}</Text>
          <Text style={styles.retailerMeta}>{retailer?.name || '—'} · {retailer?.phone || '—'}</Text>
          {!!retailer?.address && (
            <Text style={styles.retailerAddress}>
              {[retailer.address, retailer.city, retailer.state, retailer.pincode].filter(Boolean).join(', ')}
            </Text>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Add Items</Text>
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
                  <Text style={styles.productMeta}>₹{product.selling_price.toFixed(2)} · GST {product.gst_percent}%</Text>
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

          {filteredProducts.length === 0 && <Text style={styles.emptyText}>No products found.</Text>}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
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
          onPress={createOrder}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Create Order</Text>}
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
  retailerMeta: { marginTop: 3, color: '#666' },
  retailerAddress: { marginTop: 6, fontSize: 12, color: '#777' },
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
