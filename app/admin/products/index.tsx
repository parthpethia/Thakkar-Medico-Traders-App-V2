import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';

type Product = {
  id: string;
  name: string;
  company: string | null;
  category: string | null;
  selling_price: number;
  mrp: number;
  stock_quantity: number;
  is_active: boolean;
};

type FilterTab = 'all' | 'active' | 'inactive' | 'low_stock';

const PAGE_SIZE = 20;

export default function ProductsList() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef(0);

  const fetchProducts = useCallback(
    async (reset = true) => {
      if (reset) {
        pageRef.current = 0;
        setHasMore(true);
      }

      const offset = reset ? 0 : pageRef.current * PAGE_SIZE;

      try {
        let query = supabase
          .from('products')
          .select(
            'id, name, company, category, selling_price, mrp, stock_quantity, is_active',
          )
          .order('name', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (search.trim()) {
          query = query.ilike('name', `%${search.trim()}%`);
        }

        if (activeTab === 'active') query = query.eq('is_active', true);
        else if (activeTab === 'inactive') query = query.eq('is_active', false);
        else if (activeTab === 'low_stock') query = query.lte('stock_quantity', 10);

        const { data, error } = await query;
        if (error) throw error;

        const rows = (data || []) as Product[];
        if (reset) {
          setProducts(rows);
        } else {
          setProducts((prev) => [...prev, ...rows]);
        }
        setHasMore(rows.length === PAGE_SIZE);
        pageRef.current = reset ? 1 : pageRef.current + 1;
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load products');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [search, activeTab],
  );

  useEffect(() => {
    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchProducts(true), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, activeTab]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchProducts(true);
    setRefreshing(false);
  }, [fetchProducts]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetchProducts(false);
  }, [loadingMore, hasMore, fetchProducts]);

  const handleLongPress = (product: Product) => {
    const actions: { text: string; onPress: () => void; style?: 'destructive' | 'cancel' }[] = [
      {
        text: 'Edit',
        onPress: () => router.push(`/admin/products/${product.id}`),
      },
      {
        text: product.is_active ? 'Deactivate' : 'Activate',
        style: product.is_active ? 'destructive' : undefined,
        onPress: () => confirmToggleActive(product),
      },
    ];

    Alert.alert(product.name, 'Choose an action', [
      ...actions,
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const confirmToggleActive = (product: Product) => {
    const action = product.is_active ? 'Deactivate' : 'Activate';
    Alert.alert(
      `${action} Product`,
      `Are you sure you want to ${action.toLowerCase()} "${product.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action,
          style: product.is_active ? 'destructive' : 'default',
          onPress: async () => {
            setDeactivatingId(product.id);
            try {
              const { error } = await supabase.rpc('deactivate_product', {
                p_product_id: product.id,
              });
              if (error) throw error;
              setProducts((prev) =>
                prev.map((p) =>
                  p.id === product.id ? { ...p, is_active: !p.is_active } : p,
                ),
              );
            } catch (err: any) {
              Alert.alert('Error', err.message || `Failed to ${action.toLowerCase()} product`);
            } finally {
              setDeactivatingId(null);
            }
          },
        },
      ],
    );
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
    { key: 'low_stock', label: 'Low Stock' },
  ];

  const renderItem = ({ item }: { item: Product }) => (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => router.push(`/admin/products/${item.id}`)}
      onLongPress={() => handleLongPress(item)}
    >
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.productName} numberOfLines={1}>
            {item.name}
          </Text>
          {item.company ? (
            <Text style={styles.companyText}>{item.company}</Text>
          ) : null}
        </View>

        <View
          style={[
            styles.activeBadge,
            {
              backgroundColor: item.is_active ? colors.successMuted : colors.warningBg,
            },
          ]}
        >
          <Text
            style={{
              color: item.is_active ? colors.success : colors.warning,
              fontSize: 11,
              fontWeight: '600',
            }}
          >
            {item.is_active ? 'Active' : 'Inactive'}
          </Text>
        </View>
      </View>

      <View style={styles.cardBody}>
        {item.category ? (
          <View style={styles.categoryTag}>
            <Text style={styles.categoryTagText}>{item.category}</Text>
          </View>
        ) : null}

        <View style={styles.cardMeta}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Price</Text>
            <Text style={styles.metaValue}>₹{item.selling_price}</Text>
          </View>

          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Stock</Text>
            <Text
              style={[
                styles.metaValue,
                item.stock_quantity <= 10 && { color: colors.error },
              ]}
            >
              {item.stock_quantity}
            </Text>
          </View>
        </View>
      </View>

      {deactivatingId === item.id && (
        <View style={styles.cardOverlay}>
          <ActivityIndicator size="small" color={colors.onPrimary} />
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.tabRow}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === tab.key && styles.tabTextActive,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator
                size="small"
                color={colors.primary}
                style={{ marginVertical: 16 }}
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="cube-outline" size={52} color={colors.textMuted} />
              <Text style={styles.emptyText}>No products found</Text>
            </View>
          }
        />
      )}

      <TouchableOpacity
        style={styles.fab}
        activeOpacity={0.85}
        onPress={() => router.push('/admin/create-product')}
      >
        <Ionicons name="add" size={28} color={colors.onPrimary} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: {
      flex: 1,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      marginTop: 60,
    },
    emptyText: { marginTop: 10, color: c.textMuted, fontSize: 14 },

    searchBar: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.surface,
      margin: 16,
      marginBottom: 0,
      borderRadius: 12,
      paddingHorizontal: 14,
      height: 48,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      color: c.text,
    },

    tabRow: {
      flexDirection: 'row' as const,
      paddingHorizontal: 16,
      marginTop: 12,
      gap: 8,
    },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 20,
      backgroundColor: c.surface,
    },
    tabActive: {
      backgroundColor: c.primary,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: c.textSecondary,
    },
    tabTextActive: {
      color: c.onPrimary,
    },

    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      overflow: 'hidden' as const,
    },
    cardHeader: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
    },
    productName: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: c.text,
    },
    companyText: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 2,
    },
    activeBadge: {
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 10,
      marginLeft: 8,
    },

    cardBody: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: c.borderLight,
    },
    categoryTag: {
      alignSelf: 'flex-start' as const,
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 8,
      marginBottom: 8,
    },
    categoryTagText: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: '#5E35B1',
    },
    cardMeta: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
    },
    metaItem: {
      alignItems: 'center' as const,
    },
    metaLabel: {
      fontSize: 11,
      color: c.textMuted,
    },
    metaValue: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: c.text,
      marginTop: 2,
    },

    cardOverlay: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.25)',
      borderRadius: 14,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },

    fab: {
      position: 'absolute' as const,
      right: 20,
      bottom: 24,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: c.primary,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      elevation: 6,
      shadowColor: c.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 6,
    },
  };
}
