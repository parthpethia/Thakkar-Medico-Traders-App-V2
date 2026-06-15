// P6: i18n applied — all strings use t() from src/i18n
// P6: Barcode scanning wired — scan FAB for product lookup
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Alert,
  Modal,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { supabase } from '../../src/services/supabase';
import { BarcodeScanner } from '../../src/components/BarcodeScanner';

type Tab = 'low_stock' | 'all';

type LowStockProduct = {
  id: string;
  name: string;
  company: string | null;
  stock_quantity: number;
  threshold: number;
};

type ProductRow = {
  id: string;
  name: string;
  company: string | null;
  stock_quantity: number;
  is_active: boolean;
};

type StockAdjustment = {
  id: string;
  quantity_delta: number;
  reason: string;
  created_at: string;
};

type AdjustReason = 'restock' | 'writeoff' | 'correction' | 'return';

const PAGE_SIZE = 30;

export default function StockManagement() {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('low_stock');
  const [lowStockProducts, setLowStockProducts] = useState<LowStockProduct[]>([]);
  const [allProducts, setAllProducts] = useState<ProductRow[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);

  const [loadingLow, setLoadingLow] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTimeout, setSearchTimeout] = useState<NodeJS.Timeout | null>(null);

  const [allPage, setAllPage] = useState(0);
  const [hasMoreAll, setHasMoreAll] = useState(true);
  const [loadingMoreAll, setLoadingMoreAll] = useState(false);

  // Adjustment modal
  const [adjustModalVisible, setAdjustModalVisible] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<{ id: string; name: string; stock: number } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustReason, setAdjustReason] = useState<AdjustReason>('restock');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustHistory, setAdjustHistory] = useState<StockAdjustment[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // P6: Barcode scanner
  const [scannerVisible, setScannerVisible] = useState(false);

  const REASON_OPTIONS: { key: AdjustReason; label: string; icon: string }[] = [
    { key: 'restock', label: t('admin.stockScreen.restock'), icon: 'add-circle' },
    { key: 'writeoff', label: t('admin.stockScreen.writeoff'), icon: 'remove-circle' },
    { key: 'correction', label: t('admin.stockScreen.correction'), icon: 'swap-horizontal' },
    { key: 'return', label: t('admin.stockScreen.return'), icon: 'arrow-undo' },
  ];

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('stock_changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'products' },
        () => {
          fetchLowStock();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchLowStock = useCallback(async () => {
    setLoadingLow(true);
    try {
      const { data, error } = await supabase.rpc('get_low_stock_products', {});
      if (error) throw error;
      const products = (data || []) as LowStockProduct[];
      setLowStockProducts(products);
      setLowStockCount(products.length);
    } catch (err: any) {
      console.error('Low stock error:', err.message);
    } finally {
      setLoadingLow(false);
    }
  }, []);

  const fetchAllProducts = useCallback(async (page = 0, append = false, query = '') => {
    try {
      if (!append) setLoadingAll(true);
      else setLoadingMoreAll(true);

      let q = supabase
        .from('products')
        .select('id, name, company, stock_quantity, is_active')
        .eq('is_active', true)
        .order('name', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (query.trim()) {
        q = q.ilike('name', `%${query.trim()}%`);
      }

      const { data, error } = await q;
      if (error) throw error;

      const rows = (data || []) as ProductRow[];
      if (append) {
        setAllProducts((prev) => [...prev, ...rows]);
      } else {
        setAllProducts(rows);
      }
      setHasMoreAll(rows.length === PAGE_SIZE);
      setAllPage(page);
    } catch (err: any) {
      console.error('All products error:', err.message);
    } finally {
      setLoadingAll(false);
      setLoadingMoreAll(false);
    }
  }, []);

  useEffect(() => {
    fetchLowStock();
  }, []);

  useEffect(() => {
    if (tab === 'all') {
      fetchAllProducts(0, false, searchQuery);
    }
  }, [tab]);

  const onSearchChange = (text: string) => {
    setSearchQuery(text);
    if (searchTimeout) clearTimeout(searchTimeout);
    const timeout = setTimeout(() => {
      fetchAllProducts(0, false, text);
    }, 400);
    setSearchTimeout(timeout);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (tab === 'low_stock') {
      await fetchLowStock();
    } else {
      await fetchAllProducts(0, false, searchQuery);
    }
    setRefreshing(false);
  }, [tab, searchQuery, fetchLowStock, fetchAllProducts]);

  const onEndReachedAll = useCallback(() => {
    if (!hasMoreAll || loadingMoreAll || loadingAll) return;
    fetchAllProducts(allPage + 1, true, searchQuery);
  }, [hasMoreAll, loadingMoreAll, loadingAll, allPage, searchQuery, fetchAllProducts]);

  const openAdjustModal = async (product: { id: string; name: string; stock: number }) => {
    setSelectedProduct(product);
    setAdjustDelta('');
    setAdjustReason('restock');
    setAdjustModalVisible(true);
    setLoadingHistory(true);

    try {
      const { data } = await supabase
        .from('stock_adjustments')
        .select('id, quantity_delta, reason, created_at')
        .eq('product_id', product.id)
        .order('created_at', { ascending: false })
        .limit(5);
      setAdjustHistory((data || []) as StockAdjustment[]);
    } catch {
      setAdjustHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleAdjust = async () => {
    if (!selectedProduct) return;
    const delta = parseInt(adjustDelta, 10);
    if (isNaN(delta) || delta === 0) {
      Alert.alert(t('admin.stockScreen.invalid'), t('admin.stockScreen.enterNonZero'));
      return;
    }

    setAdjusting(true);
    try {
      const { data, error } = await supabase.rpc('adjust_stock', {
        p_product_id: selectedProduct.id,
        p_delta: delta,
        p_reason: adjustReason,
      });

      if (error) {
        if (error.message.includes('stock_below_zero')) {
          Alert.alert(t('admin.stockScreen.cannotAdjust'), t('admin.stockScreen.stockNegative'));
        } else {
          Alert.alert(t('common.error'), error.message);
        }
        return;
      }

      Alert.alert(t('common.success'), t('admin.stockScreen.newStock', { count: data }));
      setAdjustModalVisible(false);
      fetchLowStock();
      if (tab === 'all') {
        fetchAllProducts(0, false, searchQuery);
      }
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || t('common.error'));
    } finally {
      setAdjusting(false);
    }
  };

  // P6: Handle barcode scan
  const handleBarcodeScan = async (code: string) => {
    try {
      const { data, error } = await supabase.rpc('get_product_by_sku', { p_sku: code });
      if (error) throw error;

      const products = data as any[];
      if (!products || products.length === 0) {
        Alert.alert(
          t('admin.stockScreen.productNotFound'),
          t('admin.stockScreen.skuNotFound', { code }),
        );
        return;
      }

      const product = products[0];
      openAdjustModal({
        id: product.id,
        name: product.name,
        stock: product.stock_quantity,
      });
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message);
    }
  };

  const renderLowStockItem = ({ item }: { item: LowStockProduct }) => {
    const isZero = item.stock_quantity === 0;
    return (
      <TouchableOpacity
        style={[styles.card, isZero && styles.cardDanger]}
        onPress={() => openAdjustModal({ id: item.id, name: item.name, stock: item.stock_quantity })}
      >
        <View style={styles.cardContent}>
          <View style={{ flex: 1 }}>
            <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
            {item.company && <Text style={styles.productCompany}>{item.company}</Text>}
          </View>
          <View style={styles.stockBadge}>
            <Text style={[styles.stockText, isZero && { color: '#fff' }]}>
              {item.stock_quantity}
            </Text>
            {isZero && (
              <View style={styles.outOfStockBadge}>
                <Text style={styles.outOfStockText}>{t('admin.stockScreen.outOfStock')}</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.thresholdRow}>
          <Ionicons name="warning" size={12} color={isZero ? '#EF5350' : '#FFA726'} />
          <Text style={styles.thresholdText}>{t('admin.stockScreen.threshold', { value: item.threshold })}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderAllItem = ({ item }: { item: ProductRow }) => {
    const isLow = item.stock_quantity <= 10;
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => openAdjustModal({ id: item.id, name: item.name, stock: item.stock_quantity })}
      >
        <View style={styles.cardContent}>
          <View style={{ flex: 1 }}>
            <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
            {item.company && <Text style={styles.productCompany}>{item.company}</Text>}
          </View>
          <Text style={[styles.stockValue, isLow && { color: '#EF5350' }]}>
            {item.stock_quantity}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen
        options={{
          title: t('admin.stockScreen.title'),
          headerRight: () => (
            <TouchableOpacity
              onPress={() => router.push('/admin/bulk-restock' as any)}
              style={{ paddingHorizontal: 12 }}
            >
              <Text style={{ color: '#4C51C9', fontWeight: '600', fontSize: 14 }}>{t('admin.stockScreen.bulkRestock')}</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {/* Floating Summary Bar */}
      {lowStockCount > 0 && (
        <View style={styles.alertBar}>
          <Ionicons name="alert-circle" size={16} color="#fff" />
          <Text style={styles.alertBarText}>
            {t('admin.stockScreen.lowStockAlert', { count: lowStockCount })}
          </Text>
        </View>
      )}

      {/* Tab Selector */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'low_stock' && styles.tabBtnActive]}
          onPress={() => setTab('low_stock')}
        >
          <Text style={[styles.tabText, tab === 'low_stock' && styles.tabTextActive]}>
            {t('admin.stockScreen.lowStock')} {lowStockCount > 0 ? `(${lowStockCount})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'all' && styles.tabBtnActive]}
          onPress={() => setTab('all')}
        >
          <Text style={[styles.tabText, tab === 'all' && styles.tabTextActive]}>{t('admin.stockScreen.allProducts')}</Text>
        </TouchableOpacity>
      </View>

      {/* Search (All Products tab) */}
      {tab === 'all' && (
        <View style={styles.searchRow}>
          <Ionicons name="search" size={18} color="#888" />
          <TextInput
            style={styles.searchInput}
            placeholder={t('admin.stockScreen.searchProducts')}
            placeholderTextColor="#999"
            value={searchQuery}
            onChangeText={onSearchChange}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => { setSearchQuery(''); fetchAllProducts(0, false, ''); }}>
              <Ionicons name="close-circle" size={18} color="#888" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Content */}
      {tab === 'low_stock' ? (
        loadingLow && !refreshing ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#4C51C9" />
          </View>
        ) : (
          <FlatList
            data={lowStockProducts}
            keyExtractor={(item) => item.id}
            renderItem={renderLowStockItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="checkmark-circle" size={52} color="#66BB6A" />
                <Text style={styles.emptyText}>{t('admin.stockScreen.allWellStocked')}</Text>
              </View>
            }
          />
        )
      ) : (
        loadingAll && !refreshing ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#4C51C9" />
          </View>
        ) : (
          <FlatList
            data={allProducts}
            keyExtractor={(item) => item.id}
            renderItem={renderAllItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            onEndReached={onEndReachedAll}
            onEndReachedThreshold={0.3}
            ListFooterComponent={
              loadingMoreAll ? (
                <ActivityIndicator size="small" color="#4C51C9" style={{ paddingVertical: 16 }} />
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="cube-outline" size={52} color="#ccc" />
                <Text style={styles.emptyText}>{t('admin.stockScreen.noProductsFound')}</Text>
              </View>
            }
          />
        )
      )}

      {/* P6: Scan FAB */}
      <TouchableOpacity
        style={styles.scanFab}
        onPress={() => setScannerVisible(true)}
        activeOpacity={0.85}
      >
        <Ionicons name="barcode-outline" size={26} color="#fff" />
      </TouchableOpacity>

      {/* P6: Barcode Scanner */}
      <BarcodeScanner
        visible={scannerVisible}
        onScan={handleBarcodeScan}
        onClose={() => setScannerVisible(false)}
      />

      {/* Stock Adjustment Modal */}
      <Modal
        visible={adjustModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAdjustModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.modalTitle}>{t('admin.stockScreen.adjustStock')}</Text>
              <Text style={styles.modalProductName}>{selectedProduct?.name}</Text>
              <Text style={styles.modalCurrentStock}>
                {t('admin.stockScreen.currentStock')} <Text style={{ fontWeight: '700' }}>{selectedProduct?.stock}</Text>
              </Text>

              {/* Quantity Input */}
              <Text style={styles.fieldLabel}>{t('admin.stockScreen.quantity')}</Text>
              <TextInput
                style={styles.modalInput}
                placeholder={t('admin.stockScreen.quantityPlaceholder')}
                placeholderTextColor="#999"
                keyboardType="numeric"
                value={adjustDelta}
                onChangeText={setAdjustDelta}
              />

              {/* Reason Selector */}
              <Text style={styles.fieldLabel}>{t('admin.stockScreen.reason')}</Text>
              <View style={styles.reasonRow}>
                {REASON_OPTIONS.map((r) => (
                  <TouchableOpacity
                    key={r.key}
                    style={[styles.reasonChip, adjustReason === r.key && styles.reasonChipActive]}
                    onPress={() => setAdjustReason(r.key)}
                  >
                    <Ionicons
                      name={r.icon as any}
                      size={14}
                      color={adjustReason === r.key ? '#fff' : '#555'}
                    />
                    <Text style={[styles.reasonChipText, adjustReason === r.key && styles.reasonChipTextActive]}>
                      {r.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Actions */}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={styles.modalCancel}
                  onPress={() => setAdjustModalVisible(false)}
                >
                  <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalSubmit, adjusting && { opacity: 0.6 }]}
                  onPress={handleAdjust}
                  disabled={adjusting}
                >
                  {adjusting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.modalSubmitText}>{t('admin.stockScreen.adjust')}</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* Recent History */}
              <View style={styles.historySection}>
                <Text style={styles.historyTitle}>{t('admin.stockScreen.adjustmentHistory')}</Text>
                {loadingHistory ? (
                  <ActivityIndicator size="small" color="#4C51C9" style={{ marginTop: 8 }} />
                ) : adjustHistory.length === 0 ? (
                  <Text style={styles.historyEmpty}>{t('admin.stockScreen.noAdjustments')}</Text>
                ) : (
                  adjustHistory.map((h) => (
                    <View key={h.id} style={styles.historyRow}>
                      <View>
                        <Text style={styles.historyDelta}>
                          {h.quantity_delta > 0 ? '+' : ''}{h.quantity_delta}
                        </Text>
                        <Text style={styles.historyReason}>{h.reason}</Text>
                      </View>
                      <Text style={styles.historyDate}>
                        {format(new Date(h.created_at), 'dd MMM, HH:mm')}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  alertBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#EF5350',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  alertBarText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#fff',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  tabBtnActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  tabText: { fontSize: 14, fontWeight: '500', color: '#555' },
  tabTextActive: { color: '#fff', fontWeight: '600' },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  searchInput: { flex: 1, fontSize: 14, color: '#333', padding: 0 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardDanger: {
    borderWidth: 1.5,
    borderColor: '#EF5350',
    backgroundColor: '#FFF5F5',
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  productName: { fontSize: 14, fontWeight: '600', color: '#333' },
  productCompany: { fontSize: 12, color: '#888', marginTop: 2 },
  stockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stockText: { fontSize: 18, fontWeight: '700', color: '#333' },
  stockValue: { fontSize: 18, fontWeight: '700', color: '#333' },
  outOfStockBadge: {
    backgroundColor: '#EF5350',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  outOfStockText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  thresholdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  thresholdText: { fontSize: 11, color: '#888' },

  emptyWrap: { alignItems: 'center', marginTop: 80 },
  emptyText: { marginTop: 10, color: '#888', fontSize: 14 },

  // P6: Scan FAB
  scanFab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#4C51C9',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#4C51C9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    maxHeight: '80%',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#333' },
  modalProductName: { fontSize: 15, color: '#555', marginTop: 4 },
  modalCurrentStock: { fontSize: 13, color: '#888', marginTop: 4, marginBottom: 16 },

  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#333',
    marginBottom: 16,
  },

  reasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  reasonChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  reasonChipActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  reasonChipText: { fontSize: 12, color: '#555', fontWeight: '500' },
  reasonChipTextActive: { color: '#fff' },

  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancel: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  modalCancelText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmit: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
  },
  modalSubmitText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  historySection: {
    marginTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 16,
  },
  historyTitle: { fontSize: 14, fontWeight: '600', color: '#555' },
  historyEmpty: { fontSize: 12, color: '#999', marginTop: 8 },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f8f8f8',
  },
  historyDelta: { fontSize: 14, fontWeight: '700', color: '#333' },
  historyReason: { fontSize: 11, color: '#888', marginTop: 2, textTransform: 'capitalize' },
  historyDate: { fontSize: 11, color: '#aaa' },
});
