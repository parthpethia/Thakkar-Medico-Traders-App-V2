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
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { Product } from '../../src/types';

export default function Products() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();

  const [companies, setCompanies] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const showPrices = user?.role === 'admin';

  /* ================= FETCH COMPANIES ================= */

  const fetchCompanies = async () => {
    try {
      setLoading(true);

      const { data, error } = await supabase
        .from('products')
        .select('company')
        .eq('is_active', true)
        .not('company', 'is', null)
        .neq('company', '');

      if (error) throw error;

      // Extract unique company names and sort
      const unique = [...new Set((data || []).map((d) => d.company as string))];
      unique.sort((a, b) => a.localeCompare(b));
      setCompanies(unique);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load companies');
    } finally {
      setLoading(false);
    }
  };

  /* ================= SEARCH PRODUCTS ================= */

  const searchProducts = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      setSearchLoading(true);

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .ilike('name', `%${query}%`)
        .order('name')
        .limit(30);

      if (error) throw error;
      setSearchResults(data || []);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to search products');
    } finally {
      setSearchLoading(false);
    }
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchProducts(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchCompanies();
    setRefreshing(false);
  }, []);

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
    <SafeAreaView style={styles.container}>
      {/* Search */}
      <View style={styles.searchContainer}>
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
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 48,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 12,
  },

  searchInput: { flex: 1, marginLeft: 12, fontSize: 15, color: '#333' },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },

  row: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  /* Company folder card */
  companyCard: {
    width: '48%',
    backgroundColor: '#fff',
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
    backgroundColor: '#ECEDFB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },

  companyName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },

  /* Search result product card */
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
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
    color: '#333',
  },

  productCompany: {
    fontSize: 12,
    color: '#888',
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
    color: '#999',
    marginTop: 12,
  },
});
