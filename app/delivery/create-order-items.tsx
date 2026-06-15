import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../src/services/supabase';
import { useSettingsStore } from '../../src/store/settingsStore';
import { computeOrderTotals } from '../../src/utils/orderTotals';
import { BarcodeScanner } from '../../src/components/BarcodeScanner';

/* ================= TYPES ================= */

type Retailer = {
  id: string;
  name: string | null;
  phone: string | null;
  business_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

type SearchProduct = {
  id: string;
  name: string;
  company: string | null;
  selling_price: number;
  gst_percent: number;
  stock_quantity: number;
  unit: string | null;
};

const PAGE_SIZE = 20;

/* ================= SCREEN ================= */

export default function DeliveryCreateOrderItems() {
  const { t } = useTranslation();
  const router = useRouter();
  const { retailerId } = useLocalSearchParams<{ retailerId: string }>();
  const settings = useSettingsStore((s) => s.settings);

  // P6: Barcode scanner state
  const [scannerVisible, setScannerVisible] = useState(false);

  const [loadingRetailer, setLoadingRetailer] = useState(true);
  const [retailer, setRetailer] = useState<Retailer | null>(null);
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [qtyByProduct, setQtyByProduct] = useState<Record<string, number>>({});
  const [idempotencyKey] = useState(() => uuidv4());
  const [saving, setSaving] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const productOffset = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gstEnabled = settings?.features?.gst_enabled ?? true;

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

  /* -------- FETCH RETAILER -------- */

  useEffect(() => {
    if (!retailerId) {
      Alert.alert('Retailer missing', 'Please select retailer first.');
      router.replace('/delivery/create-order');
      return;
    }

    (async () => {
      try {
        setLoadingRetailer(true);
        const { data, error } = await supabase
          .from('profiles')
          .select('id, name, phone, business_name, address, city, state, pincode')
          .eq('id', retailerId)
          .single();

        if (error) throw error;
        setRetailer(data);
      } catch (error: any) {
        Alert.alert('Error', error.message || 'Failed to load retailer');
        router.replace('/delivery/create-order');
      } finally {
        setLoadingRetailer(false);
      }
    })();
  }, [retailerId]);

  /* -------- SEARCH PRODUCTS (replaces unbounded products query with search_products RPC) -------- */

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
      Alert.alert(t('common.error'), error.message || t('common.error'));
    } finally {
      setIsLoadingProducts(false);
      setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    productOffset.current = 0;
    setHasMore(true);
    fetchProducts('', 0, false);
  }, []);

  // 300ms debounced search — cancels previous call if a new keystroke arrives
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

  /* -------- QTY CONTROLS -------- */

  const changeQty = (productId: string, diff: number) => {
    setQtyByProduct((prev) => {
      const nextValue = Math.max(0, (prev[productId] || 0) + diff);
      return { ...prev, [productId]: nextValue };
    });
  };

  /* -------- CREATE ORDER -------- */

  const createOrder = async () => {
    if (!retailer) {
      Alert.alert(t('delivery.createOrder.retailerMissing'), t('delivery.createOrder.selectRetailerFirst'));
      return;
    }

    if (!selectedItems.length) {
      Alert.alert(t('delivery.createOrder.noItems'), t('delivery.createOrder.addAtLeast'));
      return;
    }

    const fullAddress = [retailer.address, retailer.city, retailer.state, retailer.pincode]
      .filter(Boolean)
      .join(', ');

    setSaving(true);

    try {
      const p_items = selectedItems.map((i) => ({
        product_id: i.product_id,
        qty: i.quantity,
      }));

      const { data, error } = await supabase.rpc('place_order', {
        p_retailer_id: retailer.id,
        p_items: p_items,
        p_address: fullAddress,
        p_idempotency_key: idempotencyKey,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('insufficient_stock')) {
          Alert.alert(t('delivery.createOrder.stockUnavailable'), t('delivery.createOrder.stockUnavailableMsg'));
        } else if (msg.includes('not_approved')) {
          Alert.alert(t('delivery.createOrder.retailerNotApproved'), t('delivery.createOrder.retailerNotApprovedMsg'));
        } else if (msg.includes('not_authorized')) {
          Alert.alert(t('delivery.createOrder.notAuthorized'), t('delivery.createOrder.notAuthorizedMsg'));
        } else {
          Alert.alert(t('common.error'), msg || t('common.error'));
        }
        return;
      }

      const result = data as { order_id: string; order_number: string; already_exists: boolean };

      if (result.already_exists) {
        Alert.alert(t('delivery.createOrder.duplicate'), t('delivery.createOrder.alreadyCreated', { orderNumber: result.order_number }));
      }

      Alert.alert(t('common.success'), t('delivery.createOrder.orderCreated', { orderNumber: result.order_number }), [
        { text: t('common.ok'), onPress: () => router.replace('/delivery/orders') },
      ]);
    } catch (error: any) {
      Alert.alert(t('common.error'), error.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  // P6: Handle barcode scan — look up by SKU and auto-add
  const handleBarcodeScan = async (code: string) => {
    try {
      const { data, error } = await supabase.rpc('get_product_by_sku', { p_sku: code });
      if (error) throw error;
      const results = data as any[];
      if (!results || results.length === 0) {
        Alert.alert(t('admin.stockScreen.productNotFound'), t('admin.stockScreen.skuNotFound', { code }));
        return;
      }
      const product = results[0];
      // Add to qty map — increment if already selected
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
      Alert.alert(t('common.success'), t('delivery.createOrder.addedToOrder', { name: product.name }));
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message);
    }
  };

  /* -------- RENDER -------- */

  if (loadingRetailer) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  const renderProduct = ({ item: product }: { item: SearchProduct }) => {
    const qty = qtyByProduct[product.id] || 0;

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
        </View>

        <View style={styles.qtyRow}>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, -1)}>
            <Ionicons name="remove" size={16} color="#333" />
          </TouchableOpacity>
          <Text style={styles.qtyText}>{qty}</Text>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(product.id, 1)}>
            <Ionicons name="add" size={16} color="#333" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderProductsFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color="#4C51C9" />
        </View>
      );
    }
    if (!hasMore && products.length > 0) {
      return (
        <View style={styles.footerLoader}>
          <Text style={styles.allLoadedText}>{t('delivery.createOrder.allProductsLoaded')}</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: t('delivery.createOrder.title') }} />

      {/* Retailer info header */}
      <View style={styles.retailerSection}>
        <Text style={styles.sectionTitle}>{t('delivery.createOrder.retailerSelected')}</Text>
        <Text style={styles.retailerTitle}>{retailer?.business_name || retailer?.name || 'Retailer'}</Text>
        <Text style={styles.retailerMeta}>{retailer?.name || '—'} · {retailer?.phone || '—'}</Text>
        {!!retailer?.address && (
          <Text style={styles.retailerAddress}>
            {[retailer.address, retailer.city, retailer.state, retailer.pincode].filter(Boolean).join(', ')}
          </Text>
        )}
      </View>

      {/* Search input with 300ms debounce */}
      <View style={styles.searchSection}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color="#888" />
          <TextInput
            style={styles.searchInput}
            placeholder={t('delivery.createOrder.searchProducts')}
            placeholderTextColor="#999"
            value={productSearch}
            onChangeText={onSearchChange}
          />
          {productSearch.length > 0 && (
            <TouchableOpacity onPress={() => onSearchChange('')}>
              <Ionicons name="close-circle" size={18} color="#999" />
            </TouchableOpacity>
          )}
        </View>
        {/* P6: Scan icon */}
        <TouchableOpacity
          style={{ paddingLeft: 8, paddingVertical: 6 }}
          onPress={() => setScannerVisible(true)}
        >
          <Ionicons name="barcode-outline" size={22} color="#4C51C9" />
        </TouchableOpacity>
      </View>

      {/* Product list with pagination */}
      {isLoadingProducts ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
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
              <Text style={styles.emptyText}>{t('delivery.createOrder.noProductsFound')}</Text>
            </View>
          }
        />
      )}

      {/* Summary + Create Order footer */}
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
          style={[styles.submitBtn, (saving || selectedItems.length === 0) && { opacity: 0.6 }]}
          disabled={saving || selectedItems.length === 0}
          onPress={createOrder}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{t('delivery.createOrder.createOrder')}</Text>}
        </TouchableOpacity>
      </View>

      {/* P6: Barcode Scanner */}
      <BarcodeScanner
        visible={scannerVisible}
        onScan={handleBarcodeScan}
        onClose={() => setScannerVisible(false)}
      />
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  retailerSection: {
    backgroundColor: '#fff',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#333', marginBottom: 6 },
  retailerTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  retailerMeta: { marginTop: 3, color: '#666' },
  retailerAddress: { marginTop: 6, fontSize: 12, color: '#777' },
  searchSection: {
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: '#333',
    fontSize: 14,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    marginTop: 1,
  },
  productName: { fontSize: 14, color: '#333', fontWeight: '600' },
  productMeta: { marginTop: 2, fontSize: 12, color: '#777' },
  stockText: { marginTop: 2, fontSize: 11, color: '#43A047' },
  stockLow: { color: '#E65100' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f2',
  },
  qtyText: { minWidth: 20, textAlign: 'center', fontWeight: '700', color: '#333' },
  emptyWrap: { marginTop: 40, alignItems: 'center' },
  emptyText: { marginTop: 8, color: '#888' },
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  allLoadedText: {
    fontSize: 13,
    color: '#999',
  },
  summaryCompact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  summaryCompactText: { fontSize: 13, color: '#666' },
  summaryGrandTotal: { fontSize: 16, fontWeight: '700', color: '#4C51C9' },
  footer: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    padding: 16,
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
