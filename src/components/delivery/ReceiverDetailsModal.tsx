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
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order } from '../../types';

type ReceiverDetailsModalProps = {
  visible: boolean;
  order: Order | null;
  onClose: () => void;
  onSuccess: (receiverName: string, receiverPhone: string) => void;
  showToast: (msg: string) => void;
};

export function ReceiverDetailsModal({
  visible,
  order,
  onClose,
  onSuccess,
  showToast,
}: ReceiverDetailsModalProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setReceiverName('');
    setReceiverPhone('');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!order) return;
    if (!receiverName.trim()) {
      setError('Receiver name is required for enterprise handovers.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // 1. Capture current location
      let gpsLat: number | null = null;
      let gpsLng: number | null = null;
      let gpsAccuracy: number | null = null;

      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          gpsLat = loc.coords.latitude;
          gpsLng = loc.coords.longitude;
          gpsAccuracy = loc.coords.accuracy;
        }
      } catch (locErr) {
        console.warn('GPS capture failed during POD creation:', locErr);
      }

      // 2. Insert or update delivery_proofs
      const { data: existingProof } = await supabase
        .from('delivery_proofs')
        .select('id')
        .eq('order_id', order.id)
        .maybeSingle();

      if (existingProof) {
        const { error: updateError } = await supabase
          .from('delivery_proofs')
          .update({
            receiver_name: receiverName.trim(),
            receiver_phone: receiverPhone.trim() || null,
            gps_lat: gpsLat,
            gps_lng: gpsLng,
            gps_accuracy_m: gpsAccuracy,
            delivered_at_gps: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', order.id);

        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from('delivery_proofs')
          .insert({
            order_id: order.id,
            receiver_name: receiverName.trim(),
            receiver_phone: receiverPhone.trim() || null,
            gps_lat: gpsLat,
            gps_lng: gpsLng,
            gps_accuracy_m: gpsAccuracy,
            delivered_at_gps: new Date().toISOString(),
            // Set dummy hash values to keep compatibility with early migrations
            otp_code_hash: 'enterprise_pod_no_otp',
            otp_expires_at: new Date(Date.now() + 3600000).toISOString(),
          });

        if (insertError) throw insertError;
      }

      handleClose();
      onSuccess(receiverName.trim(), receiverPhone.trim());
      showToast('Receiver details recorded');
    } catch (err: any) {
      setError(err?.message || 'Failed to record details.');
    } finally {
      setSaving(false);
    }
  }, [order, receiverName, receiverPhone, handleClose, onSuccess, showToast]);

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Receiver Details (POD)</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Enter the details of the person receiving the pharmaceutical items.
          </Text>

          {/* Receiver Name */}
          <Text style={styles.sectionLabel}>Receiver Name *</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Shop Manager, Dr. Thakkar, Staff"
            placeholderTextColor={colors.textMuted}
            value={receiverName}
            onChangeText={(val) => {
              setReceiverName(val);
              setError(null);
            }}
          />

          {/* Receiver Phone */}
          <Text style={styles.sectionLabel}>Receiver Phone Number (Optional)</Text>
          <TextInput
            style={styles.input}
            keyboardType="phone-pad"
            placeholder="e.g. +91 9876543210"
            placeholderTextColor={colors.textMuted}
            value={receiverPhone}
            onChangeText={(val) => {
              setReceiverPhone(val);
              setError(null);
            }}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submitBtn, saving && styles.submitDisabled]}
            onPress={handleSubmit}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <Text style={styles.submitBtnText}>Save Receiver & GPS Proof</Text>
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
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 10,
    },
    submitDisabled: { opacity: 0.5 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  } as const;
}
