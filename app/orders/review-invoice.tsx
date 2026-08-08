import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  Modal,
  TextInput,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import {
  matchExtractedInvoice,
  MatchedInvoiceResult,
} from '../../src/services/invoiceValidation';
import type { ExtractedInvoice, ExtractedItem } from '../../src/types/invoice';
import { fetchShopLocations, toOrderDeliveryPayload } from '../../src/services/shopLocationService';
import type { RetailerShopLocation } from '../../src/types/shopLocation';
import { DeliverToCard } from '../../src/components/delivery/DeliverToCard';
import { DeliveryAddressFlow } from '../../src/components/delivery/DeliveryAddressFlow';

type RetailerCandidate = {
  id: string;
  name: string | null;
  business_name: string | null;
  phone: string | null;
  retailer_code: string | null;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

type ProductCandidate = {
  id: string;
  name: string;
  sku: string;
  selling_price: number;
  gst_percent: number;
  stock_quantity: number;
  pack_size: string | null;
};

export default function ReviewInvoiceScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user: currentUser } = useAuthStore();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploadRecord, setUploadRecord] = useState<any>(null);
  const [extractionRecord, setExtractionRecord] = useState<any>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // Review & Editable State
  const [matchedRetailer, setMatchedRetailer] = useState<RetailerCandidate | null>(null);
  const [retailerConfidence, setRetailerConfidence] = useState<number>(0);
  const [retailerWarnings, setRetailerWarnings] = useState<string[]>([]);
  const [itemsState, setItemsState] = useState<Array<{
    extracted: ExtractedItem;
    matchedProduct: ProductCandidate | null;
    confidence: number;
    warnings: string[];
    editedQty: number;
    editedRate: number;
  }>>([]);

  const [paymentMode, setPaymentMode] = useState<'cod' | 'credit' | 'upi'>('cod');
  const [selectedShop, setSelectedShop] = useState<RetailerShopLocation | null>(null);
  const [addressFlowOpen, setAddressFlowOpen] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [duplicateOrderId, setDuplicateOrderId] = useState<string | undefined>();

  // Modals for manual override
  const [retailerModalOpen, setRetailerModalOpen] = useState(false);
  const [retailerSearch, setRetailerSearch] = useState('');
  const [retailerCandidates, setRetailerCandidates] = useState<RetailerCandidate[]>([]);
  const [loadingRetailers, setLoadingRetailers] = useState(false);

  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [productCandidates, setProductCandidates] = useState<ProductCandidate[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const [imageModalOpen, setImageModalOpen] = useState(false);

  // --- ROLE GUARD: Admin & Delivery staff only ---
  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.role !== 'admin' && currentUser.role !== 'delivery') {
      Alert.alert(
        'Access Restricted',
        'Photo-to-Order (Bill OCR) is only available for Admin and Delivery staff.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)') }]
      );
    }
  }, [currentUser]);

  // 1. Load upload + extraction + run matching pipeline
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setLoading(true);

        // Fetch upload record
        const { data: upload, error: uErr } = await supabase
          .from('invoice_uploads')
          .select('*')
          .eq('id', id)
          .single();

        if (uErr || !upload) throw new Error('Invoice upload not found');
        setUploadRecord(upload);

        // Public image URL
        const { data: pubUrl } = supabase.storage
          .from('invoice-uploads')
          .getPublicUrl(upload.storage_path);
        if (pubUrl) setImageUrl(pubUrl.publicUrl);

        // Fetch extraction
        const { data: ext, error: eErr } = await supabase
          .from('invoice_extractions')
          .select('*')
          .eq('invoice_upload_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (eErr || !ext) throw new Error('Invoice extraction not found');
        setExtractionRecord(ext);

        const parsedJson = (ext.edited_json || ext.parsed_json) as ExtractedInvoice;

        // Run matching engine pipeline from invoiceValidation.ts
        const validationResult: MatchedInvoiceResult = await matchExtractedInvoice(parsedJson);

        // Populate state from matching engine
        if (validationResult.customerMatch.customer) {
          setMatchedRetailer(validationResult.customerMatch.customer);
          setRetailerConfidence(validationResult.customerMatch.confidence);
          setRetailerWarnings(validationResult.customerMatch.warnings);

          // Fetch shop locations for matched retailer
          fetchShopLocations(validationResult.customerMatch.customer.id)
            .then((list) => {
              const def = list.find((l) => l.is_default) || list[0] || null;
              setSelectedShop(def);
            })
            .catch(() => {});
        } else {
          setMatchedRetailer(null);
          setRetailerConfidence(0);
          setRetailerWarnings(validationResult.customerMatch.warnings);
        }

        setIsDuplicate(validationResult.isDuplicate);
        setDuplicateOrderId(validationResult.duplicateOrderId);

        // Populate items state
        const items = validationResult.productMatches.map((pm) => ({
          extracted: pm.extractedItem,
          matchedProduct: pm.matchedProduct,
          confidence: pm.confidence,
          warnings: pm.warnings,
          editedQty: pm.extractedItem.quantity || 1,
          editedRate: pm.matchedProduct?.selling_price ?? pm.extractedItem.rate ?? 0,
        }));

        setItemsState(items);
      } catch (err: any) {
        Alert.alert('Error', err.message || 'Failed to load extracted bill details');
        router.back();
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // 2. Retailer search handler
  const handleSearchRetailers = async (query: string) => {
    setRetailerSearch(query);
    if (!query.trim()) {
      setRetailerCandidates([]);
      return;
    }

    try {
      setLoadingRetailers(true);
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, business_name, phone, retailer_code, gstin, address, city, state, pincode')
        .eq('role', 'retailer')
        .eq('approved', true)
        .or(`business_name.ilike.%${query}%,name.ilike.%${query}%,retailer_code.ilike.%${query}%,gstin.ilike.%${query}%`)
        .limit(20);

      if (error) throw error;
      setRetailerCandidates((data || []) as RetailerCandidate[]);
    } catch (err) {
      console.warn('Error searching retailers:', err);
    } finally {
      setLoadingRetailers(false);
    }
  };

  const selectRetailerOverride = (retailer: RetailerCandidate) => {
    setMatchedRetailer(retailer);
    setRetailerConfidence(1.0);
    setRetailerWarnings([]);
    setRetailerModalOpen(false);

    // Fetch shop locations for selected retailer
    fetchShopLocations(retailer.id)
      .then((list) => {
        const def = list.find((l) => l.is_default) || list[0] || null;
        setSelectedShop(def);
      })
      .catch(() => {});

    // Auto-save audit trail
    saveEditedJsonState(retailer, itemsState);
  };

  // Auto-save current state to invoice_extractions.edited_json for complete audit trail
  const saveEditedJsonState = async (
    ret: RetailerCandidate | null,
    items: typeof itemsState
  ) => {
    if (!extractionRecord?.id) return;
    try {
      const currentEditedJson: ExtractedInvoice = {
        party: {
          code: ret?.retailer_code || null,
          name: ret?.business_name || ret?.name || null,
          gst: ret?.gstin || null,
          address: ret?.address || null,
        },
        invoice: extractionRecord?.parsed_json?.invoice || { number: '', date: '' },
        items: items.map((i) => ({
          product_name: i.matchedProduct?.name || i.extracted.product_name || '',
          product_code: i.matchedProduct?.sku || i.extracted.product_code || '',
          batch: i.extracted.batch || '',
          expiry: i.extracted.expiry || '',
          quantity: i.editedQty,
          free_quantity: i.extracted.free_quantity || 0,
          rate: i.editedRate,
          discount: i.extracted.discount || 0,
          gst: i.matchedProduct?.gst_percent || 0,
          amount: i.editedQty * i.editedRate,
        })),
        totals: {
          subtotal: totals.subtotal,
          gst_total: totals.gstTotal,
          discount_total: 0,
          round_off: 0,
          grand_total: totals.grandTotal,
        },
      };

      await supabase
        .from('invoice_extractions')
        .update({ edited_json: currentEditedJson })
        .eq('id', extractionRecord.id);
    } catch (err) {
      console.warn('Auto-save edited_json error:', err);
    }
  };

  // 3. Product search handler
  const handleSearchProducts = async (query: string) => {
    setProductSearch(query);
    if (!query.trim()) {
      setProductCandidates([]);
      return;
    }

    try {
      setLoadingProducts(true);
      const { data, error } = await supabase
        .from('products')
        .select('id, name, sku, selling_price, gst_percent, stock_quantity, pack_size')
        .eq('is_active', true)
        .or(`name.ilike.%${query}%,sku.ilike.%${query}%`)
        .limit(20);

      if (error) throw error;
      setProductCandidates((data || []) as ProductCandidate[]);
    } catch (err) {
      console.warn('Error searching products:', err);
    } finally {
      setLoadingProducts(false);
    }
  };

  const selectProductOverride = (product: ProductCandidate) => {
    if (editingItemIndex === null) return;
    setItemsState((prev) => {
      const next = [...prev];
      const target = next[editingItemIndex];
      next[editingItemIndex] = {
        ...target,
        matchedProduct: product,
        confidence: 1.0,
        warnings: product.stock_quantity < target.editedQty ? [`Stock warning: only ${product.stock_quantity} available`] : [],
        editedRate: product.selling_price,
      };
      return next;
    });
    setProductModalOpen(false);
    setEditingItemIndex(null);
  };

  // Item Qty adjustment
  const updateItemQty = (index: number, diff: number) => {
    setItemsState((prev) => {
      const next = [...prev];
      const cur = next[index];
      const newQty = Math.max(1, cur.editedQty + diff);
      next[index] = { ...cur, editedQty: newQty };
      return next;
    });
  };

  const removeItem = (index: number) => {
    setItemsState((prev) => prev.filter((_, i) => i !== index));
  };

  // Calculations
  const totals = useMemo(() => {
    let subtotal = 0;
    let gstTotal = 0;

    itemsState.forEach((item) => {
      if (!item.matchedProduct) return;
      const lineSub = item.editedQty * item.editedRate;
      const lineGst = (lineSub * (item.matchedProduct.gst_percent || 0)) / 100;
      subtotal += lineSub;
      gstTotal += lineGst;
    });

    const grandTotal = subtotal + gstTotal;
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      gstTotal: Math.round(gstTotal * 100) / 100,
      grandTotal: Math.round(grandTotal * 100) / 100,
    };
  }, [itemsState]);

  const hasUnmatchedItems = itemsState.some((i) => !i.matchedProduct);

  // 4. Phase 5 — Order Finalization & place_order RPC call
  const handleConfirmAndPlaceOrder = async () => {
    if (submitting) return;

    if (!matchedRetailer) {
      Alert.alert('Missing Customer', 'Please select or match a retailer to place this order.');
      return;
    }

    if (itemsState.length === 0) {
      Alert.alert('No Items', 'Order must contain at least one line item.');
      return;
    }

    if (hasUnmatchedItems) {
      Alert.alert('Unmatched Products', 'Please match or remove all red/unmatched product lines before placing order.');
      return;
    }

    if (isDuplicate) {
      Alert.alert('Duplicate Invoice', `Invoice #${extractionRecord?.parsed_json?.invoice?.number} was already imported for Order #${duplicateOrderId}. Duplicate order submission blocked.`);
      return;
    }

    setSubmitting(true);
    setAddressError('');

    try {
      // Format items array for place_order RPC
      const p_items = itemsState.map((i) => ({
        product_id: i.matchedProduct!.id,
        qty: i.editedQty,
        packaging_level_id: null,
        units_per_level: 1,
      }));

      const fullAddress = selectedShop
        ? toOrderDeliveryPayload(selectedShop).full_address
        : [matchedRetailer.address, matchedRetailer.city, matchedRetailer.state, matchedRetailer.pincode].filter(Boolean).join(', ');

      const idempotencyKey = uuidv4();

      // Call place_order RPC
      const { data: rpcData, error: rpcErr } = await supabase.rpc('place_order', {
        p_retailer_id: matchedRetailer.id,
        p_items: p_items,
        p_address: fullAddress,
        p_idempotency_key: idempotencyKey,
        p_payment_mode: paymentMode,
        p_redeem_points: 0,
        p_fulfillment_mode: 'delivery',
        p_delivery: selectedShop ? toOrderDeliveryPayload(selectedShop) : null,
        p_notes: `Bill OCR Import (Inv #${extractionRecord?.parsed_json?.invoice?.number || 'N/A'})`,
      });

      if (rpcErr) {
        throw new Error(rpcErr.message || 'Failed to place order via RPC');
      }

      const result = rpcData as { order_id: string; order_number: string };

      // Update invoice_uploads table
      await supabase
        .from('invoice_uploads')
        .update({
          linked_order_id: result.order_id,
          processing_status: 'completed',
        })
        .eq('id', id);

      // Save edited state to invoice_extractions
      const currentEditedJson: ExtractedInvoice = {
        party: {
          code: matchedRetailer.retailer_code,
          name: matchedRetailer.business_name || matchedRetailer.name,
          gst: matchedRetailer.gstin,
          address: matchedRetailer.address,
        },
        invoice: extractionRecord?.parsed_json?.invoice || { number: '', date: '' },
        items: itemsState.map((i) => ({
          product_name: i.matchedProduct!.name,
          product_code: i.matchedProduct!.sku,
          batch: i.extracted.batch || '',
          expiry: i.extracted.expiry || '',
          quantity: i.editedQty,
          free_quantity: i.extracted.free_quantity || 0,
          rate: i.editedRate,
          discount: i.extracted.discount || 0,
          gst: i.matchedProduct!.gst_percent || 0,
          amount: i.editedQty * i.editedRate,
        })),
        totals: {
          subtotal: totals.subtotal,
          gst_total: totals.gstTotal,
          discount_total: 0,
          round_off: 0,
          grand_total: totals.grandTotal,
        },
      };

      await supabase
        .from('invoice_extractions')
        .update({
          edited_json: currentEditedJson,
          validation_status: 'success',
        })
        .eq('id', extractionRecord.id);

      // Log validation entries into invoice_validation_logs
      const logEntries = [
        {
          extraction_id: extractionRecord.id,
          field_name: 'party.name',
          extracted_value: extractionRecord?.parsed_json?.party?.name || '',
          matched_value: matchedRetailer.business_name || matchedRetailer.name || '',
          validation_result: retailerConfidence >= 0.9 ? 'match' : 'warning',
          notes: `Matched retailer ${matchedRetailer.business_name} (id: ${matchedRetailer.id})`,
        },
        ...itemsState.map((i, index) => ({
          extraction_id: extractionRecord.id,
          field_name: `items[${index}].product_name`,
          extracted_value: i.extracted.product_name || '',
          matched_value: i.matchedProduct?.name || '',
          validation_result: i.confidence >= 0.9 ? 'match' : 'warning',
          notes: `Matched product ${i.matchedProduct?.name} (id: ${i.matchedProduct?.id})`,
        })),
      ];

      await supabase.from('invoice_validation_logs').insert(logEntries);

      Alert.alert(
        'Order Placed Successfully!',
        `Bill photo converted to Order #${result.order_number}.`,
        [
          {
            text: 'View Orders',
            onPress: () => router.replace('/(tabs)/orders'),
          },
        ]
      );
    } catch (err: any) {
      Alert.alert('Order Placement Error', err.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Review Bill & Match Order' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Running matching engine on extracted bill...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Review Bill & Match Order' }} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Top Banner: Bill Thumbnail & AI Confidence */}
        <View style={styles.card}>
          <View style={styles.headerRow}>
            {imageUrl ? (
              <TouchableOpacity onPress={() => setImageModalOpen(true)}>
                <Image source={{ uri: imageUrl }} style={styles.thumbImage} />
              </TouchableOpacity>
            ) : (
              <View style={styles.thumbPlaceholder}>
                <Ionicons name="document-text-outline" size={24} color={colors.textMuted} />
              </View>
            )}

            <View style={{ flex: 1 }}>
              <View style={styles.badgeRow}>
                <Ionicons
                  name={hasUnmatchedItems ? 'alert-circle' : 'checkmark-circle'}
                  size={20}
                  color={hasUnmatchedItems ? colors.warning : colors.success}
                />
                <Text style={[styles.badgeText, { color: hasUnmatchedItems ? colors.warning : colors.success }]}>
                  {hasUnmatchedItems ? 'Action Required' : 'AI Extraction Verified'}
                </Text>
              </View>
              <Text style={styles.confidenceText}>
                Extraction Confidence: {Math.round((extractionRecord?.confidence_score || 0) * 100)}%
              </Text>
              <TouchableOpacity onPress={() => setImageModalOpen(true)}>
                <Text style={styles.viewImageText}>👁️ View Original Bill Photo</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Low Image Readability Warning */}
        {extractionRecord?.parsed_json?.readability_score !== undefined &&
          extractionRecord.parsed_json.readability_score < 0.60 && (
            <View style={styles.duplicateCard}>
              <Ionicons name="eye-off-outline" size={24} color={colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.duplicateTitle, { color: colors.warning }]}>Low Photo Readability</Text>
                <Text style={[styles.duplicateSub, { color: colors.warning }]}>
                  Text on bill appears blurry or smudged ({Math.round(extractionRecord.parsed_json.readability_score * 100)}% clarity). Please double-check matched products.
                </Text>
              </View>
            </View>
          )}

        {/* Multi-page or Truncated Bill Warning */}
        {(extractionRecord?.parsed_json?.is_multi_page || extractionRecord?.parsed_json?.is_truncated) && (
          <View style={styles.duplicateCard}>
            <Ionicons name="documents-outline" size={24} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.duplicateTitle, { color: colors.warning }]}>Multi-Page / Truncated Bill</Text>
              <Text style={[styles.duplicateSub, { color: colors.warning }]}>
                Photo contains continuation text or cut-off items. Only Page 1 items were extracted.
              </Text>
            </View>
          </View>
        )}

        {/* Duplicate Order Warning */}
        {isDuplicate && (
          <View style={styles.duplicateCard}>
            <Ionicons name="warning" size={24} color={colors.error} />
            <View style={{ flex: 1 }}>
              <Text style={styles.duplicateTitle}>Duplicate Invoice Detected</Text>
              <Text style={styles.duplicateSub}>
                This invoice number was already imported for Order #{duplicateOrderId}. Order creation is blocked.
              </Text>
            </View>
          </View>
        )}

        {/* Retailer Selection Block */}
        <View style={styles.card}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>1. Matched Retailer</Text>
            <TouchableOpacity onPress={() => setRetailerModalOpen(true)}>
              <Text style={styles.changeText}>Change Retailer</Text>
            </TouchableOpacity>
          </View>

          {matchedRetailer ? (
            <View style={styles.matchedProfileCard}>
              <View style={{ flex: 1 }}>
                <View style={styles.nameBadgeRow}>
                  <Text style={styles.retailerName}>{matchedRetailer.business_name || matchedRetailer.name}</Text>
                  <View style={[styles.confPill, retailerConfidence >= 0.9 ? styles.pillGreen : styles.pillYellow]}>
                    <Text style={[styles.confPillText, retailerConfidence >= 0.9 ? styles.textGreen : styles.textYellow]}>
                      {retailerConfidence >= 0.9 ? 'Match' : `${Math.round(retailerConfidence * 100)}% Match`}
                    </Text>
                  </View>
                </View>
                <Text style={styles.metaText}>
                  Code: {matchedRetailer.retailer_code || '—'} | GSTIN: {matchedRetailer.gstin || '—'}
                </Text>
                {matchedRetailer.address ? (
                  <Text style={styles.metaText}>{matchedRetailer.address}</Text>
                ) : null}
                {retailerWarnings.length > 0 && (
                  <Text style={styles.warnText}>⚠️ {retailerWarnings.join(', ')}</Text>
                )}
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.unmatchedRetailerCard} onPress={() => setRetailerModalOpen(true)}>
              <Ionicons name="alert-circle-outline" size={24} color={colors.error} />
              <View style={{ flex: 1 }}>
                <Text style={styles.unmatchedTitle}>No Retailer Matched</Text>
                <Text style={styles.unmatchedSub}>Tap here to search and select retailer manually</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Delivery Shop Location Selector */}
        {matchedRetailer && (
          <DeliverToCard
            location={selectedShop}
            error={addressError}
            onChange={() => setAddressFlowOpen(true)}
          />
        )}

        {/* Line Items Section */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>2. Matched Line Items ({itemsState.length})</Text>

          {itemsState.map((item, index) => {
            const isMatched = !!item.matchedProduct;
            const isHighConf = item.confidence >= 0.9;
            const hasWarn = item.warnings.length > 0;

            return (
              <View key={index} style={styles.lineItemCard}>
                {/* Extracted title vs matched product */}
                <View style={styles.lineItemHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.extractedLabel}>Extracted: {item.extracted.product_name}</Text>
                    {isMatched ? (
                      <Text style={styles.matchedTitle}>Matched: {item.matchedProduct!.name}</Text>
                    ) : (
                      <Text style={styles.unmatchedProductText}>⚠️ Unmatched Product</Text>
                    )}
                  </View>

                  {/* Confidence Pill */}
                  <View
                    style={[
                      styles.confPill,
                      !isMatched ? styles.pillRed : isHighConf && !hasWarn ? styles.pillGreen : styles.pillYellow,
                    ]}
                  >
                    <Text
                      style={[
                        styles.confPillText,
                        !isMatched ? styles.textRed : isHighConf && !hasWarn ? styles.textGreen : styles.textYellow,
                      ]}
                    >
                      {!isMatched ? 'Unmatched' : isHighConf && !hasWarn ? '100% Match' : 'Warning'}
                    </Text>
                  </View>
                </View>

                <Text style={styles.metaText}>
                  SKU: {item.matchedProduct?.sku || item.extracted.product_code || '—'} | Batch: {item.extracted.batch || '—'} | Exp: {item.extracted.expiry || '—'}
                </Text>

                {item.warnings.length > 0 && (
                  <Text style={styles.warnText}>⚠️ {item.warnings.join(' · ')}</Text>
                )}

                {/* Qty & Rate Controls */}
                <View style={styles.itemControlsRow}>
                  <View style={styles.qtyControl}>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => updateItemQty(index, -1)}>
                      <Ionicons name="remove" size={14} color={colors.text} />
                    </TouchableOpacity>
                    <Text style={styles.qtyText}>{item.editedQty}</Text>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => updateItemQty(index, 1)}>
                      <Ionicons name="add" size={14} color={colors.text} />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.rateText}>
                    ₹{item.editedRate.toFixed(2)} x {item.editedQty} = ₹{(item.editedQty * item.editedRate).toFixed(2)}
                  </Text>

                  <View style={styles.itemActionBtns}>
                    <TouchableOpacity
                      style={styles.actionIconBtn}
                      onPress={() => {
                        setEditingItemIndex(index);
                        setProductModalOpen(true);
                        handleSearchProducts(item.extracted.product_name || '');
                      }}
                    >
                      <Ionicons name="swap-horizontal" size={18} color={colors.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionIconBtn} onPress={() => removeItem(index)}>
                      <Ionicons name="trash-outline" size={18} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* Payment Mode Selector */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>3. Payment Mode</Text>
          <View style={styles.paymentRow}>
            {(['cod', 'credit', 'upi'] as const).map((mode) => {
              const active = paymentMode === mode;
              const labels = { cod: 'Cash (COD)', credit: 'Credit Book', upi: 'UPI' };
              return (
                <TouchableOpacity
                  key={mode}
                  style={[styles.paymentBtn, active && styles.paymentBtnActive]}
                  onPress={() => setPaymentMode(mode)}
                >
                  <Text style={[styles.paymentText, active && styles.paymentTextActive]}>{labels[mode]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Totals & Reconciliation */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>4. Order Totals</Text>
          <View style={styles.totalRow}>
            <Text style={styles.metaText}>Subtotal:</Text>
            <Text style={styles.totalValueText}>₹{totals.subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.metaText}>GST Total:</Text>
            <Text style={styles.totalValueText}>₹{totals.gstTotal.toFixed(2)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.totalRow}>
            <Text style={styles.grandTotalLabel}>Grand Total:</Text>
            <Text style={styles.grandTotalValue}>₹{totals.grandTotal.toFixed(2)}</Text>
          </View>
        </View>
      </ScrollView>

      {/* Sticky Confirm Button */}
      <View style={styles.stickyFooter}>
        <TouchableOpacity
          style={[styles.confirmBtn, (submitting || hasUnmatchedItems || !matchedRetailer || isDuplicate) && styles.btnDisabled]}
          onPress={handleConfirmAndPlaceOrder}
          disabled={submitting || hasUnmatchedItems || !matchedRetailer || isDuplicate}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.confirmBtnText}>Confirm & Place Order</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Retailer Override Search Modal */}
      <Modal visible={retailerModalOpen} animationType="slide" onRequestClose={() => setRetailerModalOpen(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Retailer</Text>
            <TouchableOpacity onPress={() => setRetailerModalOpen(false)}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.modalInput}
            placeholder="Search by business name, contact, party code, GSTIN..."
            placeholderTextColor={colors.textMuted}
            value={retailerSearch}
            onChangeText={handleSearchRetailers}
            autoFocus
          />
          {loadingRetailers ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 20 }} />
          ) : (
            <FlatList
              data={retailerCandidates}
              keyExtractor={(r) => r.id}
              contentContainerStyle={{ padding: 16 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.modalCandidateRow} onPress={() => selectRetailerOverride(item)}>
                  <Text style={styles.retailerName}>{item.business_name || item.name}</Text>
                  <Text style={styles.metaText}>
                    Code: {item.retailer_code || '—'} | GST: {item.gstin || '—'} | Phone: {item.phone || '—'}
                  </Text>
                </TouchableOpacity>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>

      {/* Product Override Search Modal */}
      <Modal visible={productModalOpen} animationType="slide" onRequestClose={() => setProductModalOpen(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Match Catalog Product</Text>
            <TouchableOpacity onPress={() => setProductModalOpen(false)}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.modalInput}
            placeholder="Search catalog product by name or SKU..."
            placeholderTextColor={colors.textMuted}
            value={productSearch}
            onChangeText={handleSearchProducts}
            autoFocus
          />
          {loadingProducts ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 20 }} />
          ) : (
            <FlatList
              data={productCandidates}
              keyExtractor={(p) => p.id}
              contentContainerStyle={{ padding: 16 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.modalCandidateRow} onPress={() => selectProductOverride(item)}>
                  <Text style={styles.retailerName}>{item.name}</Text>
                  <Text style={styles.metaText}>
                    SKU: {item.sku} | Price: ₹{item.selling_price.toFixed(2)} | Stock: {item.stock_quantity}
                  </Text>
                </TouchableOpacity>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>

      {/* Full Image Preview Modal */}
      <Modal visible={imageModalOpen} animationType="fade" onRequestClose={() => setImageModalOpen(false)}>
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: '#000' }]}>
          <View style={styles.fullImageHeader}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Original Bill Photo</Text>
            <TouchableOpacity onPress={() => setImageModalOpen(false)}>
              <Ionicons name="close-circle" size={28} color="#fff" />
            </TouchableOpacity>
          </View>
          {imageUrl ? (
            <Image source={{ uri: imageUrl }} style={{ width: '100%', height: '90%' }} resizeMode="contain" />
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* Delivery Address Flow Modal */}
      {matchedRetailer && currentUser && (
        <DeliveryAddressFlow
          visible={addressFlowOpen}
          onClose={() => setAddressFlowOpen(false)}
          onSelect={(loc) => {
            setSelectedShop(loc);
            setAddressError('');
          }}
          retailerId={matchedRetailer.id}
          user={currentUser}
          initialStage="address_book"
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    loadingText: { marginTop: 12, color: c.textSecondary, fontSize: 14 },
    content: { padding: 16, gap: 14, paddingBottom: 100 },
    card: { backgroundColor: c.surface, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border },
    headerRow: { flexDirection: 'row' as const, gap: 12, alignItems: 'center' as const },
    thumbImage: { width: 64, height: 64, borderRadius: 8, backgroundColor: c.background },
    thumbPlaceholder: { width: 64, height: 64, borderRadius: 8, backgroundColor: c.background, justifyContent: 'center' as const, alignItems: 'center' as const },
    badgeRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
    badgeText: { fontSize: 14, fontWeight: '700' as const },
    confidenceText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    viewImageText: { fontSize: 12, color: c.primary, fontWeight: '600' as const, marginTop: 4 },
    duplicateCard: { flexDirection: 'row' as const, gap: 10, padding: 12, borderRadius: 10, backgroundColor: isDark ? '#3B1515' : '#FEE2E2', borderWidth: 1, borderColor: c.error, alignItems: 'center' as const },
    duplicateTitle: { fontSize: 14, fontWeight: '700' as const, color: c.error },
    duplicateSub: { fontSize: 12, color: c.error, marginTop: 2 },
    sectionHeaderRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, marginBottom: 8 },
    sectionTitle: { fontSize: 15, fontWeight: '700' as const, color: c.text },
    changeText: { fontSize: 13, color: c.primary, fontWeight: '600' as const },
    matchedProfileCard: { backgroundColor: c.background, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    nameBadgeRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const },
    retailerName: { fontSize: 14, fontWeight: '700' as const, color: c.text },
    metaText: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    warnText: { fontSize: 11, color: c.warning, fontWeight: '600' as const, marginTop: 4 },
    unmatchedRetailerCard: { flexDirection: 'row' as const, gap: 10, padding: 14, borderRadius: 8, backgroundColor: isDark ? '#3B1515' : '#FEF2F2', borderWidth: 1.5, borderColor: c.error, alignItems: 'center' as const },
    unmatchedTitle: { fontSize: 14, fontWeight: '700' as const, color: c.error },
    unmatchedSub: { fontSize: 12, color: c.error, marginTop: 2 },
    lineItemCard: { backgroundColor: c.background, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, marginTop: 8 },
    lineItemHeader: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'flex-start' as const },
    extractedLabel: { fontSize: 11, color: c.textMuted },
    matchedTitle: { fontSize: 13, fontWeight: '700' as const, color: c.text, marginTop: 2 },
    unmatchedProductText: { fontSize: 13, fontWeight: '700' as const, color: c.error, marginTop: 2 },
    confPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
    confPillText: { fontSize: 11, fontWeight: '700' as const },
    pillGreen: { backgroundColor: c.successMuted },
    textGreen: { color: c.success },
    pillYellow: { backgroundColor: c.warningBg },
    textYellow: { color: c.warning },
    pillRed: { backgroundColor: isDark ? '#3B1515' : '#FEE2E2' },
    textRed: { color: c.error },
    itemControlsRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.borderLight },
    qtyControl: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
    qtyBtn: { width: 28, height: 28, borderRadius: 6, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, justifyContent: 'center' as const, alignItems: 'center' as const },
    qtyText: { fontSize: 13, fontWeight: '700' as const, color: c.text },
    rateText: { fontSize: 12, fontWeight: '600' as const, color: c.text },
    itemActionBtns: { flexDirection: 'row' as const, gap: 8 },
    actionIconBtn: { padding: 4 },
    paymentRow: { flexDirection: 'row' as const, gap: 8, marginTop: 6 },
    paymentBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, alignItems: 'center' as const },
    paymentBtnActive: { borderColor: c.primary, backgroundColor: c.primaryMuted },
    paymentText: { fontSize: 12, color: c.textSecondary, fontWeight: '500' as const },
    paymentTextActive: { color: c.primary, fontWeight: '700' as const },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 6 },
    totalRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, marginTop: 4 },
    totalValueText: { fontSize: 13, fontWeight: '600' as const, color: c.text },
    grandTotalLabel: { fontSize: 15, fontWeight: '700' as const, color: c.text },
    grandTotalValue: { fontSize: 16, fontWeight: '700' as const, color: c.primary },
    stickyFooter: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, backgroundColor: c.surface, padding: 16, borderTopWidth: 1, borderTopColor: c.border },
    confirmBtn: { backgroundColor: c.primary, height: 52, borderRadius: 12, justifyContent: 'center' as const, alignItems: 'center' as const },
    btnDisabled: { opacity: 0.5 },
    confirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' as const },
    modalContainer: { flex: 1, backgroundColor: c.background },
    modalHeader: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
    modalTitle: { fontSize: 16, fontWeight: '700' as const, color: c.text },
    modalInput: { margin: 16, backgroundColor: c.surface, borderRadius: 8, padding: 12, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 14 },
    modalCandidateRow: { backgroundColor: c.surface, padding: 14, borderRadius: 8, borderWidth: 1, borderColor: c.borderLight, marginBottom: 8 },
    fullImageHeader: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, padding: 16 },
  } as const;
}
