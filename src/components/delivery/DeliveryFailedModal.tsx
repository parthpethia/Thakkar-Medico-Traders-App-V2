import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order } from '../../types';
import {
  DELIVERY_FAILURE_REASONS,
  DeliveryFailureReason,
} from '../../constants/orderFlow';
import { stopOrderTracking } from '../../services/riderLocationService';

/* ================= PROPS ================= */

type DeliveryFailedModalProps = {
  visible: boolean;
  order: Order | null;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

/* ================= COMPONENT ================= */

export function DeliveryFailedModal({
  visible,
  order,
  onClose,
  onSuccess,
  showToast,
}: DeliveryFailedModalProps) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [selectedReason, setSelectedReason] = useState<DeliveryFailureReason | null>(null);
  const [otherDetail, setOtherDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setSelectedReason(null);
    setOtherDetail('');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!order || !selectedReason) return;
    if (selectedReason === 'other' && !otherDetail.trim()) {
      setError('Please provide details for the "Other" reason.');
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const { error: rpcError } = await supabase.rpc('delivery_report_failed', {
        p_order_id: order.id,
        p_reason: selectedReason,
        p_notes: otherDetail.trim() || null,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to report delivery failure');
        return;
      }

      // Also ensure delivery_status & failed_at are updated on orders table
      const nowIso = new Date().toISOString();
      await supabase
        .from('orders')
        .update({
          delivery_status: 'failed',
          failed_reason: selectedReason === 'other' && otherDetail.trim() ? `Other: ${otherDetail.trim()}` : selectedReason,
          failed_at: nowIso,
        })
        .eq('id', order.id);

      await stopOrderTracking();

      handleClose();
      onSuccess();
      showToast('Delivery failure reported');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }, [order, selectedReason, otherDetail, handleClose, onSuccess, showToast]);

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Can't deliver?</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Select the reason why this order couldn't be delivered.
          </Text>

          {/* Reason options */}
          <View style={styles.reasonList}>
            {DELIVERY_FAILURE_REASONS.map((reason) => {
              const isSelected = selectedReason === reason.value;
              return (
                <TouchableOpacity
                  key={reason.value}
                  style={[styles.reasonItem, isSelected && styles.reasonItemSelected]}
                  onPress={() => {
                    setSelectedReason(reason.value);
                    setError(null);
                  }}
                >
                  <Ionicons
                    name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={isSelected ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[styles.reasonText, isSelected && styles.reasonTextSelected]}>
                    {reason.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Free-text detail for "other" */}
          {selectedReason === 'other' && (
            <TextInput
              style={styles.otherInput}
              placeholder="Describe the issue..."
              placeholderTextColor={colors.textMuted}
              value={otherDetail}
              onChangeText={setOtherDetail}
              multiline
              maxLength={200}
            />
          )}

          {/* Error message */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Submit button */}
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (!selectedReason || submitting) && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={!selectedReason || submitting}
          >
            {submitting ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <Text style={styles.submitBtnText}>Report Delivery Failed</Text>
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
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    subtitle: { fontSize: 14, color: c.textSecondary, marginBottom: 16 },
    reasonList: { gap: 6, marginBottom: 12 },
    reasonItem: {
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
    reasonItemSelected: {
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
    },
    reasonText: { fontSize: 15, color: c.text, flex: 1 },
    reasonTextSelected: { fontWeight: '600', color: c.primary },
    otherInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 12,
      fontSize: 14,
      color: c.text,
      minHeight: 60,
      textAlignVertical: 'top',
      marginBottom: 12,
    },
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
