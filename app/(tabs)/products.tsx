import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { TabScreenFrame, useTabTopInset } from '../../src/components/TabScreenFrame';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { supabase } from '../../src/services/supabase';
import { TAB_BAR_LAYOUT, tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, shouldShowPrices } from '../../src/types';
import {
  executeSupabaseQuery,
  getUserFetchMessage,
  shouldAlertFetchError,
} from '../../src/utils/supabaseQuery';

export default function Products() {
  const styles = useThemedStyles(createTabStyles);
  const topInset = useTabTopInset();
  const router = useRouter();
  const { user, authReady } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();

  const [companies, setCompanies] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const showPrices = shouldShowPrices(user, settings);

  /**
   * Fetches the list of active companies for filtering products.
   * 
   * Uses a two-path strategy to ensure high reliability:
   * 1. Primary Path: Calls the optimized database RPC `get_active_companies`
   *    with a 5-second AbortController timeout.
   * 2. Fallback Path: If the RPC fails or times out, queries the `products` table
   *    directly for distinct, active, non-null, and non-empty companies in
   *    alphabetical order.
   * 
   * Silently logs errors to console to prevent breaking the user experience,
   * showing a minimal inline error text only if both paths fail.
   */
  const fetchCompanies = useCallback(async () => {
    if (!authReady || !user?.id) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      setLoading(true);
      setFetchError(null);

      const { data, error } = await executeSupabaseQuery(() =>
        supabase
          .rpc('get_active_companies')
          .abortSignal(controller.signal)
      );

      clearTimeout(timeoutId);

      if (error) {
        throw error;
      }

      setCompanies((data || []) as string[]);
    } catch (rpcError: unknown) {
      clearTimeout(timeoutId);
      console.error('[products] get_active_companies failed, reason:', rpcError);

      try {
        const { data: fallbackData, error: fallbackError } = await executeSupabaseQuery(() =>
          supabase
            .from('products')
            .select('distinct(company)')
            .eq('is_active', true)
            .not('company', 'is', null)
            .neq('company', '')
            .order('company')
        );

        if (fallbackError) {
          throw fallbackError;
        }

        const fallbackCompanies = (fallbackData || [])
          .map((item: any) => item.company)
          .filter(Boolean) as string[];

        setCompanies(fallbackCompanies);
      } catch (fallbackError: unknown) {
        console.error('[products] get_active_companies fallback failed, reason:', fallbackError);
        setFetchError('Could not load filters');
      }
    } finally {
      setLoading(false);
    }
  }, [authReady, user?.id]);

  const searchProducts = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    if (!authReady || !user?.id) return;

    try {
      setSearchLoading(true);

      const { data, error } = await executeSupabaseQuery(() =>
        supabase
          .from('products')
          .select('*')
          .eq('is_active', true)
          .ilike('name', `%${query}%`)
          .order('name')
          .limit(30),
      );

      if (error) throw error;
      setSearchResults(data || []);
    } catch (err: unknown) {
      if (shouldAlertFetchError(err)) {
        Alert.alert('Error', getUserFetchMessage(err, 'Failed to search products'));
      }
    } finally {
      setSearchLoading(false);
    }
  }, [authReady, user?.id]);

  useEffect(() => {
    void fetchCompanies();
  }, [fetchCompanies]);

  useEffect(() => {
    const t = setTimeout(() => {
      void searchProducts(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search, searchProducts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchCompanies();
    setRefreshing(false);
  }, [fetchCompanies]);

  /* ================= ACTIONS ================= */

  const handleAddToCart = async (product: Product) => {
    if (!user) {
      Alert.alert('Login required', 'Please login to add items to cart');
      return;
    }

    try {
      await addToCart(product.id, 1);
      Alert.alert('Added to cart', product.name);
    } catch {
      Alert.alert('Error', 'Failed to add to cart');
    }
  };

  /* ================= RENDER ================= */

  const isSearching = search.trim().length > 0;

  const renderCompanyCard = ({ item }: { item: string }) => (
    <TouchableOpacity
      style={styles.companyCard}
      activeOpacity={0.7}
      onPress={() => router.push(`/company/${encodeURIComponent(item)}`)}
    >
      <View style={styles.folderIcon}>
        <Ionicons name="folder" size={32} color="#4C51C9" />
      </View>
      <Text style={styles.companyName} numberOfLines={2}>
        {item}
      </Text>
    </TouchableOpacity>
  );

  const renderProductItem = ({ item }: { item: Product }) => (
    <TouchableOpacity
      style={styles.productCard}
      activeOpacity={0.7}
      onPress={() => router.push(`/product/${item.id}`)}
    >
      <View style={styles.productInfo}>
        <Text style={styles.productName}>{item.name}</Text>
        {item.company && (
          <Text style={styles.productCompany}>{item.company}</Text>
        )}
      </View>

      {showPrices && (
        <Text style={styles.productPrice}>₹{item.selling_price}</Text>
      )}

      <TouchableOpacity
        style={styles.addBtn}
        onPress={() => handleAddToCart(item)}
      >
        <Ionicons name="add" size={20} color="#fff" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <TabScreenFrame style={styles.container}>
      {/* Search */}
      <View style={[styles.searchContainer, { marginTop: topInset + 12 }]}>
        <Ionicons name="search" size={20} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor="#999"
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={20} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      {fetchError ? (
        <Text style={styles.fetchErrorText}>{fetchError}</Text>
      ) : null}

      {/* Floating Scan Button */}
      <TouchableOpacity
        style={styles.scanFab}
        activeOpacity={0.8}
        onPress={() => router.push('/product/scan')}
      >
        <Ionicons name="scan" size={24} color="#fff" />
      </TouchableOpacity>

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      ) : isSearching ? (
        /* Search results */
        searchLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#4C51C9" />
          </View>
        ) : (
          <FlatList
            data={searchResults}
            keyExtractor={(i) => i.id}
            renderItem={renderProductItem}
            contentContainerStyle={styles.listContent}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Ionicons name="search-outline" size={48} color="#ccc" />
                <Text style={styles.emptyText}>No products found</Text>
              </View>
            }
          />
        )
      ) : (
        /* Company folders */
        <FlatList
          data={companies}
          keyExtractor={(item) => item}
          renderItem={renderCompanyCard}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="business-outline" size={48} color="#ccc" />
              <Text style={styles.emptyText}>No companies found</Text>
            </View>
          }
        />
      )}
    </TabScreenFrame>
  );
}

