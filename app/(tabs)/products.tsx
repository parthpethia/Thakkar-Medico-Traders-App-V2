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
import { useRouter, useLocalSearchParams } from 'expo-router';

import { supabase } from '../../src/services/supabase';
import { TAB_BAR_LAYOUT, tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, shouldShowPrices, canAddToCart } from '../../src/types';
import {
  executeSupabaseQuery,
  getUserFetchMessage,
  shouldAlertFetchError,
} from '../../src/utils/supabaseQuery';

type ActiveCompany = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
};

function normalizeActiveCompanies(data: unknown): ActiveCompany[] {
  if (!Array.isArray(data)) return [];

  return data
    .map((row): ActiveCompany | null => {
      if (typeof row === 'string') {
        const name = row.trim();
        if (!name) return null;
        return { id: name, name, slug: name, logo_url: null };
      }
      if (row && typeof row === 'object' && 'name' in row) {
        const r = row as Record<string, unknown>;
        const name = String(r.name ?? '').trim();
        if (!name) return null;
        return {
          id: String(r.id ?? name),
          name,
          slug: String(r.slug ?? name),
          logo_url: (r.logo_url as string | null) ?? null,
        };
      }
      return null;
    })
    .filter((c): c is ActiveCompany => c !== null);
}

export default function Products() {
  const styles = useThemedStyles(createTabStyles);
  const topInset = useTabTopInset();
  const router = useRouter();
  const { category } = useLocalSearchParams<{ category?: string }>();
  const categoryName = category
    ? decodeURIComponent(
        Array.isArray(category) ? category[0] : category,
      )
    : null;
  const { user, authReady } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();

  const [companies, setCompanies] = useState<ActiveCompany[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const clearCategoryFilter = useCallback(() => {
    router.setParams({ category: undefined });
    setCategoryProducts([]);
  }, [router]);

  const showPrices = shouldShowPrices(user, settings);
  const allowAddToCart = canAddToCart(user);

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

      setCompanies(normalizeActiveCompanies(data));
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

        const fallbackCompanies = normalizeActiveCompanies(
          (fallbackData as any || []).map((item: any) => item.company),
        );

        setCompanies(fallbackCompanies);
      } catch (fallbackError: unknown) {
        console.error('[products] get_active_companies fallback failed, reason:', fallbackError);
        setFetchError('Could not load filters');
      }
    } finally {
      setLoading(false);
    }
  }, [authReady, user?.id]);

  const fetchCategoryProducts = useCallback(
    async (name: string) => {
      if (!authReady || !user?.id) return;

      try {
        setCategoryLoading(true);

        const { data, error } = await executeSupabaseQuery(() =>
          supabase
            .from('products')
            .select('*')
            .eq('is_active', true)
            .eq('category', name)
            .order('name'),
        );

        if (error) throw error;
        setCategoryProducts(data || []);
      } catch (err: unknown) {
        if (shouldAlertFetchError(err)) {
          Alert.alert(
            'Error',
            getUserFetchMessage(err, 'Failed to load category products'),
          );
        }
        setCategoryProducts([]);
      } finally {
        setCategoryLoading(false);
      }
    },
    [authReady, user?.id],
  );

  const searchProducts = useCallback(
    async (query: string, categoryFilter: string | null) => {
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }
      if (!authReady || !user?.id) return;

      try {
        setSearchLoading(true);

        const { data, error } = await executeSupabaseQuery(() =>
          supabase.rpc('search_products', {
            p_query: query.trim(),
            p_category: categoryFilter || null,
            p_hide_out_of_stock: false,
            p_page_size: 30,
          })
        );

        if (error) throw error;
        setSearchResults((data || []) as Product[]);
      } catch (err: unknown) {
        if (shouldAlertFetchError(err)) {
          Alert.alert('Error', getUserFetchMessage(err, 'Failed to search products'));
        }
      } finally {
        setSearchLoading(false);
      }
    },
    [authReady, user?.id],
  );

  useEffect(() => {
    if (categoryName) {
      setLoading(false);
      return;
    }
    void fetchCompanies();
  }, [fetchCompanies, categoryName]);

  useEffect(() => {
    if (!categoryName) {
      setCategoryProducts([]);
      return;
    }
    void fetchCategoryProducts(categoryName);
  }, [categoryName, fetchCategoryProducts]);

  useEffect(() => {
    const t = setTimeout(() => {
      void searchProducts(search, categoryName);
    }, 300);
    return () => clearTimeout(t);
  }, [search, categoryName, searchProducts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (categoryName) {
      await fetchCategoryProducts(categoryName);
    } else {
      await fetchCompanies();
    }
    setRefreshing(false);
  }, [fetchCompanies, fetchCategoryProducts, categoryName]);

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

  const isSearching = search.trim().length > 0;
  const hasCategoryFilter = !!categoryName;
  const showCompanyFolders = !isSearching && !hasCategoryFilter;

  const searchEmptyComponent = (
    <View style={styles.emptyContainer}>
      <Ionicons name="search-outline" size={48} color="#ccc" />
      <Text style={styles.emptyText}>
        {hasCategoryFilter
          ? `No products found in ${categoryName}`
          : 'No products found'}
      </Text>
      {hasCategoryFilter ? (
        <TouchableOpacity
          style={styles.browseAllBtn}
          onPress={clearCategoryFilter}
        >
          <Text style={styles.browseAllBtnText}>Browse all products</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const categoryEmptyComponent = (
    <View style={styles.emptyContainer}>
      <Ionicons name="grid-outline" size={48} color="#ccc" />
      <Text style={styles.emptyText}>
        No products found in {categoryName}
      </Text>
      <TouchableOpacity
        style={styles.browseAllBtn}
        onPress={clearCategoryFilter}
      >
        <Text style={styles.browseAllBtnText}>Browse all products</Text>
      </TouchableOpacity>
    </View>
  );

  const renderCompanyCard = ({ item }: { item: ActiveCompany }) => (
    <TouchableOpacity
      style={styles.companyCard}
      activeOpacity={0.7}
      onPress={() => router.push(`/company/${encodeURIComponent(item.name)}`)}
    >
      <View style={styles.folderIcon}>
        <Ionicons name="folder" size={32} color="#4C51C9" />
      </View>
      <Text style={styles.companyName} numberOfLines={2}>
        {item.name}
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

      {allowAddToCart && (
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => handleAddToCart(item)}
        >
          <Ionicons name="add" size={20} color="#fff" />
        </TouchableOpacity>
      )}
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

      {categoryName ? (
        <View style={styles.filterRow}>
          <TouchableOpacity
            style={styles.categoryChip}
            onPress={clearCategoryFilter}
            activeOpacity={0.7}
          >
            <Text style={styles.categoryChipText}>{categoryName}</Text>
            <Ionicons name="close" size={18} color="#4C51C9" />
          </TouchableOpacity>
        </View>
      ) : null}

      {hasCategoryFilter && !isSearching ? (
        <Text style={styles.categoryHeading}>Category: {categoryName}</Text>
      ) : null}

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

      {loading && !refreshing && showCompanyFolders ? (
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
            ListEmptyComponent={searchEmptyComponent}
          />
        )
      ) : hasCategoryFilter ? (
        categoryLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#4C51C9" />
          </View>
        ) : (
          <FlatList
            data={categoryProducts}
            keyExtractor={(i) => i.id}
            renderItem={renderProductItem}
            contentContainerStyle={styles.listContent}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={categoryEmptyComponent}
          />
        )
      ) : (
        /* Company folders */
        <FlatList
          data={companies}
          keyExtractor={(item) => item.id}
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

  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 8,
  },

  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.primaryMuted,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#4C51C9',
  },

  categoryChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4C51C9',
  },

  categoryHeading: {
    fontSize: 18,
    fontWeight: '700',
    color: c.text,
    marginHorizontal: 16,
    marginBottom: 12,
  },

  browseAllBtn: {
    marginTop: 16,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },

  browseAllBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

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
    bottom: TAB_BAR_LAYOUT.spacerHeight + 16,
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
} as const;
}
