import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order } from '../../types';

/* ================= TYPES ================= */

interface OrderItemDisplay {
  product_id: string;
  product_name: string;
  qty: number;
  unit_price: number;
  selected: boolean;
}

/* ================= PROPS ================= */

type RemoveItemsModalProps = {
  visible: boolean;
  order: Order | null;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

/* ================= COMPONENT ================= */

export function RemoveItemsModal({
  visible,
  order,
  onClose,
  onSuccess,
  showToast,
}: RemoveItemsModalProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [items, setItems] = useState<OrderItemDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch order items when modal opens
  useEffect(() => {
    if (!visible || !order) {
      setItems([]);
      setError(null);
      return;
    }

    (async () => {
      setLoading(true);
      try {
        const { data: orderItems, error: fetchErr } = await supabase
          .from('order_items')
          .select('product_id, qty, unit_price')
          .eq('order_id', order.id);

        if (fetchErr || !orderItems || orderItems.length === 0) {
          setError('Could not load order items');
          setLoading(false);
          return;
        }

        const productIds = orderItems.map((i: any) => i.product_id);
        const { data: products } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds);

        const nameMap = new Map(
          (products ?? []).map((p: { id: string; name: string }) => [p.id, p.name]),
        );

        setItems(
          orderItems.map((item: any) => ({
            product_id: item.product_id,
            product_name: nameMap.get(item.product_id) ?? 'Unknown Product',
            qty: item.qty,
            unit_price: item.unit_price,
            selected: false,
          })),
        );
      } catch {
        setError('Failed to load items');
      } finally {
        setLoading(false);
      }
    })();
  }, [visible, order]);

  const toggleItem = useCallback((index: number) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, selected: !item.selected } : item)),
    );
    setError(null);
  }, []);

  const selectedItems = items.filter((i) => i.selected);
  const remainingCount = items.length - selectedItems.length;

  const handleSubmit = useCallback(async () => {
    if (!order || selectedItems.length === 0) return;

    if (remainingCount === 0) {
      setError('Cannot remove all items. Cancel the order instead.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const { data, error: rpcError } = await supabase.rpc('admin_remove_order_items', {
        p_order_id: order.id,
        p_removed_product_ids: selectedItems.map((i) => i.product_id),
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to remove items');
        return;
      }

      onClose();
      onSuccess();

      const result = data as any;
      showToast(
        `${selectedItems.length} item(s) removed. New total: ₹${(result?.new_grand_total ?? 0).toFixed(2)}`,
      );
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }, [order, selectedItems, remainingCount, onClose, onSuccess, showToast]);

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Mark Items Unavailable</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Select items that are unavailable for packing. The retailer will be notified.
          </Text>

          {loading ? (
            <ActivityIndicator size="large" color={colors.primary} style={{ marginVertical: 24 }} />
          ) : (
            <ScrollView style={styles.itemList} showsVerticalScrollIndicator={false}>
              {items.map((item, index) => (
                <TouchableOpacity
                  key={item.product_id}
                  style={[styles.itemCard, item.selected && styles.itemCardSelected]}
                  onPress={() => toggleItem(index)}
                >
                  <Ionicons
                    name={item.selected ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={item.selected ? colors.error : colors.textSecondary}
                  />
                  <View style={styles.itemInfo}>
                    <Text
                      style={[styles.itemName, item.selected && styles.itemNameRemoved]}
                      numberOfLines={2}
                    >
                      {item.product_name}
                    </Text>
                    <Text style={styles.itemMeta}>
                      Qty: {item.qty} × ₹{item.unit_price.toFixed(2)}
                    </Text>
                  </View>
                  {item.selected && (
                    <View style={styles.unavailableBadge}>
                      <Text style={styles.unavailableBadgeText}>Unavailable</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Summary */}
          {selectedItems.length > 0 && (
            <View style={styles.summaryRow}>
              <Ionicons name="information-circle-outline" size={18} color={colors.warning} />
              <Text style={styles.summaryText}>
                {selectedItems.length} item(s) will be removed. {remainingCount} will remain.
              </Text>
            </View>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Submit */}
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (selectedItems.length === 0 || submitting || remainingCount === 0) &&
                styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={selectedItems.length === 0 || submitting || remainingCount === 0}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>
                Remove {selectedItems.length} Item(s) & Notify Retailer
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors) {
  return {
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 20,
      paddingBottom: 32,
      maxHeight: '75%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    subtitle: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    itemList: { marginBottom: 8 },
    itemCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      marginBottom: 6,
      backgroundColor: c.background,
    },
    itemCardSelected: {
      borderColor: c.error,
      backgroundColor: '#fef2f2',
    },
    itemInfo: { flex: 1 },
    itemName: { fontSize: 15, fontWeight: '500', color: c.text },
    itemNameRemoved: { textDecorationLine: 'line-through', color: c.textSecondary },
    itemMeta: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    unavailableBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
      backgroundColor: c.error,
    },
    unavailableBadgeText: { fontSize: 11, color: '#fff', fontWeight: '600' },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 4,
    },
    summaryText: { fontSize: 13, color: c.warning, flex: 1 },
    errorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
    submitBtn: {
      backgroundColor: c.error,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    submitBtnDisabled: { opacity: 0.5 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  } as const;
}
