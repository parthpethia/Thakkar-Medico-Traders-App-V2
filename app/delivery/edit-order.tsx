import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  ScrollView,
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

type DBOrderItem = {
  product_id: string;
  qty?: number;
  quantity?: number;
  packaging_level_id?: string | null;
  units_per_level?: number;
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
  items: DBOrderItem[];
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
  const [productDetails, setProductDetails] = useState<Record<string, SearchProduct>>({});

  const qtyByProductRef = useRef(qtyByProduct);
  qtyByProductRef.current = qtyByProduct;

  const productDetailsRef = useRef(productDetails);
  productDetailsRef.current = productDetails;

  // Barcode scanner state
  const [scannerVisible, setScannerVisible] = useState(false);

  // Paginated search state
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const productOffset = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New Category Filtering, Frequently Ordered & Cart Modal States
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [freqProducts, setFreqProducts] = useState<SearchProduct[]>([]);
  const [freqLoading, setFreqLoading] = useState(false);
  const [cartModalOpen, setCartModalOpen] = useState(false);

  // Packaging state
  const [packagingByProduct, setPackagingByProduct] = useState<Record<string, PackagingLevel[]>>({});
  const [selectedPackaging, setSelectedPackaging] = useState<Record<string, PackagingChoice>>({});

  const setQty = useCallback((productId: string, value: number) => {
    setQtyByProduct((prev) => ({
      ...prev,
      [productId]: Math.max(0, value),
    }));
  }, []);

  const clearCart = () => {
    Alert.alert('Clear Cart', 'Are you sure you want to remove all items from this order?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: () => {
          setQtyByProduct({});
          setCartModalOpen(false);
        },
      },
    ]);
  };

  const renderProduct = useCallback(({ item: product }: { item: SearchProduct }) => {
    const qty = qtyByProduct[product.id] || 0;
    const levels = packagingByProduct[product.id] ?? [];
    const selectedChoice = selectedPackaging[product.id];

    return (
      <ProductRow
        product={product}
        qty={qty}
        levels={levels}
        selectedPackagingChoice={selectedChoice}
        onLevelSelect={(productId, choice) => {
          setSelectedPackaging((prev) => ({
            ...prev,
            [productId]: choice,
          }));
        }}
        onQtyChange={setQty}
        searchQuery={productSearch}
        colors={colors}
        styles={styles}
      />
    );
  }, [qtyByProduct, packagingByProduct, selectedPackaging, productSearch, colors, styles, setQty]);

  const selectedItems = useMemo(() => {
    return Object.keys(qtyByProduct)
      .filter((id) => qtyByProduct[id] > 0)
      .map((id) => {
        const product = productDetails[id];
        return {
          product_id: id,
          name: product?.name || 'Unknown Product',
          quantity: qtyByProduct[id],
          selling_price: product?.selling_price || 0,
          gst_percent: product?.gst_percent || 0,
        };
      });
  }, [qtyByProduct, productDetails]);

  const { subtotal, gst, grandTotal } = useMemo(
    () => computeOrderTotals(
      selectedItems.map((i) => ({
        selling_price: i.selling_price,
        quantity: i.quantity * (selectedPackaging[i.product_id]?.units_per_level ?? 1),
        gst_percent: i.gst_percent,
      })),
      gstEnabled,
    ),
    [selectedItems, selectedPackaging, gstEnabled],
  );

  /* -------- FETCH CATEGORIES & FREQUENT PRODUCTS -------- */

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from('categories')
          .select('name')
          .eq('is_active', true)
          .order('name');
        if (!error && data) {
          setCategories(data.map((c) => c.name));
        }
      } catch (err) {
        console.warn('Failed to load categories:', err);
      }
    })();
  }, []);

  const fetchFrequentlyOrdered = async (retId: string) => {
    try {
      setFreqLoading(true);
      const { data: ordersData, error: ordersErr } = await supabase
        .from('orders')
        .select('items')
        .eq('user_id', retId)
        .order('created_at', { ascending: false })
        .limit(15);

      if (ordersErr) throw ordersErr;

      const counts: Record<string, number> = {};
      (ordersData || []).forEach((ord: any) => {
        const items = Array.isArray(ord.items) ? ord.items : [];
        items.forEach((item: any) => {
          if (item.product_id) {
            counts[item.product_id] = (counts[item.product_id] || 0) + (item.qty ?? item.quantity ?? 1);
          }
        });
      });

      const sortedIds = Object.keys(counts)
        .sort((a, b) => counts[b] - counts[a])
        .slice(0, 8);

      if (sortedIds.length > 0) {
        const { data: pData, error: pErr } = await supabase
          .from('products')
          .select('id, name, company, selling_price, gst_percent, stock_quantity, pack_size')
          .in('id', sortedIds);

        if (pErr) throw pErr;

        const resolvedProducts = (pData || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          company: p.company,
          selling_price: p.selling_price,
          gst_percent: p.gst_percent,
          stock_quantity: p.stock_quantity,
          unit: p.pack_size,
        })) as SearchProduct[];

        setProductDetails((prev) => {
          const next = { ...prev };
          resolvedProducts.forEach((p) => {
            next[p.id] = p;
          });
          return next;
        });

        const { data: pkgData } = await supabase
          .from('product_packaging_levels')
          .select('id, product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order')
          .in('product_id', sortedIds)
          .order('display_order', { ascending: true });

        if (pkgData) {
          const grouped: Record<string, PackagingLevel[]> = {};
          for (const lvl of pkgData as PackagingLevel[]) {
            if (!grouped[lvl.product_id]) grouped[lvl.product_id] = [];
            grouped[lvl.product_id].push(lvl);
          }
          setPackagingByProduct((prev) => ({ ...prev, ...grouped }));
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

        setFreqProducts(resolvedProducts);
      }
    } catch (err) {
      console.warn('Failed to load frequently ordered items:', err);
    } finally {
      setFreqLoading(false);
    }
  };

  /* -------- FETCH PRODUCTS (paginated server-side search) -------- */

  const fetchProducts = useCallback(async (query: string, offset: number, append: boolean, categoryFilter: string | null = selectedCategory) => {
    try {
      if (!append) setIsLoadingProducts(true);
      else setIsLoadingMore(true);

      const { data, error } = await supabase.rpc('search_products', {
        p_query: query.trim() || null,
        p_cursor: offset > 0 ? offset : null,
        p_page_size: PAGE_SIZE,
        p_category: categoryFilter,
        p_hide_out_of_stock: false,
      });

      if (error) throw error;

      const rows = (data || []) as SearchProduct[];

      // Update productDetails state with newly fetched products
      setProductDetails((prev) => {
        const next = { ...prev };
        rows.forEach((p) => {
          next[p.id] = p;
        });
        return next;
      });

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

      // Determine final rows to show (prepend existing active order items if search is empty)
      let finalRows = rows;
      if (!append && query.trim() === '') {
        const currentQty = qtyByProductRef.current;
        const currentDetails = productDetailsRef.current;
        const existingActiveProducts = Object.keys(currentQty)
          .filter((id) => (currentQty[id] || 0) > 0)
          .map((id) => currentDetails[id])
          .filter((p): p is SearchProduct => !!p);

        const activeIds = new Set(existingActiveProducts.map((p) => p.id));
        const nonDuplicateRows = rows.filter((r) => !activeIds.has(r.id));
        finalRows = [...existingActiveProducts, ...nonDuplicateRows];
      }

      if (append) {
        setProducts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const newRows = finalRows.filter((r) => !existingIds.has(r.id));
          return [...prev, ...newRows];
        });
      } else {
        setProducts(finalRows);
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
  }, [selectedCategory]);

  const handleCategoryChange = (category: string | null) => {
    setSelectedCategory(category);
    productOffset.current = 0;
    setHasMore(true);
    fetchProducts(productSearch, 0, false, category);
  };

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
        fetchFrequentlyOrdered(existingOrder.user_id);
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

      // Fetch full details and packaging levels for all products already in the order
      const rawItems = Array.isArray(existingOrder.items) ? (existingOrder.items as DBOrderItem[]) : [];
      const existingProductIds = [...new Set(rawItems.map((i) => i.product_id).filter(Boolean))];

      const initialDetails: Record<string, SearchProduct> = {};
      const initialQty: Record<string, number> = {};
      const initialPackaging: Record<string, PackagingChoice> = {};
      const initialGroupedPkgs: Record<string, PackagingLevel[]> = {};

      if (existingProductIds.length > 0) {
        const { data: pData, error: pErr } = await supabase
          .from('products')
          .select('id, name, company, selling_price, gst_percent, stock_quantity, pack_size')
          .in('id', existingProductIds);
        if (pErr) throw pErr;

        (pData || []).forEach((p: any) => {
          initialDetails[p.id] = {
            id: p.id,
            name: p.name,
            company: p.company,
            selling_price: p.selling_price,
            gst_percent: p.gst_percent,
            stock_quantity: p.stock_quantity,
            unit: p.pack_size,
          };
        });

        const { data: pkgData, error: pkgErr } = await supabase
          .from('product_packaging_levels')
          .select('id, product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order')
          .in('product_id', existingProductIds)
          .order('display_order', { ascending: true });
        if (pkgErr) throw pkgErr;

        (pkgData || []).forEach((level) => {
          if (!initialGroupedPkgs[level.product_id]) initialGroupedPkgs[level.product_id] = [];
          initialGroupedPkgs[level.product_id].push(level as PackagingLevel);
        });

        rawItems.forEach((item) => {
          const qty = item.qty ?? item.quantity ?? 0;
          if (item.product_id) {
            const levels = initialGroupedPkgs[item.product_id] || [];
            const match = levels.find((l) => l.id === item.packaging_level_id);
            let units_per_level = 1;
            if (match) {
              initialPackaging[item.product_id] = {
                level_id: match.id,
                level_name: match.level_name,
                units_per_level: match.units_per_level,
              };
              units_per_level = match.units_per_level;
            } else if (levels.length > 0) {
              const base = levels.find((l) => l.is_base) ?? levels[0];
              initialPackaging[item.product_id] = {
                level_id: base.id,
                level_name: base.level_name,
                units_per_level: base.units_per_level,
              };
              units_per_level = base.units_per_level;
            }
            initialQty[item.product_id] = qty / units_per_level;
          }
        });
      }

      setOrder(existingOrder);
      setQtyByProduct(initialQty);
      setSelectedPackaging(initialPackaging);
      setPackagingByProduct(initialGroupedPkgs);

      // Now fetch initial page of products
      const { data: initialProductsData, error: initialProductsErr } = await supabase.rpc('search_products', {
        p_query: null,
        p_cursor: null,
        p_page_size: PAGE_SIZE,
        p_hide_out_of_stock: false,
      });
      if (initialProductsErr) throw initialProductsErr;
      const initialProducts = (initialProductsData || []) as SearchProduct[];

      // Merge product details map
      const detailsMap = { ...initialDetails };
      initialProducts.forEach((p) => {
        detailsMap[p.id] = p;
      });
      setProductDetails(detailsMap);

      // Fetch packaging for initial products that aren't already loaded
      const unloadedInitialProductIds = initialProducts.map((p) => p.id).filter(id => !initialGroupedPkgs[id]);
      if (unloadedInitialProductIds.length > 0) {
        const { data: pkgData } = await supabase
          .from('product_packaging_levels')
          .select('id, product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order')
          .in('product_id', unloadedInitialProductIds)
          .order('display_order', { ascending: true });

        if (pkgData) {
          const grouped = { ...initialGroupedPkgs };
          const defaultPackaging = { ...initialPackaging };

          for (const level of pkgData as PackagingLevel[]) {
            if (!grouped[level.product_id]) grouped[level.product_id] = [];
            grouped[level.product_id].push(level);
          }

          unloadedInitialProductIds.forEach((pid) => {
            const levels = grouped[pid] || [];
            if (levels.length > 0 && !defaultPackaging[pid]) {
              const base = levels.find((l) => l.is_base) ?? levels[0];
              defaultPackaging[pid] = {
                level_id: base.id,
                level_name: base.level_name,
                units_per_level: base.units_per_level,
              };
            }
          });

          setPackagingByProduct(grouped);
          setSelectedPackaging(defaultPackaging);
        }
      }

      // Populate final products list (existing items first, then others)
      const existingActiveList = Object.keys(initialQty)
        .filter((id) => initialQty[id] > 0)
        .map((id) => initialDetails[id])
        .filter((p): p is SearchProduct => !!p);

      const activeIds = new Set(existingActiveList.map((p) => p.id));
      const nonDuplicateInitial = initialProducts.filter((p) => !activeIds.has(p.id));

      setProducts([...existingActiveList, ...nonDuplicateInitial]);
      setHasMore(initialProducts.length >= PAGE_SIZE);
      productOffset.current = initialProducts.length;
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
      // Add product to details registry
      setProductDetails((prev) => ({
        ...prev,
        [product.id]: {
          id: product.id,
          name: product.name,
          company: product.company,
          selling_price: product.selling_price,
          gst_percent: product.gst_percent,
          stock_quantity: product.stock_quantity,
          unit: product.unit,
        },
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
    <View style={styles.container}>
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

      {/* Category selector strip */}
      {categories.length > 0 && (
        <View style={styles.categoriesSection}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoriesScroll}>
            <TouchableOpacity
              style={[styles.categoryPill, selectedCategory === null && styles.categoryPillActive]}
              onPress={() => handleCategoryChange(null)}
              activeOpacity={0.8}
            >
              <Text style={[styles.categoryPillText, selectedCategory === null && styles.categoryPillTextActive]}>
                All
              </Text>
            </TouchableOpacity>
            {categories.map((cat) => {
              const isSelected = selectedCategory === cat;
              return (
                <TouchableOpacity
                  key={cat}
                  style={[styles.categoryPill, isSelected && styles.categoryPillActive]}
                  onPress={() => handleCategoryChange(cat)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.categoryPillText, isSelected && styles.categoryPillTextActive]}>
                    {cat}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Frequently ordered section */}
      {!productSearch && freqProducts.length > 0 && (
        <View style={styles.freqSection}>
          <View style={styles.freqHeader}>
            <Ionicons name="sparkles" size={15} color={colors.primary} />
            <Text style={styles.freqTitle}>Frequently Ordered</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.freqScroll}>
            {freqProducts.map((prod) => {
              const qty = qtyByProduct[prod.id] || 0;
              return (
                <TouchableOpacity
                  key={prod.id}
                  style={[styles.freqCard, qty > 0 && styles.freqCardActive]}
                  onPress={qty === 0 ? () => changeQty(prod.id, 1) : undefined}
                  activeOpacity={qty === 0 ? 0.8 : 1}
                >
                  {qty > 0 && (
                    <View style={styles.freqBadge}>
                      <Text style={styles.freqBadgeText}>{qty}</Text>
                    </View>
                  )}
                  <Text style={styles.freqName} numberOfLines={1}>{prod.name}</Text>
                  <Text style={styles.freqCompany} numberOfLines={1}>{prod.company || '—'}</Text>
                  <Text style={styles.freqPrice}>₹{prod.selling_price.toFixed(2)}</Text>
                  
                  {qty > 0 ? (
                    <View style={styles.freqQtyRow}>
                      <TouchableOpacity style={styles.freqQtyBtn} onPress={() => changeQty(prod.id, -1)}>
                        <Ionicons name="remove" size={12} color={colors.text} />
                      </TouchableOpacity>
                      <Text style={styles.freqQtyText}>{qty}</Text>
                      <TouchableOpacity style={styles.freqQtyBtn} onPress={() => changeQty(prod.id, 1)}>
                        <Ionicons name="add" size={12} color={colors.text} />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.freqAddBtn}>
                      <Ionicons name="add" size={14} color={colors.textSecondary} />
                      <Text style={styles.freqAddBtnText}>Add</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

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
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          onEndReached={onProductsEndReached}
          onEndReachedThreshold={0.3}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          ListFooterComponent={renderProductsFooter}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No products found.</Text>
            </View>
          }
        />
      )}

      {/* Floating Cart Badge */}
      {selectedItems.length > 0 && (
        <TouchableOpacity
          style={styles.cartFab}
          onPress={() => setCartModalOpen(true)}
          activeOpacity={0.8}
        >
          <View style={styles.cartFabBadge}>
            <Text style={styles.cartFabBadgeText}>{selectedItems.length}</Text>
          </View>
          <Ionicons name="cart" size={24} color={colors.surface} />
        </TouchableOpacity>
      )}

      {/* Summary + Save footer */}
      <View style={styles.footer}>
        {selectedItems.length > 0 && (
          <View style={styles.summaryCompact}>
            <TouchableOpacity onPress={() => setCartModalOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="cart-outline" size={16} color={colors.primary} />
              <Text style={[styles.summaryCompactText, { color: colors.primary, fontWeight: '600' }]}>
                {selectedItems.length} items (Review)
              </Text>
            </TouchableOpacity>
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

      {/* Review Cart Modal */}
      <Modal
        visible={cartModalOpen}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setCartModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Order Cart ({selectedItems.length} items)</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {selectedItems.length > 0 && (
                  <TouchableOpacity onPress={clearCart} style={styles.clearCartBtn}>
                    <Text style={styles.clearCartBtnText}>Clear All</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setCartModalOpen(false)} style={{ padding: 4 }}>
                  <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            {selectedItems.length === 0 ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ color: colors.textMuted }}>No items selected yet</Text>
              </View>
            ) : (
              <FlatList
                data={selectedItems}
                keyExtractor={(item) => item.product_id}
                style={{ maxHeight: 250 }}
                renderItem={({ item }) => {
                  const activeLevelName = selectedPackaging[item.product_id]?.level_name || '';
                  return (
                    <View style={styles.cartItemRow}>
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text style={styles.cartItemName}>{item.name}</Text>
                        <Text style={styles.cartItemMeta}>
                          ₹{item.selling_price.toFixed(2)} {activeLevelName ? `per ${activeLevelName}` : ''}
                        </Text>
                      </View>
                      <View style={styles.qtyRow}>
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(item.product_id, -1)}>
                          <Ionicons name="remove" size={14} color={colors.text} />
                        </TouchableOpacity>
                        <TextInput
                          style={styles.qtyInput}
                          value={item.quantity === 0 ? '' : item.quantity.toString()}
                          onChangeText={(text) => {
                            const clean = text.replace(/[^0-9]/g, '');
                            const parsed = clean === '' ? 0 : parseInt(clean, 10);
                            setQty(item.product_id, parsed);
                          }}
                          keyboardType="numeric"
                          selectTextOnFocus
                        />
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(item.product_id, 1)}>
                          <Ionicons name="add" size={14} color={colors.text} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                }}
              />
            )}

            <View style={styles.modalFooter}>
              <View style={styles.modalTotals}>
                <Text style={styles.modalTotalsText}>Subtotal: ₹{subtotal.toFixed(2)}</Text>
                <Text style={styles.modalGrandTotal}>Total: ₹{grandTotal.toFixed(2)}</Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setCartModalOpen(false)}
              >
                <Text style={styles.modalCloseBtnText}>Continue Selecting</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const ProductRow = React.memo(({
  product,
  qty,
  levels,
  selectedPackagingChoice,
  onLevelSelect,
  onQtyChange,
  searchQuery,
  colors,
  styles,
}: {
  product: SearchProduct;
  qty: number;
  levels: PackagingLevel[];
  selectedPackagingChoice: PackagingChoice | undefined;
  onLevelSelect: (productId: string, choice: PackagingChoice) => void;
  onQtyChange: (productId: string, qty: number) => void;
  searchQuery: string;
  colors: AppColors;
  styles: any;
}) => {
  const [localText, setLocalText] = useState(qty === 0 ? '' : qty.toString());

  useEffect(() => {
    setLocalText(qty === 0 ? '' : qty.toString());
  }, [qty]);

  const handleTextChange = (text: string) => {
    const clean = text.replace(/[^0-9]/g, '');
    setLocalText(clean);
    const parsed = clean === '' ? 0 : parseInt(clean, 10);
    onQtyChange(product.id, parsed);
  };

  const handleBlur = () => {
    if (localText === '' || isNaN(parseInt(localText, 10))) {
      setLocalText('');
      onQtyChange(product.id, 0);
    }
  };

  const increment = () => {
    const nextVal = (qty || 0) + 1;
    setLocalText(nextVal.toString());
    onQtyChange(product.id, nextVal);
  };

  const decrement = () => {
    const nextVal = Math.max(0, (qty || 0) - 1);
    setLocalText(nextVal === 0 ? '' : nextVal.toString());
    onQtyChange(product.id, nextVal);
  };

  return (
    <View style={styles.productRow}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <HighlightText
          text={product.name}
          query={searchQuery}
          style={styles.productName}
          highlightStyle={styles.highlightMatched}
        />
        <Text style={styles.productMeta}>
          ₹{product.selling_price.toFixed(2)} · GST {product.gst_percent}%
        </Text>
        <Text style={[
          styles.stockText,
          product.stock_quantity <= 5 && styles.stockLow,
        ]}>
          Stock: {product.stock_quantity}{product.unit ? ` ${product.unit}` : ''}
        </Text>

        {levels.length > 1 && (
          <View style={styles.packagingRow}>
            {levels.map((level) => {
              const isSelected = selectedPackagingChoice?.level_id === level.id;
              return (
                <TouchableOpacity
                  key={level.id}
                  style={[styles.packagingChip, isSelected && styles.packagingChipActive]}
                  onPress={() => onLevelSelect(product.id, {
                    level_id: level.id,
                    level_name: level.level_name,
                    units_per_level: level.units_per_level,
                  })}
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
        <TouchableOpacity style={styles.qtyBtn} onPress={decrement}>
          <Ionicons name="remove" size={16} color={colors.text} />
        </TouchableOpacity>
        <TextInput
          style={styles.qtyInput}
          value={localText}
          onChangeText={handleTextChange}
          onBlur={handleBlur}
          keyboardType="numeric"
          selectTextOnFocus
          placeholder="0"
          placeholderTextColor={colors.textMuted}
        />
        <TouchableOpacity style={styles.qtyBtn} onPress={increment}>
          <Ionicons name="add" size={16} color={colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

const HighlightText = ({ text, query, style, highlightStyle }: { text: string; query: string; style: any; highlightStyle: any }) => {
  if (!query.trim()) return <Text style={style}>{text}</Text>;
  const escapedQuery = query.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
  return (
    <Text style={style}>
      {parts.map((part, i) => {
        const isMatch = part.toLowerCase() === query.trim().toLowerCase();
        return (
          <Text key={i} style={isMatch ? highlightStyle : null}>
            {part}
          </Text>
        );
      })}
    </Text>
  );
};

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

  /* Category pills */
  categoriesSection: {
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingVertical: 10,
  },
  categoriesScroll: {
    paddingHorizontal: 16,
    gap: 8,
  },
  categoryPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  categoryPillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  categoryPillText: {
    fontSize: 13,
    color: c.textSecondary,
    fontWeight: '500',
  },
  categoryPillTextActive: {
    color: c.surface,
    fontWeight: '700',
  },

  /* Frequently ordered */
  freqSection: {
    backgroundColor: c.surface,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  freqHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  freqTitle: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: c.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  freqScroll: {
    paddingHorizontal: 16,
    gap: 10,
  },
  freqCard: {
    width: 124,
    padding: 10,
    borderRadius: 10,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    position: 'relative' as const,
  },
  freqCardActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },
  freqBadge: {
    position: 'absolute' as const,
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: c.primary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    zIndex: 10,
  },
  freqBadgeText: {
    color: c.surface,
    fontSize: 10,
    fontWeight: '700' as const,
  },
  freqName: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: c.text,
  },
  freqCompany: {
    fontSize: 10,
    color: c.textSecondary,
    marginTop: 2,
  },
  freqPrice: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: c.primary,
    marginTop: 4,
  },
  freqAddBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 2,
    marginTop: 8,
  },
  freqAddBtnText: {
    fontSize: 10,
    fontWeight: '600' as const,
    color: c.textSecondary,
  },
  freqQtyRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginTop: 8,
    backgroundColor: c.borderLight,
    borderRadius: 6,
    padding: 2,
  },
  freqQtyBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: c.surface,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  freqQtyText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: c.text,
  },

  /* Floating Cart FAB */
  cartFab: {
    position: 'absolute' as const,
    bottom: 110,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.primary,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.27,
    shadowRadius: 4.65,
    zIndex: 99,
  },
  cartFabBadge: {
    position: 'absolute' as const,
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: c.error,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 4,
    zIndex: 100,
  },
  cartFabBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700' as const,
  },

  /* Cart review sheet modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end' as const,
  },
  modalSheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '80%' as const,
  },
  modalHeader: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingBottom: 10,
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: c.text,
  },
  cartItemRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  cartItemName: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: c.text,
  },
  cartItemMeta: {
    fontSize: 12,
    color: c.textSecondary,
    marginTop: 2,
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 12,
    marginTop: 10,
  },
  modalTotals: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    marginBottom: 12,
  },
  modalTotalsText: {
    fontSize: 13,
    color: c.textSecondary,
  },
  modalGrandTotal: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: c.primary,
  },
  modalCloseBtn: {
    backgroundColor: c.primary,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center' as const,
  },
  modalCloseBtnText: {
    color: c.surface,
    fontSize: 14,
    fontWeight: '700' as const,
  },

  /* Highlight Matching Text */
  highlightMatched: {
    color: c.primary,
    fontWeight: '700' as const,
  },

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
  qtyInput: {
    minWidth: 42,
    height: 30,
    textAlign: 'center',
    fontWeight: '700',
    color: c.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingHorizontal: 4,
    backgroundColor: c.background,
  },
  clearCartBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: c.errorBg,
  },
  clearCartBtnText: {
    fontSize: 12,
    color: c.error,
    fontWeight: '700' as const,
  },
  } as const;
}
