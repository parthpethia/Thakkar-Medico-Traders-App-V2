import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
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
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

const PAGE_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 400;

type ProductRow = {
  id: string;
  name: string;
  company: string | null;
  stock_quantity: number;
};

export default function BulkRestockScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
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
        reason: 'restock',
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
            });
            if (error) throw error;

            const result = data as {
              updated: string[];
              failed: { id: string; reason: string }[];
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
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: 'Bulk Restock' }} />

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or company"
          placeholderTextColor={colors.textMuted}
          value={searchQuery}
          onChangeText={onSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="never"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.primary} />
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
                <Ionicons name="search-outline" size={48} color={colors.textMuted} />
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
                  placeholderTextColor={colors.textMuted}
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
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="layers-outline" size={20} color={colors.onPrimary} />
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

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    searchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 4,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: c.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      color: c.text,
      paddingVertical: 0,
    },
    emptyList: { flexGrow: 1, padding: 16, paddingBottom: 100 },
    emptyBox: { alignItems: 'center' as const, paddingTop: 48 },
    emptyTitle: { fontSize: 16, fontWeight: '600' as const, color: c.textSecondary, marginTop: 12 },
    emptySubtitle: { fontSize: 13, color: c.textMuted, marginTop: 4, textAlign: 'center' as const },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: 12,
      marginBottom: 8,
      gap: 12,
    },
    name: { fontSize: 15, fontWeight: '600' as const, color: c.text },
    meta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    input: {
      width: 72,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      textAlign: 'center' as const,
      backgroundColor: c.inputBackground,
      color: c.text,
    },
    footer: {
      position: 'absolute' as const,
      bottom: 0,
      left: 0,
      right: 0,
      padding: 16,
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    applyBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      backgroundColor: c.success,
      paddingVertical: 14,
      borderRadius: 12,
    },
    applyText: { color: c.onPrimary, fontWeight: '700' as const, fontSize: 16 },
  };
}
