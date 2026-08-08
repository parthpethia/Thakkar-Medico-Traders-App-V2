import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, shouldShowPrices, canAddToCart } from '../../src/types';
import {
  executeSupabaseQuery,
  getUserFetchMessage,
  shouldAlertFetchError,
} from '../../src/utils/supabaseQuery';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function CompanyProducts() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const { name } = useLocalSearchParams<{ name: string }>();
  const companyName = decodeURIComponent(name || '');
  const router = useRouter();
  const { user, authReady } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const showPrices = shouldShowPrices(user, settings);
  const allowAddToCart = canAddToCart(user);

  const fetchProducts = useCallback(async () => {
    if (!authReady || !user?.id) return;

    try {
      setLoading(true);
      setFetchError(null);

      let query = supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .eq('company', companyName)
        .order('name');

      if (search.trim()) {
        query = query.ilike('name', `%${search}%`);
      }

      const { data, error } = await executeSupabaseQuery(() => query);
      if (error) throw error;

      setProducts(data || []);
    } catch (err: unknown) {
      const message = getUserFetchMessage(err, 'Failed to load products');
      setFetchError(message);
      if (shouldAlertFetchError(err)) {
        Alert.alert('Error', message);
      }
    } finally {
      setLoading(false);
    }
  }, [authReady, user?.id, companyName, search]);

  useEffect(() => {
    if (!companyName) return;
    const t = setTimeout(() => {
      void fetchProducts();
    }, 300);
    return () => clearTimeout(t);
  }, [companyName, fetchProducts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchProducts();
    setRefreshing(false);
  }, [fetchProducts]);

  /* ================= ACTIONS ================= */

  const handleAddToCart = async (product: Product) => {
    if (!user) {
      Alert.alert('Login required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }

    const result = await addToCart(product.id, 1);
    if (result === true) {
      Alert.alert('Added to cart', product.name);
    } else if (typeof result === 'object' && 'error' in result) {
      Alert.alert('Unable to add', result.error);
    } else {
      Alert.alert('Error', 'Failed to add to cart. Please try again.');
    }
  };

  /* ================= RENDER ================= */

  const renderProduct = ({ item }: { item: Product }) => (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => router.push(`/product/${item.id}`)}
    >
      <View style={styles.cardLeft}>
        <View style={styles.iconCircle}>
          <Ionicons name="medical" size={20} color={colors.primary} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.productName}>{item.name}</Text>
          {item.pack_size && (
            <Text style={styles.packSize}>{item.pack_size}</Text>
          )}
          {showPrices && (
            <View style={styles.priceRow}>
              <Text style={styles.sellingPrice}>
                ₹{item.selling_price}
              </Text>
              {item.mrp > item.selling_price && item.selling_price > 0 && (
                <Text style={styles.mrp}>₹{item.mrp}</Text>
              )}
            </View>
          )}
          {(item.stock_quantity <= 0 || (item.selling_price ?? 0) <= 0) && (
            <Text style={styles.outOfStock}>Out of stock</Text>
          )}
        </View>
      </View>

      {item.stock_quantity > 0 && (item.selling_price ?? 0) > 0 && allowAddToCart && (
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => handleAddToCart(item)}
        >
          <Ionicons name="add" size={20} color={colors.onPrimary} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: companyName,
          headerBackTitle: 'Back',
        }}
      />

      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color={colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder={`Search in ${companyName}...`}
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Product count / error */}
      {fetchError ? (
        <Text style={styles.errorText}>{fetchError}</Text>
      ) : null}
      {!loading && !fetchError && (
        <Text style={styles.countText}>
          {products.length} product{products.length !== 1 ? 's' : ''}
        </Text>
      )}

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(i) => i.id}
          renderItem={renderProduct}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="cube-outline" size={48} color={colors.switchThumbOff} />
              <Text style={styles.emptyTitle}>No products found</Text>
              <Text style={styles.emptySubtitle}>
                {search ? 'Try a different search' : `No active products from ${companyName}`}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },

  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 48,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
  },

  searchInput: { flex: 1, marginLeft: 12, fontSize: 15, color: c.text },

  countText: {
    fontSize: 13,
    color: c.textMuted,
    paddingHorizontal: 20,
    marginBottom: 8,
  },

  errorText: {
    fontSize: 13,
    color: c.error,
    paddingHorizontal: 20,
    marginBottom: 8,
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },

  /* Product card */
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.surface,
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
  },

  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },

  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  cardInfo: {
    flex: 1,
  },

  productName: {
    fontSize: 15,
    fontWeight: '600',
    color: c.text,
  },

  packSize: {
    fontSize: 12,
    color: c.primary,
    marginTop: 2,
  },

  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },

  sellingPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: c.primary,
  },

  mrp: {
    fontSize: 12,
    color: c.textMuted,
    textDecorationLine: 'line-through',
  },

  outOfStock: {
    fontSize: 12,
    color: c.error,
    fontWeight: '600',
    marginTop: 4,
  },

  addBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },

  /* Empty state */
  emptyContainer: {
    alignItems: 'center',
    marginTop: 60,
    paddingHorizontal: 32,
  },

  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: c.textSecondary,
    marginTop: 12,
  },

  emptySubtitle: {
    fontSize: 13,
    color: c.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  } as const;
}
