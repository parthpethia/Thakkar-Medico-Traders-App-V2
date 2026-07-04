import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { RETURN_RESOLUTIONS } from '../../constants/orderFlow';

/* ================= TYPES ================= */

export interface ReturnItem {
  id: string;
  product_id: string;
  product_name?: string;
  quantity: number;
  reason: string;
  reason_detail?: string;
  status: string;
  resolution: string;
}

/* ================= PROPS ================= */

type ResolveReturnModalProps = {
  visible: boolean;
  returnItem: ReturnItem | null;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

/* ================= COMPONENT ================= */

export function ResolveReturnModal({
  visible,
  returnItem,
  onClose,
  onSuccess,
  showToast,
}: ResolveReturnModalProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setSelectedResolution(null);
    setNotes('');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!returnItem || !selectedResolution) return;
    setSubmitting(true);
    setError(null);

    try {
      const { error: rpcError } = await supabase.rpc('admin_resolve_return', {
        p_return_id: returnItem.id,
        p_resolution: selectedResolution,
        p_notes: notes || null,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to resolve return');
        return;
      }

      handleClose();
      onSuccess();
      showToast('Return resolved');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }, [returnItem, selectedResolution, notes, handleClose, onSuccess, showToast]);

  if (!returnItem) return null;

  const reasonLabels: Record<string, string> = {
    damaged: 'Damaged',
    wrong_item: 'Wrong item',
    rejected: 'Rejected',
    expired: 'Expired',
    other: 'Other',
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Resolve Return</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Return info */}
          <View style={styles.infoCard}>
            <Text style={styles.productName}>{returnItem.product_name ?? 'Product'}</Text>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Quantity:</Text>
              <Text style={styles.infoValue}>{returnItem.quantity}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Reason:</Text>
              <Text style={styles.infoValue}>
                {reasonLabels[returnItem.reason] ?? returnItem.reason}
              </Text>
            </View>
            {returnItem.reason_detail ? (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Detail:</Text>
                <Text style={styles.infoValue}>{returnItem.reason_detail}</Text>
              </View>
            ) : null}
          </View>

          {/* Resolution options */}
          <Text style={styles.sectionLabel}>Select resolution:</Text>
          <View style={styles.resolutionList}>
            {RETURN_RESOLUTIONS.map((r) => {
              const isSelected = selectedResolution === r.value;
              return (
                <TouchableOpacity
                  key={r.value}
                  style={[styles.resolutionItem, isSelected && styles.resolutionItemSelected]}
                  onPress={() => {
                    setSelectedResolution(r.value);
                    setError(null);
                  }}
                >
                  <Ionicons
                    name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={isSelected ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[styles.resolutionText, isSelected && styles.resolutionTextSelected]}>
                    {r.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Notes */}
          <TextInput
            style={styles.notesInput}
            placeholder="Add notes (optional)..."
            placeholderTextColor={colors.textMuted}
            value={notes}
            onChangeText={setNotes}
            multiline
            maxLength={300}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Submit */}
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (!selectedResolution || submitting) && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={!selectedResolution || submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>Resolve Return</Text>
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
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    infoCard: {
      backgroundColor: c.background,
      borderRadius: 10,
      padding: 14,
      marginBottom: 16,
      gap: 6,
    },
    productName: { fontSize: 16, fontWeight: '600', color: c.text, marginBottom: 4 },
    infoRow: { flexDirection: 'row', gap: 8 },
    infoLabel: { fontSize: 13, color: c.textSecondary, minWidth: 70 },
    infoValue: { fontSize: 13, color: c.text, flex: 1 },
    sectionLabel: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 8 },
    resolutionList: { gap: 6, marginBottom: 12 },
    resolutionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    resolutionItemSelected: {
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
    },
    resolutionText: { fontSize: 15, color: c.text },
    resolutionTextSelected: { fontWeight: '600', color: c.primary },
    notesInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 12,
      fontSize: 14,
      color: c.text,
      minHeight: 50,
      textAlignVertical: 'top',
      marginBottom: 12,
    },
    errorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
    submitBtn: {
      backgroundColor: c.success,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    submitBtnDisabled: { opacity: 0.5 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  } as const;
}
