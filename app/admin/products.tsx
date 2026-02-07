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
import { Product } from '../../src/types';
import api from '../../src/services/api';

export default function AdminProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      let url = '/products?active_only=false&limit=100';
      if (search) url += `&search=${search}`;
      
      const response = await api.get(url);
      setProducts(response.data);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const debounce = setTimeout(fetchProducts, 300);
    return () => clearTimeout(debounce);
  }, [search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchProducts();
    setRefreshing(false);
  }, [search]);

  const handleAdjustStock = (product: Product) => {
    Alert.prompt(
      'Adjust Stock',
      `Current: ${product.stock_quantity}. Enter adjustment (+/- quantity):`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Adjust',
          onPress: async (value) => {
            const adjustment = parseInt(value || '0');
            if (isNaN(adjustment)) {
              Alert.alert('Error', 'Please enter a valid number');
              return;
            }
            try {
              await api.post(`/products/${product.id}/stock?adjustment=${adjustment}&reason=Manual adjustment`);
              Alert.alert('Success', 'Stock adjusted');
              fetchProducts();
            } catch (error: any) {
              Alert.alert('Error', error.response?.data?.detail || 'Failed to adjust stock');
            }
          },
        },
      ],
      'plain-text',
      '0'
    );
  };

  const handleToggleActive = async (product: Product) => {
    try {
      await api.put(`/products/${product.id}`, { is_active: !product.is_active });
      Alert.alert('Success', `Product ${product.is_active ? 'deactivated' : 'activated'}`);
      fetchProducts();
    } catch (error: any) {
      Alert.alert('Error', error.response?.data?.detail || 'Failed to update product');
    }
  };

  const renderProduct = ({ item }: { item: Product }) => {
    const isLowStock = item.stock_quantity < 20;
    const isOutOfStock = item.stock_quantity <= 0;
    
    return (
      <View style={[styles.productCard, !item.is_active && styles.productCardInactive]}>
        <View style={styles.productHeader}>
          <View style={styles.productIcon}>
            <Ionicons name="medical" size={24} color="#1E88E5" />
          </View>
          <View style={styles.productInfo}>
            <Text style={styles.productName}>{item.name}</Text>
            <Text style={styles.productSku}>SKU: {item.sku}</Text>
          </View>
          {!item.is_active && (
            <View style={styles.inactiveBadge}>
              <Text style={styles.inactiveText}>Inactive</Text>
            </View>
          )}
        </View>
        
        <View style={styles.productDetails}>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>MRP</Text>
            <Text style={styles.detailValue}>₹{item.mrp.toFixed(2)}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>Selling</Text>
            <Text style={[styles.detailValue, { color: '#1E88E5' }]}>₹{item.selling_price.toFixed(2)}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>Stock</Text>
            <Text style={[
              styles.detailValue,
              isLowStock && { color: '#FFA726' },
              isOutOfStock && { color: '#e53935' }
            ]}>
              {item.stock_quantity}
            </Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>GST</Text>
            <Text style={styles.detailValue}>{item.gst_percent}%</Text>
          </View>
        </View>
        
        <View style={styles.productActions}>
          <TouchableOpacity 
            style={[styles.actionBtn, { backgroundColor: '#1E88E5' }]}
            onPress={() => handleAdjustStock(item)}
          >
            <Ionicons name="add-circle" size={16} color="#fff" />
            <Text style={styles.actionBtnText}>Adjust Stock</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={[styles.actionBtn, { backgroundColor: item.is_active ? '#FFA726' : '#43A047' }]}
            onPress={() => handleToggleActive(item)}
          >
            <Ionicons name={item.is_active ? 'pause' : 'play'} size={16} color="#fff" />
            <Text style={styles.actionBtnText}>
              {item.is_active ? 'Deactivate' : 'Activate'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or SKU..."
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={20} color="#666" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderProduct}
          contentContainerStyle={styles.productList}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="cube-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No products found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 48,
  },
  searchInput: {
    flex: 1,
    marginLeft: 12,
    fontSize: 16,
    color: '#333',
  },
  productList: {
    padding: 16,
  },
  productCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  productCardInactive: {
    opacity: 0.7,
  },
  productHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  productIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  productInfo: {
    flex: 1,
    marginLeft: 12,
  },
  productName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  productSku: {
    fontSize: 12,
    color: '#888',
  },
  inactiveBadge: {
    backgroundColor: '#ffebee',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  inactiveText: {
    fontSize: 11,
    color: '#e53935',
    fontWeight: '600',
  },
  productDetails: {
    flexDirection: 'row',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  detailItem: {
    flex: 1,
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 11,
    color: '#888',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginTop: 4,
  },
  productActions: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
});
