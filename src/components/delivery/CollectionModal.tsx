import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order, CollectionMethod, COLLECTION_METHOD_LABELS } from '../../types';

type CollectionModalProps = {
  visible: boolean;
  order: Order | null;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

export function CollectionModal({
  visible,
  order,
  onClose,
  onSuccess,
  showToast,
}: CollectionModalProps) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [method, setMethod] = useState<CollectionMethod>('cash');
  const [amount, setAmount] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill amount when order changes
  useEffect(() => {
    if (order) {
      setAmount((order.grand_total || 0).toString());
      // Map payment mode to collection method if matches
      const orderMode = (order.payment_mode || '').toLowerCase() as CollectionMethod;
      if (['cash', 'upi', 'cheque', 'credit', 'neft', 'prepaid'].includes(orderMode)) {
        setMethod(orderMode);
      } else {
        setMethod('cash');
      }
    }
  }, [order]);

  const resetForm = useCallback(() => {
    setMethod('cash');
    setAmount('');
    setReferenceNo('');
    setBankName('');
    setNotes('');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!order) return;
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) {
      setError('Please enter a valid amount.');
      return;
    }

    if (['upi', 'cheque', 'neft'].includes(method) && !referenceNo.trim()) {
      setError(`Reference number/Transaction ID is required for ${method.toUpperCase()}.`);
      return;
    }

    if (method === 'cheque' && !bankName.trim()) {
      setError('Bank name is required for cheque payments.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const { error: rpcError } = await supabase.rpc('record_delivery_collection', {
        p_order_id: order.id,
        p_method: method,
        p_amount: parsedAmount,
        p_reference_no: referenceNo.trim() || null,
        p_bank_name: bankName.trim() || null,
        p_notes: notes.trim() || null,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to record payment collection');
        return;
      }

      handleClose();
      onSuccess();
      showToast('Payment collection recorded');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }, [order, method, amount, referenceNo, bankName, notes, handleClose, onSuccess, showToast]);

  if (!order) return null;

  const methods: CollectionMethod[] = ['cash', 'upi', 'cheque', 'credit', 'neft', 'prepaid'];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Payment Collection</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Order #{order.order_number} · Total: ₹{order.grand_total.toFixed(2)}
          </Text>

          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            {/* Method Select */}
            <Text style={styles.sectionLabel}>Collection Method</Text>
            <View style={styles.methodGrid}>
              {methods.map((m) => {
                const isSelected = method === m;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.methodCard, isSelected && styles.methodCardActive]}
                    onPress={() => {
                      setMethod(m);
                      setError(null);
                    }}
                  >
                    <Ionicons
                      name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={18}
                      color={isSelected ? colors.onPrimary : colors.textSecondary}
                    />
                    <Text style={[styles.methodText, isSelected && styles.methodTextActive]}>
                      {COLLECTION_METHOD_LABELS[m]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Amount input */}
            <Text style={styles.sectionLabel}>Collected Amount (₹)</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.textMuted}
              value={amount}
              onChangeText={(val) => {
                setAmount(val);
                setError(null);
              }}
            />

            {/* Reference No for UPI/Cheque/NEFT */}
            {['upi', 'cheque', 'neft'].includes(method) && (
              <>
                <Text style={styles.sectionLabel}>
                  {method === 'upi' ? 'UPI Transaction ID' : method === 'cheque' ? 'Cheque Number' : 'Reference / UTR Number'}
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter reference number"
                  placeholderTextColor={colors.textMuted}
                  value={referenceNo}
                  onChangeText={(val) => {
                    setReferenceNo(val);
                    setError(null);
                  }}
                />
              </>
            )}

            {/* Bank name for Cheque */}
            {method === 'cheque' && (
              <>
                <Text style={styles.sectionLabel}>Bank Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter Bank Name (e.g. HDFC, SBI)"
                  placeholderTextColor={colors.textMuted}
                  value={bankName}
                  onChangeText={(val) => {
                    setBankName(val);
                    setError(null);
                  }}
                />
              </>
            )}

            {/* Notes */}
            <Text style={styles.sectionLabel}>Internal Notes (Optional)</Text>
            <TextInput
              style={[styles.input, { minHeight: 60, textAlignVertical: 'top' }]}
              placeholder="e.g. Cheque dated 20/07, partial collection"
              placeholderTextColor={colors.textMuted}
              value={notes}
              onChangeText={setNotes}
              multiline
            />
          </ScrollView>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submitBtn, submitting && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <Text style={styles.submitBtnText}>Record Payment Collection</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return {
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 6,
    },
    title: { fontSize: 18, fontWeight: '800', color: c.text },
    subtitle: { fontSize: 13, color: c.textSecondary, marginBottom: 18 },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '800',
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 6,
      marginTop: 10,
    },
    methodGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 10,
    },
    methodCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.background,
      minWidth: '31%',
    },
    methodCardActive: {
      borderColor: c.primary,
      backgroundColor: c.primary,
    },
    methodText: { fontSize: 12, fontWeight: '700', color: c.text },
    methodTextActive: { color: c.onPrimary },
    input: {
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: 8,
      padding: 12,
      fontSize: 14,
      color: c.text,
      backgroundColor: c.background,
      marginBottom: 10,
    },
    errorText: { fontSize: 13, color: c.error, textAlign: 'center', marginVertical: 8, fontWeight: '600' },
    submitBtn: {
      backgroundColor: c.success,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 10,
    },
    submitDisabled: { opacity: 0.5 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  } as const;
}
