import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { useSettingsStore } from '../../src/store/settingsStore';
import { computeOrderTotals } from '../../src/utils/orderTotals';
import { BarcodeScanner } from '../../src/components/BarcodeScanner';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import type { PackagingLevel } from '../../src/types';

type SearchProduct = {
  id: string;
  name: string;
  company: string | null;
  selling_price: number;
  gst_percent: number;
  stock_quantity: number;
  unit: string | null;
};

type PackagingChoice = {
  level_id: string | null;
  level_name: string;
  units_per_level: number;
};

type OrderItem = {
  product_id: string;
  name: string;
  quantity: number;
  selling_price: number;
  gst_percent: number;
};

type ExistingOrder = {
  id: string;
  order_number: string;
  user_id: string;
  user_name: string;
  user_phone: string;
  items: OrderItem[];
  subtotal: number;
  gst: number;
  grand_total: number;
  delivery_address: string;
  delivery_type: string;
  payment_mode: string;
  notes?: string;
  status: string;
};

const PAGE_SIZE = 20;

export default function DeliveryEditOrder() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const settings = useSettingsStore((s) => s.settings);
  const gstEnabled = settings?.features?.gst_enabled ?? true;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState<ExistingOrder | null>(null);
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [qtyByProduct, setQtyByProduct] = useState<Record<string, number>>({});

  // Barcode scanner state
  const [scannerVisible, setScannerVisible] = useState(false);

  // Paginated search state
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const productOffset = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Packaging state
  const [packagingByProduct, setPackagingByProduct] = useState<Record<string, PackagingLevel[]>>({});
  const [selectedPackaging, setSelectedPackaging] = useState<Record<string, PackagingChoice>>({});

  const selectedItems = useMemo(() => {
    return products
      .filter((product) => (qtyByProduct[product.id] || 0) > 0)
      .map((product) => ({
        product_id: product.id,
        name: product.name,
        quantity: qtyByProduct[product.id] || 0,
        selling_price: product.selling_price,
        gst_percent: product.gst_percent,
      }));
  }, [products, qtyByProduct]);

  const { subtotal, gst, grandTotal } = useMemo(
    () => computeOrderTotals(
      selectedItems.map((i) => ({
        selling_price: i.selling_price,
        quantity: i.quantity,
        gst_percent: i.gst_percent,
      })),
      gstEnabled,
    ),
    [selectedItems, gstEnabled],
  );

  /* -------- FETCH PRODUCTS (paginated server-side search) -------- */

  const fetchProducts = useCallback(async (query: string, offset: number, append: boolean) => {
    try {
      if (!append) setIsLoadingProducts(true);
      else setIsLoadingMore(true);

      const { data, error } = await supabase.rpc('search_products', {
        p_query: query.trim() || null,
        p_cursor: offset > 0 ? offset : null,
        p_page_size: PAGE_SIZE,
      });

      if (error) throw error;

      const rows = (data || []) as SearchProduct[];

      // Fetch packaging levels for this batch
      const productIds = rows.map((r) => r.id);
      if (productIds.length > 0) {
        const { data: pkgData } = await supabase
          .from('product_packaging_levels')
          .select('id, product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order')
          .in('product_id', productIds)
          .order('display_order', { ascending: true });

        if (pkgData) {
          const grouped: Record<string, PackagingLevel[]> = {};
          for (const level of pkgData as PackagingLevel[]) {
            if (!grouped[level.product_id]) grouped[level.product_id] = [];
            grouped[level.product_id].push(level);
          }

          setPackagingByProduct((prev) => ({ ...prev, ...grouped }));

          // Auto-select base level for new products
          setSelectedPackaging((prev) => {
            const updated = { ...prev };
            for (const pid of Object.keys(grouped)) {
              if (!updated[pid]) {
                const base = grouped[pid].find((l) => l.is_base) ?? grouped[pid][0];
                if (base) {
                  updated[pid] = {
                    level_id: base.id,
                    level_name: base.level_name,
                    units_per_level: base.units_per_level,
                  };
                }
              }
            }
            return updated;
          });
        }
      }

      if (append) {
        setProducts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const newRows = rows.filter((r) => !existingIds.has(r.id));
          return [...prev, ...newRows];
        });
      } else {
        setProducts(rows);
      }

      if (rows.length < PAGE_SIZE) {
        setHasMore(false);
      } else {
        setHasMore(true);
      }

      productOffset.current = offset + rows.length;
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load products');
    } finally {
      setIsLoadingProducts(false);
      setIsLoadingMore(false);
    }
  }, []);

  // 300ms debounced search
  const onSearchChange = useCallback((text: string) => {
    setProductSearch(text);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      productOffset.current = 0;
      setHasMore(true);
      fetchProducts(text, 0, false);
    }, 300);
  }, [fetchProducts]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const onProductsEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || isLoadingProducts) return;
    fetchProducts(productSearch, productOffset.current, true);
  }, [hasMore, isLoadingMore, isLoadingProducts, productSearch, fetchProducts]);

  /* -------- FETCH ORDER -------- */

  const fetchData = async () => {
    if (!orderId) {
      Alert.alert('Order missing', 'No order ID provided.');
      router.back();
      return;
    }

    try {
      setLoading(true);

      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .single();

      if (orderError) throw orderError;

      const existingOrder = orderData as ExistingOrder;

      // Fetch current profile address (may have been updated by retailer)
      if (existingOrder.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('address, city, state, pincode, name, phone, business_name')
          .eq('id', existingOrder.user_id)
          .single();

        if (profile) {
          const liveAddress = [profile.address, profile.city, profile.state, profile.pincode]
            .filter(Boolean)
            .join(', ');
          if (liveAddress.trim()) {
            existingOrder.delivery_address = liveAddress;
          }
          existingOrder.user_name = profile.name || profile.business_name || existingOrder.user_name;
          existingOrder.user_phone = profile.phone || existingOrder.user_phone;
        }
      }

      setOrder(existingOrder);

      // Pre-populate quantities from existing order items
      const initialQty: Record<string, number> = {};
      if (Array.isArray(existingOrder.items)) {
        existingOrder.items.forEach((item: OrderItem) => {
          if (item.product_id) {
            initialQty[item.product_id] = item.quantity || 0;
          }
        });
      }
      setQtyByProduct(initialQty);

      // Load initial products
      productOffset.current = 0;
      setHasMore(true);
      await fetchProducts('', 0, false);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load order');
      router.back();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [orderId]);

  const isTerminalStatus = order?.status === 'delivered' || order?.status === 'cancelled' || order?.status === 'rejected';

  const changeQty = (productId: string, diff: number) => {
    setQtyByProduct((prev) => {
      const nextValue = Math.max(0, (prev[productId] || 0) + diff);
      return { ...prev, [productId]: nextValue };
    });
  };

  /* -------- BARCODE SCAN -------- */

  const handleBarcodeScan = async (code: string) => {
    try {
      const { data, error } = await supabase.rpc('get_product_by_sku', { p_sku: code });
      if (error) throw error;
      const results = data as any[];
      if (!results || results.length === 0) {
        Alert.alert('Product Not Found', `No product found for barcode: ${code}`);
        return;
      }
      const product = results[0];
      // Increment qty
      setQtyByProduct((prev) => ({
        ...prev,
        [product.id]: (prev[product.id] || 0) + 1,
      }));
      // If product not in visible list, add it
      if (!products.find((p) => p.id === product.id)) {
        setProducts((prev) => [{
          id: product.id,
          name: product.name,
          company: product.company,
          selling_price: product.selling_price,
          gst_percent: product.gst_percent,
          stock_quantity: product.stock_quantity,
          unit: product.unit,
        }, ...prev]);
      }
      Alert.alert('Added', `${product.name} added to order.`);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  /* -------- SAVE ORDER -------- */

  const saveOrder = async () => {
    if (!order) return;

    if (!selectedItems.length) {
      Alert.alert('No Items', 'Add at least one product to save.');
      return;
    }

    if (isTerminalStatus) {
      Alert.alert('Cannot Edit', `This order is ${order!.status} and can no longer be modified.`);
      return;
    }

    setSaving(true);

    try {
      const p_items = selectedItems.map((i) => ({
        product_id: i.product_id,
        qty: i.quantity,
        packaging_level_id: selectedPackaging[i.product_id]?.level_id ?? null,
        units_per_level: selectedPackaging[i.product_id]?.units_per_level ?? 1,
      }));

      const { data, error } = await supabase.rpc('edit_order_items', {
        p_order_id: order.id,
        p_items: p_items,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('order_not_editable')) {
          Alert.alert(
            'Cannot Edit',
            'This order\'s status was updated and can no longer be edited. Please go back and refresh.',
            [{ text: 'OK', onPress: () => router.back() }],
          );
          return;
        }
        if (msg.includes('insufficient_stock')) {
          Alert.alert('Stock Unavailable', 'One or more items do not have enough stock. Please adjust quantities.');
          return;
        }
        if (msg.includes('invalid_transition') || error.code === 'P0001') {
          Alert.alert(
            'Status Changed',
            'This order\'s status was updated by someone else and can no longer be edited. Please go back and refresh.',
            [{ text: 'OK', onPress: () => router.back() }],
          );
          return;
        }
        throw error;
      }

      Alert.alert('Success', 'Order updated successfully.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update order');
    } finally {
      setSaving(false);
    }
  };

  /* -------- RENDER -------- */

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color={colors.switchThumbOff} />
          <Text style={{ color: colors.textMuted, marginTop: 10 }}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const renderProduct = ({ item: product }: { item: SearchProduct }) => {
    const qty = qtyByProduct[product.id] || 0;
    const levels = packagingByProduct[product.id] ?? [];

    return (
      <View style={styles.productRow}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productMeta}>
            ₹{product.selling_price.toFixed(2)} · GST {product.gst_percent}%
          </Text>
          <Text style={[
            styles.stockText,
            product.stock_quantity <= 5 && styles.stockLow,
          ]}>
            Stock: {product.stock_quantity}{product.unit ? ` ${product.unit}` : ''}
          </Text>

          {/* Packaging selector */}
          {levels.length > 1 && (
            <View style={styles.packagingRow}>
              {levels.map((level) => {
                const isSelected = (selectedPackaging[product.id]?.level_id ?? null) === level.id;
                return (
                  <TouchableOpacity
                    key={level.id}
                    style={[styles.packagingChip, isSelected && styles.packagingChipActive]}
                    onPress={() => setSelectedPackaging((prev) => ({
                      ...prev,
                      [product.id]: {
                        level_id: level.id,
                        level_name: level.level_name,
                        units_per_level: level.units_per_level,
                      },
                    }))}
                  >
                    <Text style={[styles.packagingChipText, isSelected && styles.packagingChipTextActive]}>
                      {level.level_name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {levels.length === 1 && (
            <Text style={styles.packagingSingleLabel}>{levels[0].level_name}</Text>
          )}
        </View>

        <View style={styles.qtyRow}>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, -1)}>
            <Ionicons name="remove" size={16} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.qtyText}>{qty}</Text>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, 1)}>
            <Ionicons name="add" size={16} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderProductsFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      );
    }
    if (!hasMore && products.length > 0) {
      return (
        <View style={styles.footerLoader}>
          <Text style={styles.allLoadedText}>All products loaded</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: `Edit #${order.order_number}` }} />

      {/* Terminal status banner */}
      {isTerminalStatus && (
        <View style={{ backgroundColor: colors.warningBg, borderRadius: 10, padding: 12, margin: 16, marginBottom: 0, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 }}>
          <Ionicons name="lock-closed" size={18} color={colors.warning} />
          <Text style={{ flex: 1, color: colors.warning, fontSize: 13 }}>
            This order is {order.status} and cannot be edited.
          </Text>
        </View>
      )}

      {/* Order info header */}
      <View style={styles.orderInfoSection}>
        <Text style={styles.sectionTitle}>Order Info</Text>
        <Text style={styles.retailerTitle}>#{order.order_number}</Text>
        <Text style={styles.retailerMeta}>
          {order.user_name || 'Retailer'} · {order.user_phone || '—'}
        </Text>
        <Text style={styles.retailerMeta}>Status: {order.status}</Text>
      </View>

      {/* Search input with barcode scan */}
      <View style={styles.searchSection}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search product"
            placeholderTextColor={colors.textMuted}
            value={productSearch}
            onChangeText={onSearchChange}
          />
          {productSearch.length > 0 && (
            <TouchableOpacity onPress={() => onSearchChange('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={{ paddingLeft: 8, paddingVertical: 6 }}
          onPress={() => setScannerVisible(true)}
        >
          <Ionicons name="barcode-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Product list with pagination */}
      {isLoadingProducts ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderProduct}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 200 }}
          onEndReached={onProductsEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderProductsFooter}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No products found.</Text>
            </View>
          }
        />
      )}

      {/* Summary + Save footer */}
      <View style={styles.footer}>
        {selectedItems.length > 0 && (
          <View style={styles.summaryCompact}>
            <Text style={styles.summaryCompactText}>
              {selectedItems.length} items · ₹{subtotal.toFixed(2)}
              {gstEnabled ? ` + ₹${gst.toFixed(2)} GST` : ''}
            </Text>
            <Text style={styles.summaryGrandTotal}>₹{grandTotal.toFixed(2)}</Text>
          </View>
        )}
        <TouchableOpacity
          style={[styles.submitBtn, (saving || selectedItems.length === 0 || isTerminalStatus) && { opacity: 0.6 }]}
          disabled={saving || selectedItems.length === 0 || isTerminalStatus}
          onPress={saveOrder}
        >
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.submitText}>Save Changes</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Barcode Scanner */}
      <BarcodeScanner
        visible={scannerVisible}
        onScan={handleBarcodeScan}
        onClose={() => setScannerVisible(false)}
      />
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
  orderInfoSection: {
    backgroundColor: c.surface,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700' as const, color: c.text, marginBottom: 6 },
  retailerTitle: { fontSize: 14, fontWeight: '700' as const, color: c.text },
  retailerMeta: { marginTop: 3, color: c.textSecondary, fontSize: 13 },
  searchSection: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: c.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    backgroundColor: c.background,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: c.text,
    fontSize: 14,
  },
  productRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
    backgroundColor: c.surface,
    paddingHorizontal: 12,
    marginTop: 1,
  },
  productName: { fontSize: 14, color: c.text, fontWeight: '600' as const },
  productMeta: { marginTop: 2, fontSize: 12, color: c.textSecondary },
  stockText: { marginTop: 2, fontSize: 11, color: c.success },
  stockLow: { color: c.warning },
  qtyRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: c.borderLight,
  },
  qtyText: { minWidth: 20, textAlign: 'center' as const, fontWeight: '700' as const, color: c.text },
  emptyWrap: { marginTop: 40, alignItems: 'center' as const },
  emptyText: { marginTop: 8, color: c.textMuted },
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center' as const,
  },
  allLoadedText: {
    fontSize: 13,
    color: c.textMuted,
  },
  summaryCompact: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    marginBottom: 10,
  },
  summaryCompactText: { fontSize: 13, color: c.textSecondary },
  summaryGrandTotal: { fontSize: 16, fontWeight: '700' as const, color: c.primary },
  footer: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 16,
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: c.primary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  submitText: { color: c.surface, fontSize: 16, fontWeight: '700' as const },

  /* Packaging selector */
  packagingRow: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: 6,
    marginTop: 6,
  },
  packagingChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  packagingChipActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },
  packagingChipText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: c.textSecondary,
    textTransform: 'capitalize' as const,
  },
  packagingChipTextActive: {
    color: c.primary,
  },
  packagingSingleLabel: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 4,
    textTransform: 'capitalize' as const,
  },
};
}
