import React, { useCallback, useEffect, useRef, useState } from 'react';
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

const PAGE_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 400;

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
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchProducts = useCallback(async (query: string) => {
    try {
      setLoading(true);
      let q = supabase
        .from('products')
        .select('id, name, company, stock_quantity')
        .eq('is_active', true)
        .order('name')
        .limit(PAGE_LIMIT);

      const term = query.trim();
      if (term) {
        const pattern = `%${term}%`;
        q = q.or(`name.ilike.${pattern},company.ilike.${pattern}`);
      }

      const { data, error } = await q;
      if (error) throw error;
      setProducts(data || []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load products';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts('');
  }, [fetchProducts]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const onSearchChange = (text: string) => {
    setSearchQuery(text);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      fetchProducts(text);
    }, SEARCH_DEBOUNCE_MS);
  };

  const clearSearch = () => {
    setSearchQuery('');
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    fetchProducts('');
  };

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
            await fetchProducts(searchQuery);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Bulk restock failed';
            Alert.alert('Error', message);
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

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#888" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or company"
          placeholderTextColor="#999"
          value={searchQuery}
          onChangeText={onSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="never"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color="#888" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#4C51C9" />
      ) : (
        <>
          <FlatList
            data={products}
            keyExtractor={(item) => item.id}
            contentContainerStyle={
              products.length === 0 ? styles.emptyList : { padding: 16, paddingBottom: 100 }
            }
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Ionicons name="search-outline" size={48} color="#ccc" />
                <Text style={styles.emptyTitle}>No products found</Text>
                <Text style={styles.emptySubtitle}>
                  {searchQuery.trim()
                    ? 'Try a different name or company'
                    : 'No active products to restock'}
                </Text>
              </View>
            }
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e8e8e8',
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#333',
    paddingVertical: 0,
  },
  emptyList: { flexGrow: 1, padding: 16, paddingBottom: 100 },
  emptyBox: { alignItems: 'center', paddingTop: 48 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#666', marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: '#999', marginTop: 4, textAlign: 'center' },
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
