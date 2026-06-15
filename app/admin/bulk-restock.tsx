import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';

type ProductRow = {
  id: string;
  name: string;
  company: string | null;
  stock_quantity: number;
};

export default function BulkRestockScreen() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from('products')
          .select('id, name, company, stock_quantity')
          .eq('is_active', true)
          .order('name')
          .limit(200);
        if (error) throw error;
        setProducts(data || []);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load products');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setQty = (id: string, value: string) => {
    setQuantities((prev) => ({ ...prev, [id]: value }));
  };

  const handleApply = async () => {
    const adjustments = products
      .map((p) => ({
        product_id: p.id,
        delta: parseInt(quantities[p.id] || '0', 10),
      }))
      .filter((a) => a.delta > 0);

    if (adjustments.length === 0) {
      Alert.alert('Nothing to restock', 'Enter quantities for at least one product.');
      return;
    }

    Alert.alert('Confirm Bulk Restock', `Restock ${adjustments.length} product(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Apply',
        onPress: async () => {
          setSubmitting(true);
          try {
            const { data, error } = await supabase.rpc('batch_adjust_stock', {
              p_adjustments: adjustments,
              p_reason: 'restock',
            });
            if (error) throw error;

            const result = data as {
              updated: { product_id: string; new_quantity: number }[];
              failed: { product_id: string; reason: string }[];
            };
            const ok = result.updated?.length || 0;
            const fail = result.failed?.length || 0;
            Alert.alert('Bulk Restock', `${ok} updated${fail ? `, ${fail} failed` : ''}`);
            setQuantities({});
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Bulk restock failed');
          } finally {
            setSubmitting(false);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Bulk Restock' }} />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#4C51C9" />
      ) : (
        <>
          <FlatList
            data={products}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    Stock: {item.stock_quantity}
                    {item.company ? ` · ${item.company}` : ''}
                  </Text>
                </View>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  placeholder="Qty"
                  value={quantities[item.id] || ''}
                  onChangeText={(v) => setQty(item.id, v.replace(/[^0-9]/g, ''))}
                />
              </View>
            )}
          />

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.applyBtn, submitting && { opacity: 0.6 }]}
              onPress={handleApply}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="layers-outline" size={20} color="#fff" />
                  <Text style={styles.applyText}>Apply Bulk Restock</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    marginBottom: 8,
    gap: 12,
  },
  name: { fontSize: 15, fontWeight: '600', color: '#333' },
  meta: { fontSize: 12, color: '#888', marginTop: 2 },
  input: {
    width: 72,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlign: 'center',
    backgroundColor: '#fafafa',
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#43A047',
    paddingVertical: 14,
    borderRadius: 12,
  },
  applyText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
