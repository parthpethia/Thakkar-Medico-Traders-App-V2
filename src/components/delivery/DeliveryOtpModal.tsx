import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';
import { Order } from '../../types';
import { SwipeButton } from './SwipeButton';
import { uploadDeliveryPhoto } from '../../utils/deliveryPhoto';

/* ================= HELPERS ================= */


/* ================= CONFIRMATION MODAL ================= */

type DeliveryOtpModalProps = {
  visible: boolean;
  order: Order | null;
  isPickup: boolean;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
  /** Called when driver taps "Can't Deliver" — parent should open DeliveryFailedModal */
  onCantDeliver?: () => void;
  /** Called when driver taps "Report Issue" — parent should open ReportReturnModal */
  onReportIssue?: () => void;
};

export function DeliveryOtpModal({
  visible,
  order,
  isPickup,
  onClose,
  onSuccess,
  showToast,
  onCantDeliver,
  onReportIssue,
}: DeliveryOtpModalProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Photo state
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);

  const resetForm = useCallback(() => {
    setVerifyError(null);
    setPhotoUri(null);
    setUploadingPhoto(false);
    setPhotoUploaded(false);
  }, []);

  // Reset form when modal visibility changes
  React.useEffect(() => {
    if (visible) {
      resetForm();
    }
  }, [visible, resetForm]);

  /* ---------- Photo capture ---------- */
  const handleTakePhoto = useCallback(async () => {
    if (!order) return;

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      showToast('Camera permission is required to take a photo');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.6,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    const uri = result.assets[0].uri;
    setPhotoUri(uri);
    setUploadingPhoto(true);

    const uploadedUrl = await uploadDeliveryPhoto(order.id, uri);
    setUploadingPhoto(false);

    if (uploadedUrl) {
      setPhotoUploaded(true);
    } else {
      showToast('Photo upload failed — you can still complete delivery');
    }
  }, [order, showToast]);

  /* ---------- Confirm delivery/collection ---------- */
  const confirmDelivery = async () => {
    if (!order || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const { error } = await supabase
        .from('orders')
        .update({ status: 'delivered' })
        .eq('id', order.id);

      if (error) {
        setVerifyError(error.message || 'Failed to update order status');
        return;
      }

      onClose();
      onSuccess();
      showToast(isPickup ? 'Collection confirmed' : 'Delivery confirmed');
    } catch (err: any) {
      setVerifyError(err?.message || 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {isPickup ? 'Confirm Collection' : 'Confirm Delivery'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.modalSubtext}>
            {isPickup
              ? 'Swipe below to confirm items have been collected by the customer.'
              : 'Swipe below to confirm successful delivery.'}
          </Text>

          {/* ---------- Photo capture (optional) ---------- */}
          <View style={styles.photoSection}>
            {photoUri ? (
              <View style={styles.photoPreviewRow}>
                <Image source={{ uri: photoUri }} style={styles.photoThumbnail} />
                <View style={styles.photoStatusCol}>
                  {uploadingPhoto ? (
                    <View style={styles.photoStatusRow}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={styles.photoStatusText}>Uploading...</Text>
                    </View>
                  ) : photoUploaded ? (
                    <View style={styles.photoStatusRow}>
                      <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                      <Text style={[styles.photoStatusText, { color: colors.success }]}>
                        Photo uploaded
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.photoStatusText, { color: colors.warning }]}>
                      Upload failed
                    </Text>
                  )}
                  <TouchableOpacity onPress={handleTakePhoto} disabled={uploadingPhoto}>
                    <Text style={styles.retakeText}>Retake</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.takePhotoBtn} onPress={handleTakePhoto}>
                <Ionicons name="camera-outline" size={20} color={colors.primary} />
                <Text style={styles.takePhotoBtnText}>Take delivery photo (optional)</Text>
              </TouchableOpacity>
            )}
          </View>

          {verifyError ? <Text style={styles.verifyErrorText}>{verifyError}</Text> : null}

          {verifying ? (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : (
            <View style={{ marginTop: 8 }}>
              <SwipeButton
                title={isPickup ? 'Swipe to Collect' : 'Swipe to Deliver'}
                colors={colors}
                onSwipeSuccess={confirmDelivery}
                disabled={uploadingPhoto}
              />
            </View>
          )}

          {/* ---------- Secondary actions ---------- */}
          <View style={styles.secondaryActions}>
            {onReportIssue && (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => {
                  onClose();
                  onReportIssue();
                }}
              >
                <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
                <Text style={[styles.secondaryBtnText, { color: colors.warning }]}>
                  Report item issue
                </Text>
              </TouchableOpacity>
            )}
            {onCantDeliver && (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => {
                  onClose();
                  onCantDeliver();
                }}
              >
                <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                <Text style={[styles.secondaryBtnText, { color: colors.error }]}>
                  Can't deliver
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return {
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    modalSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 20,
      paddingBottom: 32,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    modalTitle: { fontSize: 18, fontWeight: '700', color: c.text },
    modalSubtext: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    /* Photo section */
    photoSection: { marginBottom: 12 },
    takePhotoBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: c.primary,
      borderRadius: 10,
      borderStyle: 'dashed',
    },
    takePhotoBtnText: { fontSize: 14, color: c.primary, fontWeight: '500' },
    photoPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    photoThumbnail: {
      width: 56,
      height: 56,
      borderRadius: 8,
      backgroundColor: c.background,
    },
    photoStatusCol: { flex: 1, gap: 4 },
    photoStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    photoStatusText: { fontSize: 13, color: c.textSecondary },
    retakeText: { fontSize: 13, color: c.primary, fontWeight: '600' },
    /* OTP section */
    sendStatusText: { fontSize: 13, color: c.success, marginBottom: 8 },
    sendWarningText: { fontSize: 13, color: c.warning, marginBottom: 8, lineHeight: 18 },
    otpRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 10,
      marginVertical: 16,
    },
    otpBox: {
      width: 52,
      height: 56,
      borderWidth: 2,
      borderColor: c.primary,
      borderRadius: 10,
      textAlign: 'center',
      fontSize: 22,
      fontWeight: '700',
      color: c.text,
    },
    otpBoxDisabled: {
      borderColor: c.switchThumbOff,
      backgroundColor: c.background,
      color: c.textMuted,
    },
    verifyErrorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
    confirmOtpBtn: {
      backgroundColor: c.success,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 8,
    },
    confirmOtpBtnDisabled: { opacity: 0.5 },
    resendLink: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
    resendLinkText: { color: c.primary, fontSize: 14, fontWeight: '600' },
    actionBtnText: { color: c.surface, fontWeight: '700' },
    /* Secondary actions */
    secondaryActions: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 24,
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    secondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 6,
    },
    secondaryBtnText: { fontSize: 14, fontWeight: '600' },
  } as const;
}
