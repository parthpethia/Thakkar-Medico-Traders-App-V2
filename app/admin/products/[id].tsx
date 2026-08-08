// P6: i18n applied + barcode_sku field with scanner
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import { BarcodeScanner } from '../../../src/components/BarcodeScanner';

const GST_OPTIONS = [0, 5, 12, 18, 28] as const;

type ProductFormData = {
  name: string;
  company: string;
  category: string;
  selling_price: string;
  mrp: string;
  gst_percent: number;
  unit: string;
  stock_quantity: string;
  is_active: boolean;
  barcode_sku: string;
};

const emptyForm: ProductFormData = {
  name: '',
  company: '',
  category: '',
  selling_price: '',
  mrp: '',
  gst_percent: 18,
  unit: '',
  stock_quantity: '0',
  is_active: true,
  barcode_sku: '',
};

export default function ProductForm() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isNew = id === 'new';

  const [form, setForm] = useState<ProductFormData>({ ...emptyForm });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const [categories, setCategories] = useState<string[]>([]);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [newCategory, setNewCategory] = useState('');

  // P6: Barcode scanner state
  const [scannerVisible, setScannerVisible] = useState(false);

  const updateField = <K extends keyof ProductFormData>(
    key: K,
    value: ProductFormData[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const fetchProduct = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) throw new Error('Product not found');

      setForm({
        name: data.name || '',
        company: data.company || '',
        category: data.category || '',
        selling_price: String(data.selling_price ?? ''),
        mrp: String(data.mrp ?? ''),
        gst_percent: data.gst_percent ?? 18,
        unit: data.pack_size || '',
        stock_quantity: String(data.stock_quantity ?? 0),
        is_active: data.is_active ?? true,
        barcode_sku: data.barcode_sku || '',
      });
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  const fetchCategories = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('get_product_categories');
      if (!error && data) {
        setCategories(
          (data as { category: string }[]).map((c) => c.category).filter(Boolean),
        );
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchCategories();
    if (!isNew) fetchProduct();
  }, [id]);

  const validate = (): string | null => {
    if (!form.name.trim()) return t('admin.productsScreen.nameRequired');
    const price = parseFloat(form.selling_price);
    if (isNaN(price) || price <= 0) return t('admin.productsScreen.validationPrice');
    const mrp = parseFloat(form.mrp);
    if (isNaN(mrp) || mrp < price)
      return t('admin.productsScreen.validationMrpFull');
    if (!GST_OPTIONS.includes(form.gst_percent as any))
      return t('admin.productsScreen.validationGstFull');
    const qty = parseInt(form.stock_quantity, 10);
    if (isNaN(qty) || qty < 0) return t('admin.productsScreen.validationStock');
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      Alert.alert(t('common.error'), err);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        p_name: form.name.trim(),
        p_company: form.company.trim() || null,
        p_category: form.category.trim() || null,
        p_selling_price: parseFloat(form.selling_price),
        p_mrp: parseFloat(form.mrp),
        p_gst_percent: form.gst_percent,
        p_unit: form.unit.trim() || null,
        p_stock_quantity: parseInt(form.stock_quantity, 10),
        p_active: form.is_active,
        p_barcode_sku: form.barcode_sku.trim() || null,
        ...(isNew ? {} : { p_id: id }),
      };

      const { error } = await supabase.rpc('upsert_product', payload);
      if (error) throw error;

      if (isNew) {
        Alert.alert(t('common.success'), t('admin.productsScreen.productCreated'), [
          { text: t('common.ok'), onPress: () => router.back() },
        ]);
      } else {
        Alert.alert(t('common.success'), t('admin.productsScreen.productUpdated'));
      }
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = () => {
    Alert.alert(
      t('admin.productsScreen.deactivate'),
      `${t('admin.productsScreen.deactivateConfirm')}`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('admin.productsScreen.deactivate'),
          style: 'destructive',
          onPress: async () => {
            setDeactivating(true);
            try {
              const { error } = await supabase.rpc('deactivate_product', {
                p_id: id,
              });
              if (error) throw error;
              updateField('is_active', false);
              Alert.alert(t('common.success'), t('admin.productDeactivated'));
            } catch (err: any) {
              Alert.alert(t('common.error'), err.message || t('common.error'));
            } finally {
              setDeactivating(false);
            }
          },
        },
      ],
    );
  };

  const selectCategory = (cat: string) => {
    updateField('category', cat);
    setShowCategoryPicker(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ title: t('common.loading') }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen
        options={{ title: isNew ? t('admin.productsScreen.addProduct') : t('admin.productsScreen.editProduct') }}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Basic Info */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('admin.productsScreen.basicInfo')}</Text>

            <Text style={styles.label}>{t('admin.productsScreen.name')} *</Text>
            <TextInput
              style={styles.input}
              placeholder={t('admin.productsScreen.namePlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={form.name}
              onChangeText={(v) => updateField('name', v)}
            />

            <Text style={styles.label}>{t('admin.productsScreen.company')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('admin.productsScreen.companyPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={form.company}
              onChangeText={(v) => updateField('company', v)}
            />

            <Text style={styles.label}>{t('admin.productsScreen.category')}</Text>
            <TouchableOpacity
              style={styles.pickerBtn}
              onPress={() => setShowCategoryPicker(!showCategoryPicker)}
            >
              <Text
                style={[
                  styles.pickerBtnText,
                  !form.category && { color: colors.textMuted },
                ]}
              >
                {form.category || t('admin.productsScreen.selectCategory')}
              </Text>
              <Ionicons
                name={showCategoryPicker ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textMuted}
              />
            </TouchableOpacity>

            {showCategoryPicker && (
              <View style={styles.categoryDropdown}>
                {categories.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[
                      styles.categoryOption,
                      form.category === cat && styles.categoryOptionActive,
                    ]}
                    onPress={() => selectCategory(cat)}
                  >
                    <Text
                      style={[
                        styles.categoryOptionText,
                        form.category === cat && styles.categoryOptionTextActive,
                      ]}
                    >
                      {cat}
                    </Text>
                  </TouchableOpacity>
                ))}

                <View style={styles.newCategoryRow}>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    placeholder={t('admin.productsScreen.newCategory')}
                    placeholderTextColor={colors.textMuted}
                    value={newCategory}
                    onChangeText={setNewCategory}
                  />
                  <TouchableOpacity
                    style={styles.newCategoryBtn}
                    onPress={() => {
                      if (!newCategory.trim()) return;
                      const trimmed = newCategory.trim();
                      if (!categories.includes(trimmed)) {
                        setCategories((prev) => [...prev, trimmed]);
                      }
                      updateField('category', trimmed);
                      setNewCategory('');
                      setShowCategoryPicker(false);
                    }}
                  >
                    <Ionicons name="add-circle" size={28} color={colors.primary} />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <Text style={styles.label}>{t('admin.productsScreen.unit')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('admin.productsScreen.unitPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={form.unit}
              onChangeText={(v) => updateField('unit', v)}
            />

            {/* P6: Barcode / SKU */}
            <Text style={styles.label}>{t('admin.productsScreen.barcodeSku')}</Text>
            <View style={styles.barcodeRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                placeholder="e.g. 8901234567890"
                placeholderTextColor={colors.textMuted}
                value={form.barcode_sku}
                onChangeText={(v) => updateField('barcode_sku', v)}
              />
              <TouchableOpacity
                style={styles.scanBtn}
                onPress={() => setScannerVisible(true)}
              >
                <Ionicons name="barcode-outline" size={22} color={colors.primary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Pricing */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('admin.productsScreen.pricing')}</Text>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{t('admin.productsScreen.sellingPrice')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  value={form.selling_price}
                  onChangeText={(v) => updateField('selling_price', v)}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{t('admin.productsScreen.mrp')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  value={form.mrp}
                  onChangeText={(v) => updateField('mrp', v)}
                />
              </View>
            </View>

            <Text style={styles.label}>{t('admin.productsScreen.gstPercent')}</Text>
            <View style={styles.gstRow}>
              {GST_OPTIONS.map((pct) => (
                <TouchableOpacity
                  key={pct}
                  style={[
                    styles.gstChip,
                    form.gst_percent === pct && styles.gstChipActive,
                  ]}
                  onPress={() => updateField('gst_percent', pct)}
                >
                  <Text
                    style={[
                      styles.gstChipText,
                      form.gst_percent === pct && styles.gstChipTextActive,
                    ]}
                  >
                    {pct}%
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Stock */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('admin.productsScreen.stockSection')}</Text>

            <Text style={styles.label}>{t('admin.productsScreen.stockQuantity')}</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={form.stock_quantity}
              onChangeText={(v) => updateField('stock_quantity', v)}
            />

            {!isNew && (
              <TouchableOpacity
                style={styles.stockHistoryLink}
                onPress={() => router.push('/admin/stock')}
              >
                <Ionicons name="time-outline" size={16} color={colors.primary} />
                <Text style={styles.stockHistoryText}>{t('admin.productsScreen.viewStockHistory')}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Status */}
          <View style={styles.section}>
            <View style={styles.switchRow}>
              <View>
                <Text style={styles.sectionTitle}>{t('admin.productsScreen.active')}</Text>
                <Text style={styles.switchHint}>
                  {form.is_active
                    ? t('admin.productsScreen.visibleToRetailers')
                    : t('admin.productsScreen.hiddenFromRetailers')}
                </Text>
              </View>
              <Switch
                value={form.is_active}
                onValueChange={(v) => updateField('is_active', v)}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={form.is_active ? colors.switchThumbOn : colors.switchThumbOff}
              />
            </View>
          </View>

          {/* Save */}
          <TouchableOpacity
            style={[styles.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={20} color={colors.onPrimary} />
                <Text style={styles.saveBtnText}>
                  {isNew ? t('admin.productsScreen.createProduct') : t('admin.productsScreen.saveChanges')}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Deactivate (edit mode only, when active) */}
          {!isNew && form.is_active && (
            <TouchableOpacity
              style={[styles.dangerBtn, deactivating && { opacity: 0.6 }]}
              onPress={handleDeactivate}
              disabled={deactivating}
              activeOpacity={0.85}
            >
              {deactivating ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="close-circle" size={20} color={colors.onPrimary} />
                  <Text style={styles.dangerBtnText}>{t('admin.productsScreen.deactivate')}</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* P6: Barcode Scanner */}
      <BarcodeScanner
        visible={scannerVisible}
        onScan={(code) => updateField('barcode_sku', code)}
        onClose={() => setScannerVisible(false)}
      />
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },

  section: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: c.text,
    marginBottom: 12,
  },

  label: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: c.textSecondary,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: c.text,
    marginBottom: 14,
    backgroundColor: c.surfaceSecondary,
  },

  // P6: Barcode row
  barcodeRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    marginBottom: 14,
  },
  scanBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: c.primaryMuted,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },

  pickerBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    backgroundColor: c.surfaceSecondary,
  },
  pickerBtnText: {
    fontSize: 15,
    color: c.text,
  },

  categoryDropdown: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 8,
    marginTop: -8,
    marginBottom: 14,
    backgroundColor: c.surfaceSecondary,
  },
  categoryOption: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  categoryOptionActive: {
    backgroundColor: c.primaryMuted,
  },
  categoryOptionText: {
    fontSize: 14,
    color: c.text,
  },
  categoryOptionTextActive: {
    color: c.primary,
    fontWeight: '600' as const,
  },
  newCategoryRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
    paddingTop: 8,
  },
  newCategoryBtn: {
    padding: 4,
  },

  row: {
    flexDirection: 'row' as const,
  },

  gstRow: {
    flexDirection: 'row' as const,
    gap: 8,
    marginBottom: 8,
  },
  gstChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: c.borderLight,
    alignItems: 'center' as const,
  },
  gstChipActive: {
    backgroundColor: c.primary,
  },
  gstChipText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: c.textSecondary,
  },
  gstChipTextActive: {
    color: c.onPrimary,
  },

  switchRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  },
  switchHint: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: -8,
  },

  stockHistoryLink: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
    marginTop: 4,
  },
  stockHistoryText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600' as const,
    color: c.primary,
  },

  saveBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    backgroundColor: c.primary,
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  saveBtnText: {
    color: c.onPrimary,
    fontSize: 16,
    fontWeight: '700' as const,
  },

  dangerBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    backgroundColor: c.error,
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  dangerBtnText: {
    color: c.onPrimary,
    fontSize: 16,
    fontWeight: '700' as const,
  },

  };
}

