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
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../src/services/supabase';
import { useSettingsStore } from '../../src/store/settingsStore';
import { computeOrderTotals } from '../../src/utils/orderTotals';
import { BarcodeScanner } from '../../src/components/BarcodeScanner';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import type { PackagingLevel } from '../../src/types';

import { fetchShopLocations, toOrderDeliveryPayload } from '../../src/services/shopLocationService';
import type { RetailerShopLocation } from '../../src/types/shopLocation';
import { DeliverToCard } from '../../src/components/delivery/DeliverToCard';
import { DeliveryAddressFlow } from '../../src/components/delivery/DeliveryAddressFlow';

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
  gstin: string | null;
  email: string | null;
  approved: boolean;
  role: 'admin' | 'retailer' | 'delivery';
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

type PackagingChoice = {
  level_id: string | null;
  level_name: string;
  units_per_level: number;
};

const PAGE_SIZE = 20;

/* ================= SCREEN ================= */

export default function DeliveryCreateOrderItems() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const { t } = useTranslation();
  const router = useRouter();
  const { retailerId } = useLocalSearchParams<{ retailerId: string }>();
  const settings = useSettingsStore((s) => s.settings);

  // P6: Barcode scanner state
  const [scannerVisible, setScannerVisible] = useState(false);

  const [loadingRetailer, setLoadingRetailer] = useState(true);
  const [retailer, setRetailer] = useState<Retailer | null>(null);
  const [shopLocations, setShopLocations] = useState<RetailerShopLocation[]>([]);
  const [selectedShop, setSelectedShop] = useState<RetailerShopLocation | null>(null);
  const [addressFlowOpen, setAddressFlowOpen] = useState(false);
  const [addressError, setAddressError] = useState('');
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

  // Packaging state: levels per product and selected packaging per product
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
          .select('id, name, phone, business_name, address, city, state, pincode, gstin, email, approved, role')
          .eq('id', retailerId)
          .single();

        if (error) throw error;
        setRetailer(data as any);

        try {
          const list = await fetchShopLocations(retailerId);
          setShopLocations(list);
          const def = list.find((l) => l.is_default) || list[0] || null;
          setSelectedShop(def);
        } catch (shopError: any) {
          console.warn('Error fetching shop locations:', shopError);
        }
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

      // Fetch packaging levels for all products in this batch
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

    const hasProfileAddress = !!(retailer.address || retailer.city || retailer.state || retailer.pincode);
    if (!selectedShop && !hasProfileAddress) {
      setAddressError(t('delivery.createOrder.deliveryAddressRequired') || 'Delivery address is required');
      Alert.alert(
        t('common.error') || 'Error',
        t('delivery.createOrder.pleaseSelectAddress') || 'Please select or add a delivery location to continue'
      );
      return;
    }
    setAddressError('');

    const fullAddress = selectedShop
      ? toOrderDeliveryPayload(selectedShop).full_address
      : [retailer.address, retailer.city, retailer.state, retailer.pincode].filter(Boolean).join(', ');

    setSaving(true);

    try {
      const p_items = selectedItems.map((i) => ({
        product_id: i.product_id,
        qty: i.quantity,
        packaging_level_id: selectedPackaging[i.product_id]?.level_id ?? null,
        units_per_level: selectedPackaging[i.product_id]?.units_per_level ?? 1,
      }));

      const { data, error } = await supabase.rpc('place_order', {
        p_retailer_id: retailer.id,
        p_items: p_items,
        p_address: fullAddress,
        p_idempotency_key: idempotencyKey,
        p_payment_mode: 'cod',
        p_redeem_points: 0,
        p_fulfillment_mode: 'delivery',
        p_delivery: selectedShop ? toOrderDeliveryPayload(selectedShop) : null,
        p_notes: '',
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
          <ActivityIndicator size="large" color={colors.primary} />
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
      </View>

      {/* Deliver To location card */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <DeliverToCard
          location={selectedShop}
          error={addressError}
          onChange={() => setAddressFlowOpen(true)}
        />
        {!selectedShop && !!(retailer?.address || retailer?.city || retailer?.state || retailer?.pincode) && (
          <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 12, paddingHorizontal: 4 }}>
            ℹ️ No shop location selected. Will deliver to retailer's profile address.
          </Text>
        )}
      </View>

      {/* Search input with 300ms debounce */}
      <View style={styles.searchSection}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('delivery.createOrder.searchProducts')}
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
        {/* P6: Scan icon */}
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
          {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.submitText}>{t('delivery.createOrder.createOrder')}</Text>}
        </TouchableOpacity>
      </View>

      {/* P6: Barcode Scanner */}
      <BarcodeScanner
        visible={scannerVisible}
        onScan={handleBarcodeScan}
        onClose={() => setScannerVisible(false)}
      />

      {retailer && (
        <DeliveryAddressFlow
          visible={addressFlowOpen}
          onClose={() => setAddressFlowOpen(false)}
          onSelect={(loc) => {
            setSelectedShop(loc);
            setAddressError('');
          }}
          retailerId={retailer.id}
          user={retailer as any}
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  retailerSection: {
    backgroundColor: c.surface,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 6 },
  retailerTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  retailerMeta: { marginTop: 3, color: c.textSecondary },
  retailerAddress: { marginTop: 6, fontSize: 12, color: c.textSecondary },
  searchSection: {
    backgroundColor: c.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
    backgroundColor: c.surface,
    paddingHorizontal: 12,
    marginTop: 1,
  },
  productName: { fontSize: 14, color: c.text, fontWeight: '600' },
  productMeta: { marginTop: 2, fontSize: 12, color: c.textSecondary },
  stockText: { marginTop: 2, fontSize: 11, color: c.success },
  stockLow: { color: c.warning },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.borderLight,
  },
  qtyText: { minWidth: 20, textAlign: 'center', fontWeight: '700', color: c.text },
  emptyWrap: { marginTop: 40, alignItems: 'center' },
  emptyText: { marginTop: 8, color: c.textMuted },
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  allLoadedText: {
    fontSize: 13,
    color: c.textMuted,
  },
  summaryCompact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  summaryCompactText: { fontSize: 13, color: c.textSecondary },
  summaryGrandTotal: { fontSize: 16, fontWeight: '700', color: c.primary },
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: c.surface, fontSize: 16, fontWeight: '700' },

  /* Packaging selector */
  packagingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  packagingChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSecondary,
  },
  packagingChipActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },
  packagingChipText: {
    fontSize: 11,
    fontWeight: '600',
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
