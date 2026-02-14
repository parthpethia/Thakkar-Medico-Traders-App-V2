import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { Product } from '../../src/types';

export default function AdminProducts() {
  const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /* ================= FETCH ================= */

  const fetchProducts = async () => {
    try {
      setLoading(true);

      let query = supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

      if (search.trim()) {
        query = query.or(
          `name.ilike.%${search}%,company.ilike.%${search}%`
        );
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
    const t = setTimeout(fetchProducts, 300);
    return () => clearTimeout(t);
  }, [search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchProducts();
    setRefreshing(false);
  }, []);

  /* ================= ACTIONS ================= */

  const toggleActive = async (product: Product) => {
    const { error } = await supabase
      .from('products')
      .update({ is_active: !product.is_active })
      .eq('id', product.id);

    if (error) Alert.alert('Error', error.message);
    else fetchProducts();
  };

  const deleteProduct = (product: Product) => {
    Alert.alert(
      'Delete Product',
      `Are you sure you want to delete "${product.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase
              .from('products')
              .delete()
              .eq('id', product.id);

            if (error) Alert.alert('Error', error.message);
            else fetchProducts();
          },
        },
      ]
    );
  };

  /* ================= RENDER ================= */

  const renderItem = ({ item }: { item: Product }) => (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.company}>{item.company || '—'}</Text>
          <Text style={styles.sku}>SKU: {item.sku}</Text>
        </View>

        {!item.is_active && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Inactive</Text>
          </View>
        )}
      </View>

      {/* Info */}
      <View style={styles.row}>
        <Text>₹{item.selling_price}</Text>
        <Text>Stock: {item.stock_quantity}</Text>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[
            styles.actionBtn,
            { backgroundColor: item.is_active ? '#FFA726' : '#43A047' },
          ]}
          onPress={() => toggleActive(item)}
        >
          <Text style={styles.btnText}>
            {item.is_active ? 'Deactivate' : 'Activate'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: '#4C51C9' }]}
          onPress={() =>
            router.push(`/admin/edit-product?id=${item.id}`)
          }
        >
          <Text style={styles.btnText}>Edit</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: '#e53935' }]}
          onPress={() => deleteProduct(item)}
        >
          <Text style={styles.btnText}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TextInput
          style={styles.search}
          placeholder="Search by product or company..."
          placeholderTextColor="#999"
          value={search}
          onChangeText={setSearch}
        />

        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push('/admin/create-product')}
        >
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#4C51C9" />
      ) : (
        <FlatList
          data={products}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={{ textAlign: 'center', marginTop: 40 }}>
              No products found
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },

  search: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
  },

  addBtn: {
    marginLeft: 12,
    backgroundColor: '#4C51C9',
    padding: 12,
    borderRadius: 10,
  },

  card: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },

  header: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 16, fontWeight: '600' },
  company: { fontSize: 13, color: '#666' },
  sku: { fontSize: 12, color: '#888' },

  badge: {
    backgroundColor: '#ffebee',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },

  badgeText: { fontSize: 11, color: '#e53935' },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 8,
  },

  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },

  actionBtn: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
  },

  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
