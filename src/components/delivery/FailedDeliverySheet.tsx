/**
 * FailedDeliverySheet — Bottom sheet for recording a failed delivery attempt.
 *
 * Flow:
 * 1. Rider selects failure reason from standardized list:
 *    - Shop was closed
 *    - Receiver not available
 *    - Wrong address / could not locate
 *    - Refused to accept delivery
 *    - Vehicle breakdown
 *    - Other (specify below)
 * 2. Optional additional notes input.
 * 3. On Submit:
 *    - Updates orders table (status='delivery_failed', delivery_status='failed', failed_reason, failed_at=now()).
 *    - Stops location broadcasting via riderLocationService.stopOrderTracking().
 *    - Triggers full-screen failure overlay on active delivery screen.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { stopOrderTracking } from '../../services/riderLocationService';
import { triggerNotification } from '../../services/notificationTriggerService';
import { DELIVERY_FAILURE_REASONS, type DeliveryFailureReason } from '../../constants/orderFlow';

export interface FailedDeliverySheetProps {
  visible: boolean;
  orderId: string;
  orderNumber: string;
  shopName: string;
  onClose: () => void;
  onFailed: (reason: string) => void;
}

export function FailedDeliverySheet({
  visible,
  orderId,
  orderNumber,
  shopName,
  onClose,
  onFailed,
}: FailedDeliverySheetProps) {
  const insets = useSafeAreaInsets();
  const [selectedReason, setSelectedReason] = useState<DeliveryFailureReason>('shop_closed');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (submitting) return;
    setSelectedReason('shop_closed');
    setNotes('');
    onClose();
  };

  const handleSubmit = async () => {
    if (selectedReason === 'other' && !notes.trim()) {
      Alert.alert('Required', 'Please describe the reason in the notes field.');
      return;
    }

    const baseLabel = DELIVERY_FAILURE_REASONS.find((r) => r.value === selectedReason)?.label || selectedReason;
    const fullReason = notes.trim() ? `${baseLabel}: ${notes.trim()}` : baseLabel;

    setSubmitting(true);

    try {
      // 1. Try calling the enterprise RPC delivery_report_failed
      const { error: rpcError } = await supabase.rpc('delivery_report_failed', {
        p_order_id: orderId,
        p_reason: selectedReason,
        p_notes: notes.trim() || null,
      });

      if (rpcError) {
        // Fallback: direct table update if RPC unavailable
        const nowIso = new Date().toISOString();
        const { error: orderError } = await supabase
          .from('orders')
          .update({
            delivery_status: 'failed',
            status: 'delivery_failed',
            failed_reason: fullReason,
            failed_at: nowIso,
          })
          .eq('id', orderId);

        if (orderError) {
          throw new Error(orderError.message);
        }
      }

      // Stop location broadcasting
      await stopOrderTracking();

      // Trigger delivery_failed push notification to Admin
      void triggerNotification({
        order_id: orderId,
        event_type: 'delivery_failed',
        recipient_role: 'admin',
        data: {
          order_number: orderNumber,
          shop_name: shopName,
          failed_reason: fullReason,
        },
      });

      setSubmitting(false);
      onFailed(fullReason);
    } catch (err: unknown) {
      setSubmitting(false);
      const msg = err instanceof Error ? err.message : 'Failed to update order status';
      Alert.alert('Error', msg);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.headerTitle}>Could Not Deliver</Text>
              <Text style={styles.headerSubtitle}>
                Order #{orderNumber} · {shopName}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} disabled={submitting} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color="#64748B" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>Select Reason:</Text>

            {/* Radio List */}
            <View style={styles.radioList}>
              {DELIVERY_FAILURE_REASONS.map((item) => {
                const isSelected = selectedReason === item.value;
                return (
                  <TouchableOpacity
                    key={item.value}
                    style={[styles.radioRow, isSelected && styles.radioRowSelected]}
                    onPress={() => setSelectedReason(item.value)}
                    activeOpacity={0.8}
                    disabled={submitting}
                  >
                    <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                      {isSelected ? <View style={styles.radioInner} /> : null}
                    </View>
                    <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Additional Notes */}
            <View style={styles.notesSection}>
              <Text style={styles.notesLabel}>Additional notes (optional):</Text>
              <TextInput
                style={styles.notesInput}
                placeholder="Provide any details about the shop or situation"
                placeholderTextColor="#94A3B8"
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
                maxLength={200}
                editable={!submitting}
              />
            </View>

            {/* Action Buttons */}
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={handleClose}
                disabled={submitting}
                activeOpacity={0.8}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.submitBtnText}>Submit & Mark Failed</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    paddingBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#D32F2F',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  radioList: {
    gap: 8,
    marginBottom: 16,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  radioRowSelected: {
    backgroundColor: '#FFEBEE',
    borderColor: '#EF9A9A',
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCircleSelected: {
    borderColor: '#D32F2F',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#D32F2F',
  },
  radioLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    flex: 1,
  },
  radioLabelSelected: {
    color: '#B71C1C',
    fontWeight: '700',
  },
  notesSection: {
    marginBottom: 18,
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
  },
  notesInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
    minHeight: 70,
    textAlignVertical: 'top',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  submitBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D32F2F',
  },
  submitBtnDisabled: {
    backgroundColor: '#EF9A9A',
  },
  submitBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
