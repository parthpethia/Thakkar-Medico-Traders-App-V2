import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, PackagingLevel, shouldShowPrices, canAddToCart, PRODUCT_WITH_PACKAGING_SELECT } from '../../src/types';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function ProductDetail() {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();

  const [product, setProduct] = useState<Product | null>(null);
  const [packagingLevels, setPackagingLevels] = useState<PackagingLevel[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<PackagingLevel | null>(null);
  const [qty, setQty] = useState(1);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const showPrices = shouldShowPrices(user, settings);
  const allowAddToCart = canAddToCart(user);

  useEffect(() => {
    if (!id) return;

    const fetchProduct = async () => {
      try {
        const { data, error } = await supabase
          .from('products')
          .select(PRODUCT_WITH_PACKAGING_SELECT)
          .eq('id', id)
          .single();

        if (error) throw error;
        setProduct(data);

        // Set packaging levels sorted by display_order
        const levels: PackagingLevel[] = (data.product_packaging_levels ?? [])
          .sort((a: PackagingLevel, b: PackagingLevel) => a.display_order - b.display_order);
        setPackagingLevels(levels);

        // Default to base level, or first level
        const base = levels.find((l: PackagingLevel) => l.is_base) ?? levels[0] ?? null;
        setSelectedLevel(base);
        if (base) {
          setQty(base.min_order_qty);
        }
      } catch {
        console.error('Failed to load product');
      } finally {
        setLoading(false);
      }
    };

    fetchProduct();
  }, [id]);

  // When selected packaging level changes, reset qty to its min
  const handleLevelChange = (level: PackagingLevel) => {
    setSelectedLevel(level);
    setQty(level.min_order_qty);
  };

  const handleAddToCart = async () => {
    if (!user) {
      Alert.alert('Login required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }
    if (!product) return;

    try {
      setAdding(true);
      const result = await addToCart(product.id, qty, {
        packaging_level_id: selectedLevel?.id,
        packaging_level_name: selectedLevel?.level_name,
        units_per_level: selectedLevel?.units_per_level ?? 1,
        min_order_qty: selectedLevel?.min_order_qty ?? 1,
        increment_step: selectedLevel?.increment_step ?? 1,
      });
      if (result === true) {
        const unitLabel = selectedLevel ? `${qty} ${selectedLevel.level_name}(s)` : `${qty}`;
        Alert.alert('Added to cart', `${product.name} — ${unitLabel}`);
      } else if (typeof result === 'object' && 'error' in result) {
        Alert.alert('Unable to add', result.error);
      } else {
        Alert.alert('Error', 'Failed to add to cart. Please try again.');
      }
    } finally {
      setAdding(false);
    }
  };

  const stepDown = () => {
    if (!selectedLevel) {
      setQty((q) => Math.max(1, q - 1));
      return;
    }
    setQty((q) => Math.max(selectedLevel.min_order_qty, q - selectedLevel.increment_step));
  };

  const stepUp = () => {
    if (!selectedLevel) {
      setQty((q) => q + 1);
      return;
    }
    setQty((q) => q + selectedLevel.increment_step);
  };

  /* ================= LOADING ================= */

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

  if (!product) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color={colors.switchThumbOff} />
          <Text style={styles.notFound}>Product not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  /* ================= COMPUTED ================= */

  const isZeroPrice = (product.selling_price ?? 0) <= 0 || (product.mrp ?? 0) <= 0;
  const discount =
    product.mrp > product.selling_price && !isZeroPrice
      ? Math.round(
          ((product.mrp - product.selling_price) / product.mrp) * 100
        )
      : 0;

  const isOutOfStock = product.stock_quantity <= 0 || isZeroPrice;

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
          <Ionicons name="medical" size={64} color={colors.primary} />
        </View>

        {/* Name & Company */}
        <Text style={styles.name}>{product.name}</Text>
        {product.company && (
          <Text style={styles.company}>{product.company}</Text>
        )}

        {/* Pack size */}
        {product.pack_size && (
          <View style={styles.packBadge}>
            <Ionicons name="cube-outline" size={16} color={colors.primary} />
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
            value={isOutOfStock ? 'Out of stock' : 'Available'}
            valueColor={isOutOfStock ? colors.error : colors.success}
          />
        </View>
        {/* Packaging level selector */}
        {packagingLevels.length > 1 && (
          <View style={styles.packagingSection}>
            <Text style={styles.detailsTitle}>Packaging</Text>
            <View style={styles.packagingRow}>
              {packagingLevels.map((level) => {
                const isSelected = selectedLevel?.id === level.id;
                return (
                  <TouchableOpacity
                    key={level.id}
                    style={[styles.packagingPill, isSelected && styles.packagingPillActive]}
                    onPress={() => handleLevelChange(level)}
                  >
                    <Text style={[styles.packagingPillText, isSelected && styles.packagingPillTextActive]}>
                      {level.level_name}
                    </Text>
                    <Text style={[styles.packagingPillSub, isSelected && styles.packagingPillSubActive]}>
                      {level.units_per_level === 1 ? 'base unit' : `${level.units_per_level} units`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Quantity stepper */}
        {!isOutOfStock && allowAddToCart && (
          <View style={styles.stepperSection}>
            <Text style={styles.detailsTitle}>Quantity</Text>
            <View style={styles.stepperRow}>
              <TouchableOpacity
                style={styles.stepperBtn}
                onPress={stepDown}
                disabled={qty <= (selectedLevel?.min_order_qty ?? 1)}
              >
                <Ionicons name="remove" size={22} color={qty <= (selectedLevel?.min_order_qty ?? 1) ? colors.textMuted : colors.text} />
              </TouchableOpacity>
              <Text style={styles.stepperQty}>{qty}</Text>
              <TouchableOpacity style={styles.stepperBtn} onPress={stepUp}>
                <Ionicons name="add" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            {selectedLevel && (
              <Text style={styles.stepperHint}>
                Min: {selectedLevel.min_order_qty} {selectedLevel.level_name}(s)
                {selectedLevel.units_per_level > 1 ? ` · ${qty * selectedLevel.units_per_level} base units total` : ''}
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      {!isOutOfStock && allowAddToCart && (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <TouchableOpacity
            style={[styles.addBtn, adding && styles.addBtnDisabled]}
            onPress={handleAddToCart}
            disabled={adding}
          >
            {adding ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <>
                <Ionicons name="cart-outline" size={22} color={colors.onPrimary} />
                <Text style={styles.addBtnText}>
                  Add {qty} {selectedLevel?.level_name ?? 'unit'}(s) to Cart
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {isOutOfStock && (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.outOfStockBar}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
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
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLeft}>
        <Ionicons name={icon} size={16} color={colors.textMuted} />
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

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  notFound: { marginTop: 12, color: c.textMuted, fontSize: 16 },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  /* Image placeholder */
  imageBox: {
    width: '100%',
    height: 180,
    backgroundColor: c.primaryMuted,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },

  /* Name */
  name: {
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
  },

  company: {
    fontSize: 15,
    color: c.textSecondary,
    marginTop: 4,
  },

  /* Pack size badge */
  packBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.primaryMuted,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginTop: 10,
  },

  packText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.primary,
  },

  /* Price */
  priceSection: {
    marginTop: 16,
    backgroundColor: c.surface,
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
    color: c.primary,
  },

  mrp: {
    fontSize: 16,
    color: c.textMuted,
    textDecorationLine: 'line-through',
  },

  discountBadge: {
    backgroundColor: c.successMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },

  discountText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.success,
  },

  gstNote: {
    fontSize: 13,
    color: c.textMuted,
    marginTop: 6,
  },

  /* Details card */
  detailsCard: {
    marginTop: 16,
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
  },

  detailsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
    marginBottom: 12,
  },

  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },

  detailLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  detailLabel: {
    fontSize: 14,
    color: c.textMuted,
  },

  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: c.text,
  },

  /* Footer */
  footer: {
    padding: 16,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
    height: 56,
    borderRadius: 12,
  },

  addBtnDisabled: {
    opacity: 0.6,
  },

  addBtnText: {
    color: c.surface,
    fontSize: 18,
    fontWeight: '600',
  },

  outOfStockBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: isDark ? c.surfaceSecondary : '#FFEBEE',
    paddingVertical: 14,
    borderRadius: 12,
  },

  outOfStockText: {
    color: c.error,
    fontSize: 14,
    fontWeight: '600',
  },

  /* Packaging selector */
  packagingSection: {
    marginTop: 16,
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
  },

  packagingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },

  packagingPill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceSecondary,
    alignItems: 'center',
  },

  packagingPillActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },

  packagingPillText: {
    fontSize: 14,
    fontWeight: '600',
    color: c.textSecondary,
    textTransform: 'capitalize',
  },

  packagingPillTextActive: {
    color: c.primary,
  },

  packagingPillSub: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },

  packagingPillSubActive: {
    color: c.primary,
  },

  /* Quantity stepper */
  stepperSection: {
    marginTop: 16,
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
  },

  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },

  stepperBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  stepperQty: {
    fontSize: 24,
    fontWeight: '700',
    color: c.text,
    minWidth: 48,
    textAlign: 'center',
  },

  stepperHint: {
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
  } as const;
}
