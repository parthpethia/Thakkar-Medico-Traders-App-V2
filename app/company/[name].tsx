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
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { Product } from '../../src/types';

export default function CompanyProducts() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const companyName = decodeURIComponent(name || '');
  const router = useRouter();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const showPrices = user?.role === 'admin';

  /* ================= FETCH ================= */

  const fetchProducts = async () => {
    try {
      setLoading(true);

      let query = supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .eq('company', companyName)
        .order('name');

      if (search.trim()) {
        query = query.ilike('name', `%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      setProducts(data || []);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyName) {
      const t = setTimeout(fetchProducts, 300);
      return () => clearTimeout(t);
    }
  }, [companyName, search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchProducts();
    setRefreshing(false);
  }, [companyName]);

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

  const renderProduct = ({ item }: { item: Product }) => (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => router.push(`/product/${item.id}`)}
    >
      <View style={styles.cardLeft}>
        <View style={styles.iconCircle}>
          <Ionicons name="medical" size={20} color="#4C51C9" />
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
              {item.mrp > item.selling_price && (
                <Text style={styles.mrp}>₹{item.mrp}</Text>
              )}
            </View>
          )}
          {item.stock_quantity <= 0 && (
            <Text style={styles.outOfStock}>Out of stock</Text>
          )}
        </View>
      </View>

      {item.stock_quantity > 0 && (
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
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: companyName,
          headerBackTitle: 'Back',
        }}
      />

      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder={`Search in ${companyName}...`}
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

      {/* Product count */}
      {!loading && (
        <Text style={styles.countText}>
          {products.length} product{products.length !== 1 ? 's' : ''}
        </Text>
      )}

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
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
              <Ionicons name="cube-outline" size={48} color="#ccc" />
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
    marginBottom: 8,
  },

  searchInput: { flex: 1, marginLeft: 12, fontSize: 15, color: '#333' },

  countText: {
    fontSize: 13,
    color: '#888',
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
    backgroundColor: '#fff',
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
    backgroundColor: '#ECEDFB',
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
    color: '#333',
  },

  packSize: {
    fontSize: 12,
    color: '#4C51C9',
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
    color: '#4C51C9',
  },

  mrp: {
    fontSize: 12,
    color: '#999',
    textDecorationLine: 'line-through',
  },

  outOfStock: {
    fontSize: 12,
    color: '#EF5350',
    fontWeight: '600',
    marginTop: 4,
  },

  addBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#4C51C9',
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
    color: '#666',
    marginTop: 12,
  },

  emptySubtitle: {
    fontSize: 13,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
  },
});
