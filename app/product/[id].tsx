import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, Category, Brand } from '../../src/types';
import api from '../../src/services/api';

export default function ProductDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>() as { id: string };
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();
  
  const [product, setProduct] = useState<Product | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const isVerified = user?.role === 'verified_retailer' || user?.role === 'admin';
  const showPrices = settings?.features.show_prices_to_unverified || isVerified;

  useEffect(() => {
    fetchProduct();
  }, [id]);

  const fetchProduct = async () => {
    try {
      const response = await api.get(`/products/${id}`);
      setProduct(response.data);
      setQuantity(response.data.min_order_quantity || 1);
      
      // Fetch category and brand
      if (response.data.category_id) {
        const categories = await api.get('/categories');
        const cat = categories.data.find((c: Category) => c.id === response.data.category_id);
        setCategory(cat || null);
      }
      if (response.data.brand_id) {
        const brands = await api.get('/brands');
        const br = brands.data.find((b: Brand) => b.id === response.data.brand_id);
        setBrand(br || null);
      }
    } catch (error) {
      console.error('Error fetching product:', error);
      Alert.alert('Error', 'Failed to load product');
    } finally {
      setLoading(false);
    }
  };

  const handleAddToCart = async () => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }
    
    setAdding(true);
    const success = await addToCart(product!.id, quantity);
    setAdding(false);
    
    if (success) {
      Alert.alert('Added to Cart', `${quantity} x ${product!.name} added to your cart`);
    }
  };

  const adjustQuantity = (delta: number) => {
    const minQty = product?.min_order_quantity || 1;
    const newQty = quantity + delta;
    if (newQty >= minQty && newQty <= (product?.stock_quantity || 999)) {
      setQuantity(newQty);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      </SafeAreaView>
    );
  }

  if (!product) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.loadingContainer}>
          <Ionicons name="alert-circle" size={64} color="#ccc" />
          <Text style={styles.errorText}>Product not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const discount = Math.round(((product.mrp - product.selling_price) / product.mrp) * 100);
  const isOutOfStock = product.stock_quantity <= 0;
  const subtotal = product.selling_price * quantity;
  const gstAmount = (subtotal * product.gst_percent) / 100;
  const total = subtotal + gstAmount;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: product.name }} />
      
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Product Image */}
        <View style={styles.imageContainer}>
          {product.image ? (
            <Image source={{ uri: product.image }} style={styles.image} />
          ) : (
            <View style={styles.placeholderImage}>
              <Ionicons name="medical" size={80} color="#1E88E5" />
            </View>
          )}
          {discount > 0 && (
            <View style={styles.discountBadge}>
              <Text style={styles.discountText}>{discount}% OFF</Text>
            </View>
          )}
          {isOutOfStock && (
            <View style={styles.outOfStockBadge}>
              <Text style={styles.outOfStockText}>Out of Stock</Text>
            </View>
          )}
        </View>

        {/* Product Info */}
        <View style={styles.infoContainer}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.sku}>SKU: {product.sku}</Text>
          
          {category && (
            <View style={styles.metaRow}>
              <Ionicons name="folder-outline" size={16} color="#666" />
              <Text style={styles.metaText}>{category.name}</Text>
            </View>
          )}
          
          {brand && (
            <View style={styles.metaRow}>
              <Ionicons name="ribbon-outline" size={16} color="#666" />
              <Text style={styles.metaText}>{brand.name}</Text>
            </View>
          )}

          {showPrices && (
            <View style={styles.priceSection}>
              <View style={styles.priceRow}>
                <Text style={styles.sellingPrice}>₹{product.selling_price.toFixed(2)}</Text>
                {product.mrp > product.selling_price && (
                  <Text style={styles.mrp}>MRP: ₹{product.mrp.toFixed(2)}</Text>
                )}
              </View>
              <Text style={styles.gstInfo}>+ {product.gst_percent}% GST</Text>
            </View>
          )}

          {!showPrices && (
            <View style={styles.loginPromptBox}>
              <Ionicons name="lock-closed" size={20} color="#1E88E5" />
              <Text style={styles.loginPromptText}>Login to see prices</Text>
            </View>
          )}

          {product.description && (
            <View style={styles.descriptionSection}>
              <Text style={styles.sectionTitle}>Description</Text>
              <Text style={styles.description}>{product.description}</Text>
            </View>
          )}

          <View style={styles.detailsSection}>
            <Text style={styles.sectionTitle}>Details</Text>
            
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Stock Available</Text>
              <Text style={[
                styles.detailValue,
                product.stock_quantity < 20 && { color: '#FFA726' },
                isOutOfStock && { color: '#e53935' }
              ]}>
                {isOutOfStock ? 'Out of Stock' : `${product.stock_quantity} units`}
              </Text>
            </View>
            
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Min. Order Quantity</Text>
              <Text style={styles.detailValue}>{product.min_order_quantity} units</Text>
            </View>
            
            {product.expiry_date && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expiry Date</Text>
                <Text style={styles.detailValue}>
                  {new Date(product.expiry_date).toLocaleDateString()}
                </Text>
              </View>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Footer - Add to Cart */}
      {showPrices && !isOutOfStock && (
        <View style={styles.footer}>
          <View style={styles.quantitySection}>
            <TouchableOpacity 
              style={styles.quantityBtn}
              onPress={() => adjustQuantity(-1)}
              disabled={quantity <= product.min_order_quantity}
            >
              <Ionicons name="remove" size={20} color="#1E88E5" />
            </TouchableOpacity>
            <Text style={styles.quantityText}>{quantity}</Text>
            <TouchableOpacity 
              style={styles.quantityBtn}
              onPress={() => adjustQuantity(1)}
              disabled={quantity >= product.stock_quantity}
            >
              <Ionicons name="add" size={20} color="#1E88E5" />
            </TouchableOpacity>
          </View>
          
          <View style={styles.totalSection}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>₹{total.toFixed(2)}</Text>
          </View>
          
          <TouchableOpacity 
            style={[styles.addButton, adding && styles.addButtonDisabled]}
            onPress={handleAddToCart}
            disabled={adding}
          >
            <Ionicons name="cart" size={20} color="#fff" />
            <Text style={styles.addButtonText}>
              {adding ? 'Adding...' : 'Add to Cart'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollView: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
  imageContainer: {
    position: 'relative',
    height: 280,
    backgroundColor: '#fff',
  },
  image: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  placeholderImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  discountBadge: {
    position: 'absolute',
    top: 16,
    left: 16,
    backgroundColor: '#43A047',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  discountText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  outOfStockBadge: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: '#e53935',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  outOfStockText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  infoContainer: {
    padding: 20,
  },
  productName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  sku: {
    fontSize: 14,
    color: '#888',
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  metaText: {
    fontSize: 14,
    color: '#666',
  },
  priceSection: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
  },
  sellingPrice: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1E88E5',
  },
  mrp: {
    fontSize: 16,
    color: '#888',
    textDecorationLine: 'line-through',
  },
  gstInfo: {
    fontSize: 13,
    color: '#888',
    marginTop: 4,
  },
  loginPromptBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e3f2fd',
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
    gap: 8,
  },
  loginPromptText: {
    fontSize: 14,
    color: '#1E88E5',
    fontWeight: '600',
  },
  descriptionSection: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },
  description: {
    fontSize: 14,
    color: '#666',
    lineHeight: 22,
  },
  detailsSection: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  detailLabel: {
    fontSize: 14,
    color: '#666',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    gap: 12,
  },
  quantitySection: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  quantityBtn: {
    padding: 10,
  },
  quantityText: {
    fontSize: 16,
    fontWeight: '600',
    minWidth: 30,
    textAlign: 'center',
  },
  totalSection: {
    flex: 1,
  },
  totalLabel: {
    fontSize: 12,
    color: '#888',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E88E5',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E88E5',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  addButtonDisabled: {
    opacity: 0.7,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