/* ================= STYLES ================= */

function createTabStyles(c: AppColors) {
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
    marginBottom: 12,
  },

  searchInput: { flex: 1, marginLeft: 12, fontSize: 15, color: c.text },

  fetchErrorText: {
    fontSize: 13,
    color: '#c62828',
    marginHorizontal: 16,
    marginBottom: 8,
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  listContent: {
    paddingHorizontal: 16,
    paddingBottom: TAB_BAR_LAYOUT.scrollBottomInset,
  },

  row: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  /* Company folder card */
  companyCard: {
    width: '48%',
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },

  folderIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },

  companyName: {
    fontSize: 14,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
  },

  /* Search result product card */
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
  },

  productInfo: {
    flex: 1,
  },

  productName: {
    fontSize: 15,
    fontWeight: '600',
    color: c.text,
  },

  productCompany: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 2,
  },

  productPrice: {
    fontSize: 15,
    fontWeight: '700',
    color: '#4C51C9',
    marginRight: 12,
  },

  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* Empty state */
  emptyContainer: {
    alignItems: 'center',
    marginTop: 60,
  },

  emptyText: {
    fontSize: 15,
    color: c.textMuted,
    marginTop: 12,
  },

  /* Scan FAB */
  scanFab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#4C51C9',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#4C51C9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 100,
  },
};
}
