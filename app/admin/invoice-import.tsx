import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import {
  ManualJsonProvider,
  normalizeExtractedInvoice,
  ExtractedInvoice,
} from '../../src/services/invoiceExtraction';
import {
  validateInvoice,
  validateInvoiceMath,
  validateCustomer,
  validateProduct,
  InvoiceValidationResult,
  ValidationLog,
} from '../../src/services/invoiceValidation';

const DRAFT_STORAGE_KEY = '@tmt_invoice_import_draft_v1';

const generateUuid = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export default function InvoiceImport() {
  const { colors, isDark } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();

  // Workflow stages: 'upload' | 'parse' | 'review' | 'submitting'
  const [stage, setStage] = useState<'upload' | 'parse' | 'review'>('upload');

  // File Upload states
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [dbUploadId, setDbUploadId] = useState<string | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');

  // Paste JSON states
  const [rawJsonText, setRawJsonText] = useState('');
  const [parsing, setParsing] = useState(false);

  // Review & Edit States
  const [originalExtraction, setOriginalExtraction] = useState<ExtractedInvoice | null>(null);
  const [editedInvoice, setEditedInvoice] = useState<ExtractedInvoice | null>(null);
  const [validation, setValidation] = useState<InvoiceValidationResult | null>(null);
  const [validating, setValidating] = useState(false);

  // Manual Matching / Editing helper states
  const [retailerSearch, setRetailerSearch] = useState('');
  const [retailersDropdown, setRetailersDropdown] = useState<any[]>([]);
  const [showRetailerSearch, setShowRetailerSearch] = useState(false);
  
  const [productSearchIndex, setProductSearchIndex] = useState<number | null>(null);
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [productsDropdown, setProductsDropdown] = useState<any[]>([]);

  // Sticky option selectors
  const [paymentMode, setPaymentMode] = useState<'cod' | 'credit' | 'upi'>('cod');
  const [notes, setNotes] = useState('');

  // 1. Check for drafts on mount
  useEffect(() => {
    loadDraft();
  }, []);

  // 2. Auto-save drafts in review stage
  useEffect(() => {
    if (stage === 'review' && editedInvoice) {
      saveDraft();
    }
  }, [editedInvoice, stage, paymentMode, notes, dbUploadId, storagePath, fileName, imageUri]);

  /* ================= DRAFT MANAGMENT ================= */
  const saveDraft = async () => {
    try {
      const draftObj = {
        stage,
        imageUri,
        dbUploadId,
        storagePath,
        fileName,
        rawJsonText,
        originalExtraction,
        editedInvoice,
        paymentMode,
        notes,
      };
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftObj));
    } catch (err) {
      console.warn('Failed to save draft:', err);
    }
  };

  const loadDraft = async () => {
    try {
      const draftStr = await AsyncStorage.getItem(DRAFT_STORAGE_KEY);
      if (draftStr) {
        const draft = JSON.parse(draftStr);
        Alert.alert(
          'Resume Draft',
          'Would you like to resume your previous unsaved invoice import?',
          [
            { text: 'Discard', style: 'destructive', onPress: discardDraft },
            {
              text: 'Resume',
              onPress: async () => {
                setStage(draft.stage || 'upload');
                setImageUri(draft.imageUri || null);
                setDbUploadId(draft.dbUploadId || null);
                setStoragePath(draft.storagePath || null);
                setFileName(draft.fileName || '');
                setRawJsonText(draft.rawJsonText || '');
                setOriginalExtraction(draft.originalExtraction || null);
                setEditedInvoice(draft.editedInvoice || null);
                setPaymentMode(draft.paymentMode || 'cod');
                setNotes(draft.notes || '');

                if (draft.editedInvoice) {
                  setValidating(true);
                  const res = await validateInvoice(draft.editedInvoice);
                  setValidation(res);
                  setValidating(false);
                }
              },
            },
          ]
        );
      }
    } catch (err) {
      console.warn('Failed to load draft:', err);
    }
  };

  const discardDraft = async () => {
    try {
      await AsyncStorage.removeItem(DRAFT_STORAGE_KEY);
      setStage('upload');
      setImageUri(null);
      setDbUploadId(null);
      setStoragePath(null);
      setFileName('');
      setRawJsonText('');
      setOriginalExtraction(null);
      setEditedInvoice(null);
      setValidation(null);
      setPaymentMode('cod');
      setNotes('');
    } catch (err) {
      console.warn('Failed to discard draft:', err);
    }
  };

  /* ================= FILE UPLOAD / CAMERA ================= */
  const handlePickFile = async (fromCamera: boolean) => {
    try {
      const { status } = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Storage or camera permission is required to upload invoices.');
        return;
      }

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.75,
            allowsEditing: false,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.75,
            allowsEditing: false,
          });

      if (result.canceled || !result.assets?.[0]?.uri) return;

      const uri = result.assets[0].uri;
      setImageUri(uri);
      await uploadInvoiceFile(uri);
    } catch (err: any) {
      Alert.alert('Error picking file', err.message);
    }
  };

  const uploadInvoiceFile = async (uri: string) => {
    setUploadingFile(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) throw new Error('User not logged in');

      const nameOfFile = uri.split('/').pop() || `invoice_${Date.now()}.jpg`;
      const fileExt = nameOfFile.split('.').pop() || 'jpg';
      const pathInStorage = `${userId}/${Date.now()}_${nameOfFile}`;
      setFileName(nameOfFile);

      // Read image as blob
      const response = await fetch(uri);
      const blob = await response.blob();
      const arrayBuffer = await new Response(blob).arrayBuffer();

      // 1. Upload to Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from('invoice-uploads')
        .upload(pathInStorage, arrayBuffer, {
          contentType: `image/${fileExt}`,
          upsert: false,
        });

      if (uploadErr) throw uploadErr;
      setStoragePath(pathInStorage);

      // 2. Insert invoice_uploads record in database
      const { data: dbRecord, error: dbErr } = await supabase
        .from('invoice_uploads')
        .insert({
          uploaded_by: userId,
          storage_path: pathInStorage,
          file_name: nameOfFile,
          file_type: fileExt,
          processing_status: 'uploaded',
        })
        .select()
        .single();

      if (dbErr) throw dbErr;
      setDbUploadId(dbRecord.id);

      setStage('parse');
    } catch (err: any) {
      Alert.alert('Upload Failed', err.message || 'Could not upload file to storage');
      setImageUri(null);
    } finally {
      setUploadingFile(false);
    }
  };

  /* ================= JSON EXTRACTION / PARSING ================= */
  const handleParseJson = async () => {
    if (!rawJsonText.trim()) {
      Alert.alert('Empty Input', 'Please paste extracted JSON from ChatGPT.');
      return;
    }

    setParsing(true);
    try {
      const provider = new ManualJsonProvider();
      const result = await provider.extract(rawJsonText);

      setOriginalExtraction(result.parsedData);
      setEditedInvoice(JSON.parse(JSON.stringify(result.parsedData))); // deep copy

      // Run validation engine immediately
      setValidating(true);
      const validationRes = await validateInvoice(result.parsedData);
      setValidation(validationRes);

      // Update processing_status to extracted
      if (dbUploadId) {
        await supabase
          .from('invoice_uploads')
          .update({ processing_status: 'extracted' })
          .eq('id', dbUploadId);
      }

      setStage('review');
    } catch (err: any) {
      Alert.alert('Parsing Error', err.message || 'Invalid JSON format. Check parameters and try again.');
    } finally {
      setParsing(false);
      setValidating(false);
    }
  };

  /* ================= LIVE CUSTOMER SEARCH ================= */
  const searchRetailers = async (query: string) => {
    setRetailerSearch(query);
    if (query.trim().length < 2) {
      setRetailersDropdown([]);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('search_retailers', {
        p_query: query,
        p_search_by_code: false,
        p_offset: 0,
        p_page_size: 15,
      });
      if (!error && data) {
        setRetailersDropdown(data);
      }
    } catch {}
  };

  const handleSelectRetailer = async (ret: any) => {
    if (!editedInvoice) return;

    const updated = {
      ...editedInvoice,
      party: {
        ...editedInvoice.party,
        code: ret.retailer_code || '',
        name: ret.business_name || ret.name,
        gst: ret.gstin || '',
        address: ret.address || '',
      },
    };

    setEditedInvoice(updated);
    setShowRetailerSearch(false);
    setRetailerSearch('');
    setRetailersDropdown([]);

    // Revalidate
    setValidating(true);
    const res = await validateInvoice(updated);
    setValidation(res);
    setValidating(false);
  };

  /* ================= LIVE PRODUCT SEARCH ================= */
  const searchProducts = async (query: string) => {
    setProductSearchQuery(query);
    if (query.trim().length < 2) {
      setProductsDropdown([]);
      return;
    }
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, name, sku, mrp, selling_price, gst_percent, stock_quantity, pack_size')
        .ilike('name', `%${query}%`)
        .eq('is_active', true)
        .limit(10);
      if (!error && data) {
        setProductsDropdown(data);
      }
    } catch {}
  };

  const handleSelectProductForLine = async (prod: any, idx: number) => {
    if (!editedInvoice) return;

    const updatedItems = [...editedInvoice.items];
    updatedItems[idx] = {
      ...updatedItems[idx],
      product_name: prod.name,
      product_code: prod.sku,
      rate: prod.selling_price,
      gst: prod.gst_percent,
      amount: Number(((updatedItems[idx].quantity * prod.selling_price) * (1 + prod.gst_percent / 100)).toFixed(2)),
    };

    const updatedInvoice = {
      ...editedInvoice,
      items: updatedItems,
    };

    setEditedInvoice(updatedInvoice);
    setProductSearchIndex(null);
    setProductSearchQuery('');
    setProductsDropdown([]);

    // Revalidate
    setValidating(true);
    const res = await validateInvoice(updatedInvoice);
    setValidation(res);
    setValidating(false);
  };

  /* ================= UPDATE ITEM FIELDS ================= */
  const handleUpdateItemValue = async (index: number, key: string, val: string | number) => {
    if (!editedInvoice) return;

    const updatedItems = [...editedInvoice.items];
    const numVal = Number(val) || 0;

    updatedItems[index] = {
      ...updatedItems[index],
      [key]: key === 'product_name' || key === 'product_code' || key === 'batch' || key === 'expiry' ? val : numVal,
    };

    // Recalculate amount for that row item
    if (key === 'quantity' || key === 'rate' || key === 'discount' || key === 'gst') {
      const qty = updatedItems[index].quantity;
      const rate = updatedItems[index].rate;
      const disc = updatedItems[index].discount;
      const gst = updatedItems[index].gst;
      const lineSub = Math.max(0, qty * rate - disc);
      const lineGst = (lineSub * gst) / 100;
      updatedItems[index].amount = Math.round((lineSub + lineGst) * 100) / 100;
    }

    const updatedInvoice = {
      ...editedInvoice,
      items: updatedItems,
    };

    // Recompute totals
    const math = validateInvoiceMath(updatedInvoice);
    updatedInvoice.totals = {
      subtotal: math.subtotal,
      gst_total: math.gst_total,
      discount_total: math.discount_total,
      round_off: math.round_off,
      grand_total: math.grand_total,
    };

    setEditedInvoice(updatedInvoice);

    // Revalidate
    setValidating(true);
    const res = await validateInvoice(updatedInvoice);
    setValidation(res);
    setValidating(false);
  };

  /* ================= FINAL ORDER CREATION ================= */
  const handleCreateOrder = async () => {
    if (!validation || !editedInvoice) return;

    if (validation.overallStatus === 'failed') {
      Alert.alert('Validation Error', 'Please resolve all matching errors before creating the order.');
      return;
    }

    Alert.alert(
      'Confirm Order Creation',
      `Create new order for ${editedInvoice.party.name} of ₹${editedInvoice.totals.grand_total.toFixed(2)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: submitOrderFlow,
        },
      ]
    );
  };

  const submitOrderFlow = async () => {
    setValidating(true);
    try {
      const matchedCustomer = validation?.customerMatch?.customer;
      if (!matchedCustomer) throw new Error('Matched customer details missing');

      // Map verified items to order list
      const itemsPayload = [];
      for (const item of editedInvoice!.items) {
        const prod = validation?.productMatches?.find(p => p.extractedItem.product_name === item.product_name)?.matchedProduct;
        if (!prod) throw new Error(`Product match missing for ${item.product_name}`);
        
        itemsPayload.push({
          product_id: prod.id,
          qty: item.quantity,
          packaging_level_id: null,
          units_per_level: 1,
        });
      }

      // Generate invoice extraction audit log data
      // 1. Create extraction log record
      const { data: extRecord, error: extErr } = await supabase
        .from('invoice_extractions')
        .insert({
          invoice_upload_id: dbUploadId,
          extraction_provider: 'ManualJsonProvider',
          raw_json: JSON.parse(rawJsonText),
          parsed_json: originalExtraction,
          edited_json: editedInvoice,
          confidence_score: 1.0,
          validation_status: validation.overallStatus,
        })
        .select()
        .single();

      if (extErr) throw extErr;

      // 2. Insert validation logs in database
      const validationLogs = validation.validationLogs.map(log => ({
        extraction_id: extRecord.id,
        field_name: log.field_name,
        extracted_value: String(log.extracted_value),
        matched_value: String(log.matched_value),
        validation_result: log.validation_result,
        notes: log.notes,
      }));

      if (validationLogs.length > 0) {
        const { error: logErr } = await supabase
          .from('invoice_validation_logs')
          .insert(validationLogs);
        if (logErr) throw logErr;
      }

      // 3. Create the order using place_order RPC
      const idempotencyKey = generateUuid();
      const customerAddress = [
        matchedCustomer.address,
        matchedCustomer.city,
        matchedCustomer.state,
        matchedCustomer.pincode,
      ]
        .filter(Boolean)
        .join(', ');

      const { data: orderResult, error: orderErr } = await supabase.rpc('place_order', {
        p_retailer_id: matchedCustomer.id,
        p_items: itemsPayload,
        p_address: customerAddress || 'Counter Delivery',
        p_idempotency_key: idempotencyKey,
        p_payment_mode: paymentMode,
        p_redeem_points: 0,
        p_fulfillment_mode: 'delivery',
        p_delivery: null,
        p_notes: notes || `Auto-imported invoice #${editedInvoice!.invoice.number}`,
      });

      if (orderErr) throw orderErr;

      // 4. Update upload state to completed and link order id
      const orderData = orderResult as { order_id: string; order_number: string };
      await supabase
        .from('invoice_uploads')
        .update({
          linked_order_id: orderData.order_id,
          processing_status: 'completed',
        })
        .eq('id', dbUploadId);

      // Clean draft
      await AsyncStorage.removeItem(DRAFT_STORAGE_KEY);

      Alert.alert(
        'Success',
        `Order #${orderData.order_number} generated successfully from invoice.`,
        [{ text: 'OK', onPress: () => router.replace('/admin/orders') }]
      );
    } catch (err: any) {
      Alert.alert('Order Placement Failed', err.message || 'Supabase order trigger error occurred.');
    } finally {
      setValidating(false);
    }
  };

  /* ================= RENDER SECTIONS ================= */
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Invoice to Order' }} />

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        
        {/* Progress header */}
        <View style={styles.progressBar}>
          <Text style={[styles.progressStep, stage === 'upload' && styles.progressStepActive]}>1. Upload</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          <Text style={[styles.progressStep, stage === 'parse' && styles.progressStepActive]}>2. Parse</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          <Text style={[styles.progressStep, stage === 'review' && styles.progressStepActive]}>3. Validate</Text>
        </View>

        {/* STAGE 1: UPLOAD */}
        {stage === 'upload' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Upload Invoice Document</Text>
            <Text style={styles.cardSubtitle}>
              Take a camera snapshot or select a PDF/image from the gallery to begin.
            </Text>

            <View style={styles.uploadBtnRow}>
              <TouchableOpacity style={styles.uploadBtn} onPress={() => handlePickFile(true)}>
                <Ionicons name="camera" size={32} color={colors.primary} />
                <Text style={styles.uploadBtnText}>Camera</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.uploadBtn} onPress={() => handlePickFile(false)}>
                <Ionicons name="image" size={32} color={colors.primary} />
                <Text style={styles.uploadBtnText}>Gallery</Text>
              </TouchableOpacity>
            </View>

            {uploadingFile && (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={colors.primary} size="large" />
                <Text style={styles.loadingText}>Uploading to Supabase Storage...</Text>
              </View>
            )}
          </View>
        )}

        {/* STAGE 2: PARSE */}
        {stage === 'parse' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Extract Invoice JSON</Text>
            <Text style={styles.cardSubtitle}>
              Paste the structured JSON output from your OCR extraction or ChatGPT prompt below.
            </Text>

            {imageUri && (
              <View style={styles.previewImageContainer}>
                <Image source={{ uri: imageUri }} style={styles.previewImage} />
                <Text style={styles.fileNameText}>{fileName}</Text>
              </View>
            )}

            <TextInput
              style={styles.jsonInput}
              multiline
              numberOfLines={10}
              placeholder="Paste extracted invoice JSON here..."
              placeholderTextColor={colors.textMuted}
              value={rawJsonText}
              onChangeText={setRawJsonText}
            />

            <TouchableOpacity style={styles.primaryBtn} onPress={handleParseJson} disabled={parsing}>
              {parsing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Parse & Validate</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.discardBtn} onPress={discardDraft}>
              <Text style={styles.discardBtnText}>Reset Import</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* STAGE 3: REVIEW / VALIDATE */}
        {stage === 'review' && editedInvoice && (
          <View>
            {/* Validation Panel */}
            <View style={[styles.card, styles.validationPanel]}>
              <Text style={styles.cardTitle}>Validation Result</Text>
              {validating ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <View>
                  <View style={styles.overallStatusRow}>
                    <Text style={styles.overallText}>Status: </Text>
                    <Text
                      style={[
                        styles.statusBadge,
                        validation?.overallStatus === 'success' && styles.statusSuccess,
                        validation?.overallStatus === 'warning' && styles.statusWarning,
                        validation?.overallStatus === 'failed' && styles.statusFailed,
                      ]}
                    >
                      {validation?.overallStatus?.toUpperCase()}
                    </Text>
                  </View>
                  {validation?.validationLogs.map((log, index) => (
                    <View key={index} style={styles.logRow}>
                      <Ionicons
                        name={
                          log.validation_result === 'match'
                            ? 'checkmark-circle'
                            : log.validation_result === 'warning'
                            ? 'alert-circle'
                            : 'close-circle'
                        }
                        size={16}
                        color={
                          log.validation_result === 'match'
                            ? colors.success
                            : log.validation_result === 'warning'
                            ? colors.warning
                            : colors.error
                        }
                      />
                      <Text style={styles.logText}>
                        <Text style={{ fontWeight: '700' }}>{log.field_name}: </Text>
                        {log.notes}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {/* Customer match section */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Customer matching</Text>
              <View style={styles.extractedValBox}>
                <Text style={styles.boxLabel}>Extracted Party Name</Text>
                <Text style={styles.boxVal}>{editedInvoice.party.name || 'Not provided'}</Text>
                <Text style={styles.boxLabelSmall}>GST: {editedInvoice.party.gst || 'None'}</Text>
              </View>

              {validation?.customerMatch?.customer ? (
                <View style={styles.matchedCustomerCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.matchedTitle}>Matched Database Profile</Text>
                    <Text style={styles.matchedName}>{validation.customerMatch.customer.business_name}</Text>
                    <Text style={styles.matchedSub}>{validation.customerMatch.customer.name} · {validation.customerMatch.customer.phone}</Text>
                    <Text style={styles.matchedSub}>GSTIN: {validation.customerMatch.customer.gstin || 'None'}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowRetailerSearch(true)}>
                    <Text style={styles.changeLink}>Change</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.unmatchedBox}>
                  <Text style={styles.unmatchedText}>No customer matched from profiles.</Text>
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShowRetailerSearch(true)}>
                    <Text style={styles.secondaryBtnText}>Select Customer Manually</Text>
                  </TouchableOpacity>
                </View>
              )}

              {showRetailerSearch && (
                <View style={styles.searchBlock}>
                  <TextInput
                    style={styles.textInput}
                    placeholder="Search retailer by business name..."
                    placeholderTextColor={colors.textMuted}
                    value={retailerSearch}
                    onChangeText={searchRetailers}
                  />
                  {retailersDropdown.map((r) => (
                    <TouchableOpacity
                      key={r.id}
                      style={styles.dropdownItem}
                      onPress={() => handleSelectRetailer(r)}
                    >
                      <Text style={styles.dropdownName}>{r.business_name || r.name}</Text>
                      <Text style={styles.dropdownSub}>{r.name} · {r.phone}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Invoice Meta Section */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Invoice Details</Text>
              <View style={styles.inputRow}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.fieldLabel}>Invoice Number</Text>
                  <TextInput
                    style={styles.textInput}
                    value={editedInvoice.invoice.number}
                    onChangeText={(val) =>
                      setEditedInvoice({
                        ...editedInvoice,
                        invoice: { ...editedInvoice.invoice, number: val },
                      })
                    }
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Invoice Date</Text>
                  <TextInput
                    style={styles.textInput}
                    value={editedInvoice.invoice.date}
                    onChangeText={(val) =>
                      setEditedInvoice({
                        ...editedInvoice,
                        invoice: { ...editedInvoice.invoice, date: val },
                      })
                    }
                  />
                </View>
              </View>
            </View>

            {/* Product items list */}
            <Text style={styles.sectionHeading}>Product Items Grid</Text>
            {editedInvoice.items.map((item, idx) => {
              const matchResult = validation?.productMatches?.find(
                (p) => p.itemIndex === idx
              );
              const isSearchingThis = productSearchIndex === idx;

              return (
                <View key={idx} style={styles.itemCard}>
                  {/* Extracted Details */}
                  <View style={styles.extractedItemHeader}>
                    <Text style={styles.itemIndexLabel}>Item #{idx + 1}</Text>
                    <Text style={styles.extractedItemName}>{item.product_name}</Text>
                    <Text style={styles.extractedItemSku}>Code: {item.product_code || 'None'}</Text>
                  </View>

                  {/* Matched DB Product */}
                  {matchResult?.matchedProduct ? (
                    <View style={styles.matchedProductCard}>
                      <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                      <Text style={styles.matchedProdText} numberOfLines={1}>
                        Matched: {matchResult.matchedProduct.name}
                      </Text>
                      <TouchableOpacity onPress={() => {
                        setProductSearchIndex(idx);
                        searchProducts(item.product_name);
                      }}>
                        <Text style={styles.changeLink}>Change</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.unmatchedBoxSmall}>
                      <Ionicons name="warning" size={16} color={colors.error} />
                      <Text style={styles.unmatchedProdText}>Unmatched product</Text>
                      <TouchableOpacity onPress={() => {
                        setProductSearchIndex(idx);
                        searchProducts(item.product_name);
                      }}>
                        <Text style={styles.selectLink}>Match Product</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {isSearchingThis && (
                    <View style={styles.productSearchBlock}>
                      <TextInput
                        style={styles.textInputSmall}
                        placeholder="Search product database..."
                        placeholderTextColor={colors.textMuted}
                        value={productSearchQuery}
                        onChangeText={searchProducts}
                      />
                      {productsDropdown.map((p) => (
                        <TouchableOpacity
                          key={p.id}
                          style={styles.dropdownItem}
                          onPress={() => handleSelectProductForLine(p, idx)}
                        >
                          <Text style={styles.dropdownName}>{p.name}</Text>
                          <Text style={styles.dropdownSub}>SKU: {p.sku} · Price: ₹{p.selling_price.toFixed(2)}</Text>
                        </TouchableOpacity>
                      ))}
                      <TouchableOpacity style={{ alignSelf: 'flex-end', marginTop: 4 }} onPress={() => setProductSearchIndex(null)}>
                        <Text style={{ color: colors.error, fontSize: 12 }}>Cancel Search</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Edit cells */}
                  <View style={styles.gridRow}>
                    <View style={styles.gridCol}>
                      <Text style={styles.gridLabel}>Quantity</Text>
                      <TextInput
                        style={styles.gridInput}
                        keyboardType="number-pad"
                        value={item.quantity.toString()}
                        onChangeText={(v) => handleUpdateItemValue(idx, 'quantity', v)}
                      />
                    </View>
                    <View style={styles.gridCol}>
                      <Text style={styles.gridLabel}>Rate</Text>
                      <TextInput
                        style={styles.gridInput}
                        keyboardType="numeric"
                        value={item.rate.toString()}
                        onChangeText={(v) => handleUpdateItemValue(idx, 'rate', v)}
                      />
                    </View>
                    <View style={styles.gridCol}>
                      <Text style={styles.gridLabel}>GST %</Text>
                      <TextInput
                        style={styles.gridInput}
                        keyboardType="numeric"
                        value={item.gst.toString()}
                        onChangeText={(v) => handleUpdateItemValue(idx, 'gst', v)}
                      />
                    </View>
                    <View style={styles.gridCol}>
                      <Text style={styles.gridLabel}>Discount</Text>
                      <TextInput
                        style={styles.gridInput}
                        keyboardType="numeric"
                        value={item.discount.toString()}
                        onChangeText={(v) => handleUpdateItemValue(idx, 'discount', v)}
                      />
                    </View>
                  </View>

                  {/* Row Totals */}
                  <View style={styles.rowTotalsContainer}>
                    <Text style={styles.rowAmountText}>Amount: ₹{item.amount.toFixed(2)}</Text>
                  </View>
                </View>
              );
            })}

            {/* Totals Recalculation Compare */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Totals Validation</Text>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalVal}>₹{editedInvoice.totals.subtotal.toFixed(2)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>GST Total</Text>
                <Text style={styles.totalVal}>₹{editedInvoice.totals.gst_total.toFixed(2)}</Text>
              </View>
              {editedInvoice.totals.discount_total > 0 && (
                <View style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { color: colors.success }]}>Discount Total</Text>
                  <Text style={[styles.totalVal, { color: colors.success }]}>-₹{editedInvoice.totals.discount_total.toFixed(2)}</Text>
                </View>
              )}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Round Off</Text>
                <Text style={styles.totalVal}>₹{editedInvoice.totals.round_off.toFixed(2)}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.totalRow}>
                <Text style={styles.grandLabel}>Grand Total</Text>
                <Text style={styles.grandVal}>₹{editedInvoice.totals.grand_total.toFixed(2)}</Text>
              </View>
            </View>

            {/* Order configurations */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Order Configurations</Text>

              <Text style={styles.fieldLabel}>Payment Mode</Text>
              <View style={styles.modeSelectorRow}>
                {['cod', 'credit', 'upi'].map((mode) => (
                  <TouchableOpacity
                    key={mode}
                    style={[styles.modeButton, paymentMode === mode && styles.modeButtonActive]}
                    onPress={() => setPaymentMode(mode as any)}
                  >
                    <Text style={[styles.modeButtonText, paymentMode === mode && styles.modeButtonTextActive]}>
                      {mode.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Order Notes (Optional)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="E.g. imported vendor invoice remarks..."
                placeholderTextColor={colors.textMuted}
                value={notes}
                onChangeText={setNotes}
              />
            </View>

            {/* Actions */}
            <View style={{ marginBottom: 40 }}>
              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  validation.overallStatus === 'failed' && styles.disabledBtn,
                ]}
                onPress={handleCreateOrder}
                disabled={validation.overallStatus === 'failed' || validating}
              >
                {validating ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Generate Order & Save Logs</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={styles.discardBtn} onPress={discardDraft}>
                <Text style={styles.discardBtnText}>Discard Draft & Start Over</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: {
      flex: 1,
      backgroundColor: isDark ? c.background : '#F5F5F5',
    },
    scrollContent: {
      padding: 16,
      paddingBottom: 60,
    },
    progressBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: c.border,
    },
    progressStep: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
    },
    progressStepActive: {
      color: c.primary,
      fontWeight: '700',
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: c.border,
      elevation: 2,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: c.text,
      marginBottom: 6,
    },
    cardSubtitle: {
      fontSize: 13,
      color: c.textSecondary,
      marginBottom: 20,
      lineHeight: 18,
    },
    uploadBtnRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      gap: 16,
      marginVertical: 10,
    },
    uploadBtn: {
      flex: 1,
      backgroundColor: c.primaryMuted,
      borderRadius: 12,
      paddingVertical: 20,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: c.primary,
      borderStyle: 'dashed' as const,
    },
    uploadBtnText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.primary,
      marginTop: 8,
    },
    previewImageContainer: {
      alignItems: 'center',
      marginVertical: 16,
    },
    previewImage: {
      width: '100%',
      height: 200,
      borderRadius: 12,
      backgroundColor: c.background,
    },
    fileNameText: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 6,
    },
    jsonInput: {
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      padding: 16,
      color: c.text,
      fontSize: 13,
      minHeight: 180,
      textAlignVertical: 'top' as const,
      borderWidth: 1,
      borderColor: c.border,
      fontFamily: 'monospace' as const,
      marginBottom: 16,
    },
    primaryBtn: {
      backgroundColor: c.primary,
      borderRadius: 12,
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: c.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 4,
    },
    primaryBtnText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '700',
    },
    discardBtn: {
      alignItems: 'center',
      paddingVertical: 12,
      marginTop: 8,
    },
    discardBtnText: {
      color: c.error,
      fontWeight: '600',
      fontSize: 14,
    },
    disabledBtn: {
      backgroundColor: c.textMuted,
      opacity: 0.5,
    },
    loadingBox: {
      alignItems: 'center',
      marginTop: 16,
    },
    loadingText: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 8,
    },
    validationPanel: {
      borderColor: c.warning,
      backgroundColor: isDark ? '#2c281e' : '#fffbf0',
    },
    overallStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    overallText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    statusBadge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
      fontSize: 12,
      fontWeight: '700',
      color: '#fff',
    },
    statusSuccess: { backgroundColor: c.success },
    statusWarning: { backgroundColor: c.warning },
    statusFailed: { backgroundColor: c.error },
    logRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: 8,
      gap: 8,
    },
    logText: {
      fontSize: 12,
      color: c.text,
      flex: 1,
    },
    extractedValBox: {
      backgroundColor: c.inputBackground,
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    boxLabel: {
      fontSize: 11,
      color: c.textMuted,
      textTransform: 'uppercase' as const,
    },
    boxVal: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
      marginVertical: 2,
    },
    boxLabelSmall: {
      fontSize: 12,
      color: c.textSecondary,
    },
    matchedCustomerCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.primaryMuted,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: c.primary,
    },
    matchedTitle: {
      fontSize: 11,
      color: c.primary,
      fontWeight: '700',
      textTransform: 'uppercase' as const,
    },
    matchedName: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
      marginTop: 2,
    },
    matchedSub: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 2,
    },
    changeLink: {
      fontSize: 13,
      fontWeight: '700',
      color: c.primary,
      marginLeft: 10,
    },
    selectLink: {
      fontSize: 13,
      fontWeight: '700',
      color: c.primary,
    },
    unmatchedBox: {
      backgroundColor: '#fdf0f0',
      borderWidth: 1,
      borderColor: c.error,
      borderRadius: 12,
      padding: 14,
      alignItems: 'center',
    },
    unmatchedText: {
      fontSize: 14,
      color: c.error,
      fontWeight: '600',
      marginBottom: 8,
    },
    secondaryBtn: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.primary,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    secondaryBtnText: {
      color: c.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    searchBlock: {
      marginTop: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: 12,
    },
    productSearchBlock: {
      marginTop: 8,
      backgroundColor: c.background,
      padding: 8,
      borderRadius: 8,
    },
    textInput: {
      backgroundColor: c.inputBackground,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      height: 44,
      color: c.text,
      fontSize: 14,
    },
    textInputSmall: {
      backgroundColor: c.inputBackground,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 10,
      height: 36,
      color: c.text,
      fontSize: 13,
    },
    dropdownItem: {
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    dropdownName: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    dropdownSub: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 1,
    },
    inputRow: {
      flexDirection: 'row',
    },
    fieldLabel: {
      fontSize: 12,
      color: c.textSecondary,
      fontWeight: '600',
      marginBottom: 4,
    },
    sectionHeading: {
      fontSize: 16,
      fontWeight: '700',
      color: c.text,
      marginVertical: 12,
    },
    itemCard: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    extractedItemHeader: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: 8,
      marginBottom: 10,
    },
    itemIndexLabel: {
      fontSize: 10,
      color: c.textMuted,
      textTransform: 'uppercase' as const,
      fontWeight: '700',
    },
    extractedItemName: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
      marginTop: 2,
    },
    extractedItemSku: {
      fontSize: 11,
      color: c.textSecondary,
      marginTop: 1,
    },
    matchedProductCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.successMuted,
      padding: 10,
      borderRadius: 8,
      marginBottom: 10,
    },
    matchedProdText: {
      fontSize: 13,
      color: c.text,
      fontWeight: '600',
      marginLeft: 6,
      flex: 1,
    },
    unmatchedBoxSmall: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.errorBg,
      padding: 10,
      borderRadius: 8,
      marginBottom: 10,
    },
    unmatchedProdText: {
      fontSize: 13,
      color: c.error,
      fontWeight: '600',
      marginLeft: 6,
      flex: 1,
    },
    gridRow: {
      flexDirection: 'row',
      gap: 8,
    },
    gridCol: {
      flex: 1,
    },
    gridLabel: {
      fontSize: 10,
      color: c.textMuted,
      marginBottom: 3,
    },
    gridInput: {
      backgroundColor: c.inputBackground,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
      textAlign: 'center',
      color: c.text,
      height: 38,
      fontSize: 13,
    },
    rowTotalsContainer: {
      alignItems: 'flex-end',
      marginTop: 10,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    rowAmountText: {
      fontSize: 14,
      fontWeight: '700',
      color: c.primary,
    },
    totalRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginVertical: 4,
    },
    totalLabel: {
      fontSize: 14,
      color: c.textSecondary,
    },
    totalVal: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    divider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 8,
    },
    grandLabel: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
    },
    grandVal: {
      fontSize: 16,
      fontWeight: '700',
      color: c.primary,
    },
    modeSelectorRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 12,
    },
    modeButton: {
      flex: 1,
      height: 40,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceSecondary,
    },
    modeButtonActive: {
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
    },
    modeButtonText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
    },
    modeButtonTextActive: {
      color: c.primary,
      fontWeight: '700',
    },
  } as const;
}
