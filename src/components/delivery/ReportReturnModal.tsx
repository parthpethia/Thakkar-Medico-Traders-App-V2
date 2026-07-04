import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order } from '../../types';
import { RETURN_REASONS, ReturnReason } from '../../constants/orderFlow';

/* ================= TYPES ================= */

interface OrderItemRow {
  product_id: string;
  qty: number;
  product_name: string;
}

interface ReturnEntry {
  product_id: string;
  product_name: string;
  max_qty: number;
  quantity: number;
  reason: ReturnReason;
  reason_detail: string;
  selected: boolean;
}

/* ================= PROPS ================= */

type ReportReturnModalProps = {
  visible: boolean;
  order: Order | null;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

/* ================= COMPONENT ================= */

export function ReportReturnModal({
  visible,
  order,
  onClose,
  onSuccess,
  showToast,
}: ReportReturnModalProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [entries, setEntries] = useState<ReturnEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch order items with product names when modal opens
  useEffect(() => {
    if (!visible || !order) {
      setEntries([]);
      setError(null);
      return;
    }

    (async () => {
      setLoading(true);
      try {
        const { data: items, error: fetchErr } = await supabase
          .from('order_items')
          .select('product_id, qty')
          .eq('order_id', order.id);

        if (fetchErr || !items || items.length === 0) {
          setError('Could not load order items');
          setLoading(false);
          return;
        }

        // Fetch product names
        const productIds = items.map((i: OrderItemRow) => i.product_id);
        const { data: products } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds);

        const nameMap = new Map(
          (products ?? []).map((p: { id: string; name: string }) => [p.id, p.name]),
        );

        setEntries(
          items.map((item: OrderItemRow) => ({
            product_id: item.product_id,
            product_name: nameMap.get(item.product_id) ?? 'Unknown Product',
            max_qty: item.qty,
            quantity: 1,
            reason: 'damaged' as ReturnReason,
            reason_detail: '',
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
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, selected: !e.selected } : e)),
    );
    setError(null);
  }, []);

  const updateEntry = useCallback(
    (index: number, field: keyof ReturnEntry, value: any) => {
      setEntries((prev) =>
        prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)),
      );
    },
    [],
  );

  const selectedEntries = entries.filter((e) => e.selected);

  const handleSubmit = useCallback(async () => {
    if (!order || selectedEntries.length === 0) return;
    setSubmitting(true);
    setError(null);

    const items = selectedEntries.map((e) => ({
      product_id: e.product_id,
      quantity: e.quantity,
      reason: e.reason,
      reason_detail: e.reason_detail || null,
    }));

    try {
      const { error: rpcError } = await supabase.rpc('report_return_items', {
        p_order_id: order.id,
        p_items: items,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to report returns');
        return;
      }

      onClose();
      onSuccess();
      showToast(`${selectedEntries.length} item(s) reported`);
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }, [order, selectedEntries, onClose, onSuccess, showToast]);

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Report Item Issues</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Select items that are damaged, wrong, or rejected by the retailer.
          </Text>

          {loading ? (
            <ActivityIndicator size="large" color={colors.primary} style={{ marginVertical: 24 }} />
          ) : (
            <ScrollView style={styles.itemList} showsVerticalScrollIndicator={false}>
              {entries.map((entry, index) => (
                <View key={entry.product_id} style={styles.itemCard}>
                  {/* Checkbox + product name */}
                  <TouchableOpacity
                    style={styles.itemHeader}
                    onPress={() => toggleItem(index)}
                  >
                    <Ionicons
                      name={entry.selected ? 'checkbox' : 'square-outline'}
                      size={24}
                      color={entry.selected ? colors.primary : colors.textSecondary}
                    />
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemName} numberOfLines={2}>
                        {entry.product_name}
                      </Text>
                      <Text style={styles.itemQty}>Ordered: {entry.max_qty}</Text>
                    </View>
                  </TouchableOpacity>

                  {/* Expanded section when selected */}
                  {entry.selected && (
                    <View style={styles.expandedSection}>
                      {/* Quantity */}
                      <View style={styles.fieldRow}>
                        <Text style={styles.fieldLabel}>Affected qty:</Text>
                        <View style={styles.qtyControls}>
                          <TouchableOpacity
                            style={styles.qtyBtn}
                            onPress={() =>
                              updateEntry(index, 'quantity', Math.max(1, entry.quantity - 1))
                            }
                          >
                            <Ionicons name="remove" size={18} color={colors.text} />
                          </TouchableOpacity>
                          <Text style={styles.qtyValue}>{entry.quantity}</Text>
                          <TouchableOpacity
                            style={styles.qtyBtn}
                            onPress={() =>
                              updateEntry(
                                index,
                                'quantity',
                                Math.min(entry.max_qty, entry.quantity + 1),
                              )
                            }
                          >
                            <Ionicons name="add" size={18} color={colors.text} />
                          </TouchableOpacity>
                        </View>
                      </View>

                      {/* Reason picker */}
                      <View style={styles.reasonRow}>
                        {RETURN_REASONS.map((r) => (
                          <TouchableOpacity
                            key={r.value}
                            style={[
                              styles.reasonChip,
                              entry.reason === r.value && styles.reasonChipSelected,
                            ]}
                            onPress={() => updateEntry(index, 'reason', r.value)}
                          >
                            <Text
                              style={[
                                styles.reasonChipText,
                                entry.reason === r.value && styles.reasonChipTextSelected,
                              ]}
                            >
                              {r.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      {/* Detail */}
                      {entry.reason === 'other' && (
                        <TextInput
                          style={styles.detailInput}
                          placeholder="Describe the issue..."
                          placeholderTextColor={colors.textMuted}
                          value={entry.reason_detail}
                          onChangeText={(v) => updateEntry(index, 'reason_detail', v)}
                          maxLength={200}
                        />
                      )}
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Submit */}
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (selectedEntries.length === 0 || submitting) && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={selectedEntries.length === 0 || submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>
                Report {selectedEntries.length > 0 ? `${selectedEntries.length} Item(s)` : 'Issues'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
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
      maxHeight: '80%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    subtitle: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    itemList: { marginBottom: 12 },
    itemCard: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      marginBottom: 8,
      overflow: 'hidden',
    },
    itemHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
    },
    itemInfo: { flex: 1 },
    itemName: { fontSize: 15, fontWeight: '500', color: c.text },
    itemQty: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    expandedSection: {
      padding: 12,
      paddingTop: 0,
      gap: 10,
    },
    fieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    fieldLabel: { fontSize: 14, color: c.textSecondary },
    qtyControls: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    qtyBtn: {
      width: 32,
      height: 32,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    qtyValue: { fontSize: 16, fontWeight: '600', color: c.text, minWidth: 24, textAlign: 'center' },
    reasonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    reasonChip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    reasonChipSelected: {
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
    },
    reasonChipText: { fontSize: 12, color: c.textSecondary },
    reasonChipTextSelected: { color: c.primary, fontWeight: '600' },
    detailInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 13,
      color: c.text,
      minHeight: 40,
    },
    errorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
    submitBtn: {
      backgroundColor: c.warning,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    submitBtnDisabled: { opacity: 0.5 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  } as const;
}
