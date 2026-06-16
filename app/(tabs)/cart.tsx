import React, { useEffect, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { TabScreenFrame, useTabTopInset } from '../../src/components/TabScreenFrame';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import CartItemComponent from '../../src/components/CartItem';
import { useCartStore } from '../../src/store/cartStore';
import { useAuthStore } from '../../src/store/authStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { computeOrderTotals } from '../../src/utils/orderTotals';
import { useTranslation } from 'react-i18next';
import { TAB_BAR_LAYOUT, tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function CartScreen() {
  const styles = useThemedStyles(createTabStyles);
  const topInset = useTabTopInset();
  const router = useRouter();
  const { t } = useTranslation();
  const {
    items,
    loading,
    fetchCart,
    updateQuantity,
    removeFromCart,
  } = useCartStore();
  const { user, authReady } = useAuthStore();
  const settings = useSettingsStore((s) => s.settings);

  const gstEnabled = settings?.features?.gst_enabled ?? true;

  useEffect(() => {
    if (!authReady || !user?.id) return;
    if (items.length === 0 && !loading) {
      void fetchCart();
    }
  }, [authReady, user?.id, fetchCart, items.length, loading]);

  const { subtotal, gst, grandTotal: total } = useMemo(
    () => computeOrderTotals(
      items.map((i) => ({
        selling_price: i.selling_price,
        quantity: i.quantity,
        gst_percent: i.gst_percent,
      })),
      gstEnabled,
    ),
    [items, gstEnabled],
  );

  const isApproved = user?.approved ?? false;

  // FIX C — Credit info
  const creditLimit = user?.credit_limit ?? 0;
  const creditUsed = user?.credit_used ?? 0;
  const creditRemaining = creditLimit - creditUsed;
  const hasCreditLimit = creditLimit > 0;
  const wouldExceedCredit = hasCreditLimit && total > creditRemaining;
  const creditUsedPercent = creditLimit > 0 ? Math.min((creditUsed / creditLimit) * 100, 100) : 0;

  return (
    <TabScreenFrame style={styles.container}>
      {/* FIX C — Credit bar in header */}
      {hasCreditLimit && isApproved && settings?.features?.credit_enabled && (
        <View style={[styles.creditBar, { paddingTop: topInset + 12 }]}>
          <View style={styles.creditBarHeader}>
            <Ionicons name="wallet-outline" size={16} color="#4C51C9" />
            <Text style={styles.creditBarLabel}>
              Credit: ₹{creditUsed.toFixed(0)} of ₹{creditLimit.toFixed(0)} used
            </Text>
          </View>
          <View style={styles.creditTrack}>
            <View style={[styles.creditFill, { width: `${creditUsedPercent}%` as any,
              backgroundColor: creditUsedPercent > 80 ? '#EF5350' : creditUsedPercent > 60 ? '#FFA726' : '#4C51C9' }]} />
          </View>
          <Text style={styles.creditRemaining}>
            ₹{creditRemaining.toFixed(0)} remaining
          </Text>
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{
          padding: 16,
          paddingTop: hasCreditLimit && isApproved && settings?.features?.credit_enabled ? 16 : topInset + 16,
          ...tabScrollBottomPadding(),
        }}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews
        renderItem={({ item }) => (
          <CartItemComponent
            item={item}
            onUpdateQuantity={(qty) => updateQuantity(item.id, qty)}
            onRemove={() => removeFromCart(item.id)}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="cart-outline" size={64} color="#ccc" />
              <Text style={styles.emptyTitle}>{t('cart.empty')}</Text>
              <Text style={styles.emptySubtitle}>{t('cart.emptySubtitle')}</Text>
              <TouchableOpacity
                style={styles.browseBtn}
                onPress={() => router.push('/(tabs)/products')}
              >
                <Text style={styles.browseBtnText}>{t('cart.browseProducts')}</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />

      {items.length > 0 && (
        <View style={styles.footer}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{t('cart.subtotal')}</Text>
            <Text style={styles.summaryValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          {gstEnabled && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t('cart.gst')}</Text>
              <Text style={styles.summaryValue}>₹{gst.toFixed(2)}</Text>
            </View>
          )}
          <View style={[styles.summaryRow, styles.totalRow]}>
            <Text style={styles.totalLabel}>{t('cart.total')}</Text>
            <Text style={styles.totalValue}>₹{total.toFixed(2)}</Text>
          </View>

          {!isApproved && (
            <View style={styles.approvalBanner}>
              <Ionicons name="alert-circle" size={16} color="#e53935" />
              <Text style={styles.approvalText}>{t('cart.accountPending')}</Text>
            </View>
          )}

          {/* FIX C — Credit limit warning */}
          {isApproved && wouldExceedCredit && (
            <View style={styles.creditWarningBanner}>
              <Ionicons name="warning" size={16} color="#E65100" />
              <Text style={styles.creditWarningText}>
                Order total (₹{total.toFixed(0)}) exceeds remaining credit (₹{creditRemaining.toFixed(0)})
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.placeOrderBtn, (!isApproved || wouldExceedCredit) && styles.placeOrderBtnDisabled]}
            onPress={() => router.push('/checkout')}
            disabled={!isApproved || wouldExceedCredit}
          >
            <Text style={styles.placeOrderText}>
              {!isApproved
                ? t('cart.approvalRequired')
                : wouldExceedCredit
                  ? t('cart.creditLimitExceeded')
                  : t('cart.placeOrder')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </TabScreenFrame>
  );
}

function createTabStyles(c: AppColors) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  emptyContainer: {
    alignItems: 'center' as const,
    marginTop: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: c.textSecondary,
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: c.textMuted,
    marginTop: 6,
    textAlign: 'center' as const,
  },
  browseBtn: {
    marginTop: 20,
    backgroundColor: c.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  browseBtnText: {
    color: c.onPrimary,
    fontWeight: '600' as const,
    fontSize: 15,
  },
  footer: {
    padding: 16,
    paddingBottom: TAB_BAR_LAYOUT.scrollBottomInset,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  summaryRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 6,
  },
  summaryLabel: { fontSize: 14, color: c.textSecondary },
  summaryValue: { fontSize: 14, color: c.text },
  totalRow: {
    borderTopWidth: 1,
    borderColor: c.border,
    paddingTop: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  totalLabel: { fontWeight: '700' as const, fontSize: 16, color: c.text },
  totalValue: { fontWeight: '700' as const, fontSize: 16, color: c.primary },
  approvalBanner: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    backgroundColor: c.surfaceSecondary,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  approvalText: {
    color: c.error,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  placeOrderBtn: {
    backgroundColor: c.primary,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center' as const,
  },
  placeOrderBtnDisabled: {
    backgroundColor: c.textMuted,
  },
  placeOrderText: {
    color: c.onPrimary,
    fontWeight: '700' as const,
    fontSize: 16,
  },
  creditBar: {
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  creditBarHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    marginBottom: 6,
  },
  creditBarLabel: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: c.text,
  },
  creditTrack: {
    height: 6,
    backgroundColor: c.borderLight,
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  creditFill: {
    height: '100%' as const,
    borderRadius: 3,
  },
  creditRemaining: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 4,
  },
  creditWarningBanner: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    backgroundColor: c.warningBg,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  creditWarningText: {
    color: c.warning,
    fontSize: 12,
    fontWeight: '600' as const,
    flex: 1,
  },
};
}
