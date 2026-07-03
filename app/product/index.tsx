import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { Product } from '../../src/types';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';


export default function AdminProducts() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  /* ---------------- FETCH PRODUCTS ---------------- */
  const fetchProducts = async () => {
    try {
      setLoading(true);

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      setProducts(data || []);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  /* ---------------- DELETE ---------------- */
  const handleDelete = (id: string) => {
    Alert.alert('Delete Product', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase
            .from('products')
            .delete()
            .eq('id', id);

          if (error) {
            Alert.alert('Error', error.message);
            return;
          }

          fetchProducts();
        },
      },
    ]);
  };

  /* ---------------- TOGGLE ACTIVE ---------------- */
  const toggleActive = async (product: Product) => {
    const { error } = await supabase
      .from('products')
      .update({ is_active: !product.is_active })
      .eq('id', product.id);

    if (error) {
      Alert.alert('Error', error.message);
      return;
    }

    fetchProducts();
  };

  /* ---------------- RENDER ITEM ---------------- */
  const renderItem = ({ item }: { item: Product }) => (
    <View style={styles.card}>
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.sub}>₹{item.selling_price}</Text>
        <Text style={styles.sub}>
          Stock: {item.stock_quantity}
        </Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={() => router.push(`/admin/products/${item.id}`)}
        >
          <Ionicons name="pencil" size={22} color={colors.primary} />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => toggleActive(item)}>
          <Ionicons
            name={item.is_active ? 'eye' : 'eye-off'}
            size={22}
            color={colors.warning}
          />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => handleDelete(item.id)}>
          <Ionicons name="trash" size={22} color={colors.error} />
        </TouchableOpacity>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <Text style={styles.title}>Products</Text>

        {/* ➕ ADD PRODUCT */}
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push('/admin/create-product')}
        >
          <Ionicons name="add" size={24} color={colors.onPrimary} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={products}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

/* ---------------- STYLES ---------------- */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: c.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  addBtn: {
    backgroundColor: c.primary,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: c.surface,
    padding: 14,
    borderRadius: 10,
    marginBottom: 12,
    flexDirection: 'row',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
  },
  sub: {
    fontSize: 12,
    color: c.textSecondary,
    marginTop: 2,
  },
  actions: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
};
}
