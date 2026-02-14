import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { Product } from '../../src/types';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const showPrices = user?.role === 'admin';

  useEffect(() => {
    if (!id) return;

    const fetchProduct = async () => {
      try {
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .eq('id', id)
          .single();

        if (error) throw error;
        setProduct(data);
      } catch {
        console.error('Failed to load product');
      } finally {
        setLoading(false);
      }
    };

    fetchProduct();
  }, [id]);

  const handleAddToCart = async () => {
    if (!user) {
      Alert.alert('Login required', 'Please login to add items to cart');
      return;
    }
    if (!product) return;

    try {
      setAdding(true);
      await addToCart(product.id, 1);
      Alert.alert('Added to cart', product.name);
    } catch {
      Alert.alert('Error', 'Failed to add to cart');
    } finally {
      setAdding(false);
    }
  };

  /* ================= LOADING ================= */

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  if (!product) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color="#ccc" />
          <Text style={styles.notFound}>Product not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  /* ================= COMPUTED ================= */

  const discount =
    product.mrp > product.selling_price
      ? Math.round(
          ((product.mrp - product.selling_price) / product.mrp) * 100
        )
      : 0;

  const isOutOfStock = product.stock_quantity <= 0;

  /* ================= UI ================= */

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: product.name,
          headerBackTitle: 'Back',
        }}
      />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Product icon */}
        <View style={styles.imageBox}>
          <Ionicons name="medical" size={64} color="#4C51C9" />
        </View>

        {/* Name & Company */}
        <Text style={styles.name}>{product.name}</Text>
        {product.company && (
          <Text style={styles.company}>{product.company}</Text>
        )}

        {/* Pack size */}
        {product.pack_size && (
          <View style={styles.packBadge}>
            <Ionicons name="cube-outline" size={16} color="#4C51C9" />
            <Text style={styles.packText}>{product.pack_size}</Text>
          </View>
        )}

        {/* Price section */}
        {showPrices && (
          <View style={styles.priceSection}>
            <View style={styles.priceRow}>
              <Text style={styles.sellingPrice}>
                ₹{product.selling_price.toFixed(2)}
              </Text>
              {discount > 0 && (
                <>
                  <Text style={styles.mrp}>
                    ₹{product.mrp.toFixed(2)}
                  </Text>
                  <View style={styles.discountBadge}>
                    <Text style={styles.discountText}>{discount}% OFF</Text>
                  </View>
                </>
              )}
            </View>
            <Text style={styles.gstNote}>
              + {product.gst_percent}% GST
            </Text>
          </View>
        )}

        {/* Details */}
        <View style={styles.detailsCard}>
          <Text style={styles.detailsTitle}>Product Details</Text>

          {product.pack_size && (
            <DetailRow
              icon="flask-outline"
              label="Packing"
              value={product.pack_size}
            />
          )}
          {product.company && (
            <DetailRow
              icon="business-outline"
              label="Company"
              value={product.company}
            />
          )}
          <DetailRow
            icon="barcode-outline"
            label="SKU"
            value={product.sku}
          />
          {showPrices && (
            <DetailRow
              icon="pricetag-outline"
              label="MRP"
              value={`₹${product.mrp.toFixed(2)}`}
            />
          )}
          {showPrices && (
            <DetailRow
              icon="receipt-outline"
              label="GST"
              value={`${product.gst_percent}%`}
            />
          )}
          <DetailRow
            icon="layers-outline"
            label="Stock"
            value={
              isOutOfStock
                ? 'Out of stock'
                : `${product.stock_quantity} available`
            }
            valueColor={isOutOfStock ? '#EF5350' : '#43A047'}
          />
        </View>
      </ScrollView>

      {/* Footer */}
      {!isOutOfStock && (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.addBtn, adding && styles.addBtnDisabled]}
            onPress={handleAddToCart}
            disabled={adding}
          >
            {adding ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="cart-outline" size={22} color="#fff" />
                <Text style={styles.addBtnText}>Add to Cart</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {isOutOfStock && (
        <View style={styles.footer}>
          <View style={styles.outOfStockBar}>
            <Ionicons name="alert-circle" size={20} color="#EF5350" />
            <Text style={styles.outOfStockText}>
              This product is currently out of stock
            </Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function DetailRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLeft}>
        <Ionicons name={icon} size={16} color="#888" />
        <Text style={styles.detailLabel}>{label}</Text>
      </View>
      <Text
        style={[styles.detailValue, valueColor ? { color: valueColor } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  notFound: { marginTop: 12, color: '#888', fontSize: 16 },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  /* Image placeholder */
  imageBox: {
    width: '100%',
    height: 180,
    backgroundColor: '#ECEDFB',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },

  /* Name */
  name: {
    fontSize: 22,
    fontWeight: '700',
    color: '#333',
  },

  company: {
    fontSize: 15,
    color: '#666',
    marginTop: 4,
  },

  /* Pack size badge */
  packBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#ECEDFB',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginTop: 10,
  },

  packText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4C51C9',
  },

  /* Price */
  priceSection: {
    marginTop: 16,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
  },

  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  sellingPrice: {
    fontSize: 24,
    fontWeight: '700',
    color: '#4C51C9',
  },

  mrp: {
    fontSize: 16,
    color: '#999',
    textDecorationLine: 'line-through',
  },

  discountBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },

  discountText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#43A047',
  },

  gstNote: {
    fontSize: 13,
    color: '#888',
    marginTop: 6,
  },

  /* Details card */
  detailsCard: {
    marginTop: 16,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
  },

  detailsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },

  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },

  detailLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  detailLabel: {
    fontSize: 14,
    color: '#888',
  },

  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },

  /* Footer */
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#4C51C9',
    height: 56,
    borderRadius: 12,
  },

  addBtnDisabled: {
    opacity: 0.6,
  },

  addBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },

  outOfStockBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFEBEE',
    paddingVertical: 14,
    borderRadius: 12,
  },

  outOfStockText: {
    color: '#C62828',
    fontSize: 14,
    fontWeight: '600',
  },
});
