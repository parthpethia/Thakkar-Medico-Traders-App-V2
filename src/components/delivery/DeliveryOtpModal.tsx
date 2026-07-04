import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
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

/* ================= HELPERS ================= */

async function callSendDeliveryOtp(orderId: string): Promise<{
  sent: boolean;
  channel?: string;
  reason?: string;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { sent: false, error: 'Not authenticated' };
  }

  const baseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const response = await fetch(`${baseUrl}/functions/v1/send-delivery-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });

  try {
    return await response.json();
  } catch {
    return { sent: false, error: 'Invalid response from server' };
  }
}

function parseOtpRpcError(message: string): string | null {
  if (message.includes('otp_invalid')) return 'otp_invalid';
  if (message.includes('otp_expired')) return 'otp_expired';
  if (message.includes('otp_max_attempts')) return 'otp_max_attempts';
  if (message.includes('otp_too_soon')) return 'otp_too_soon';
  return null;
}

async function uploadDeliveryPhoto(
  orderId: string,
  uri: string,
): Promise<string | null> {
  try {
    const timestamp = Date.now();
    const fileExt = uri.split('.').pop() ?? 'jpg';
    const filePath = `${orderId}/${timestamp}.${fileExt}`;

    // Read the image file
    const response = await fetch(uri);
    const blob = await response.blob();

    // Convert blob to ArrayBuffer for upload
    const arrayBuffer = await new Response(blob).arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from('delivery-photos')
      .upload(filePath, arrayBuffer, {
        contentType: `image/${fileExt}`,
        upsert: false,
      });

    if (uploadError) {
      console.error('Photo upload error:', uploadError);
      return null;
    }

    // Get the public URL
    const { data: urlData } = supabase.storage
      .from('delivery-photos')
      .getPublicUrl(filePath);

    const photoUrl = urlData?.publicUrl ?? null;

    // Save photo URL to delivery_proofs
    if (photoUrl) {
      await supabase
        .from('delivery_proofs')
        .update({
          photo_url: photoUrl,
          photo_uploaded_at: new Date().toISOString(),
        })
        .eq('order_id', orderId);
    }

    return photoUrl;
  } catch (err) {
    console.error('Photo upload failed:', err);
    return null;
  }
}

/* ================= OTP MODAL ================= */

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
  const [digits, setDigits] = useState(['', '', '', '']);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [locked, setLocked] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);
  const lastSendOrderId = useRef<string | null>(null);

  // Photo state
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);

  const resetForm = useCallback(() => {
    setDigits(['', '', '', '']);
    setSendStatus(null);
    setSendWarning(null);
    setVerifyError(null);
    setLocked(false);
    setPhotoUri(null);
    setUploadingPhoto(false);
    setPhotoUploaded(false);
  }, []);

  const sendOtp = useCallback(async (isResend: boolean) => {
    if (!order) return;
    setSending(true);
    setVerifyError(null);
    try {
      const result = await callSendDeliveryOtp(order.id);
      if (result.reason === 'no_push_token') {
        setSendWarning(
          'Retailer has not enabled notifications. Show them the app or contact them directly.',
        );
        if (!isResend) {
          setSendStatus("OTP generated. Ask the retailer to open the app or check notifications.");
        }
      } else if (result.reason === 'otp_too_soon') {
        setVerifyError('OTP was just sent. Wait 2 minutes before resending.');
      } else if (result.sent) {
        setSendWarning(null);
        const via =
          result.channel === 'sms'
            ? 'SMS sent to retailer phone.'
            : "OTP sent to retailer's app. Ask them to check their phone.";
        setSendStatus(isResend ? `OTP resent. ${via}` : via);
      } else {
        setVerifyError(result.error || 'Could not send OTP. Try again or contact admin.');
      }
    } catch {
      setVerifyError('Could not send OTP. Check your connection.');
    } finally {
      setSending(false);
    }
  }, [order]);

  useEffect(() => {
    if (!visible || !order) {
      resetForm();
      lastSendOrderId.current = null;
      return;
    }
    if (lastSendOrderId.current === order.id) return;
    lastSendOrderId.current = order.id;
    resetForm();
    void sendOtp(false);
  }, [visible, order, resetForm, sendOtp]);

  const otpValue = digits.join('');

  const handleDigitChange = (index: number, value: string) => {
    if (locked) return;
    const d = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = d;
    setDigits(next);
    setVerifyError(null);
    if (d && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (index: number, key: string) => {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const fetchAttemptsRemaining = async (): Promise<number | null> => {
    if (!order) return null;
    const { data } = await supabase
      .from('delivery_proofs')
      .select('otp_attempts')
      .eq('order_id', order.id)
      .maybeSingle();
    if (!data) return null;
    return Math.max(0, 5 - (data.otp_attempts ?? 0));
  };

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
      showToast('Photo upload failed — you can still verify OTP');
    }
  }, [order, showToast]);

  /* ---------- OTP verification ---------- */
  const confirmDelivery = async () => {
    if (!order || locked || otpValue.length !== 4) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const { error } = await supabase.rpc('verify_delivery_otp', {
        p_order_id: order.id,
        p_otp: otpValue,
      });

      if (error) {
        const code = parseOtpRpcError(error.message || '');
        if (code === 'otp_invalid') {
          const remaining = await fetchAttemptsRemaining();
          if (remaining !== null && remaining <= 0) {
            setLocked(true);
            setVerifyError('Too many wrong attempts. Contact admin.');
          } else {
            setVerifyError(
              `Incorrect OTP. ${remaining ?? 4} attempts remaining.`,
            );
          }
        } else if (code === 'otp_expired') {
          setVerifyError('OTP has expired. Tap Resend to send a new one.');
        } else if (code === 'otp_max_attempts') {
          setLocked(true);
          setVerifyError('Too many wrong attempts. Contact admin.');
        } else {
          setVerifyError(error.message || 'Verification failed');
        }
        return;
      }

      onClose();
      onSuccess();
      showToast('Delivery confirmed');
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
            <Text style={styles.modalTitle}>Enter delivery OTP</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.modalSubtext}>
            Ask the retailer for the code sent to their app
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
                  <TouchableOpacity onPress={handleTakePhoto}>
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

          {sendStatus ? <Text style={styles.sendStatusText}>{sendStatus}</Text> : null}
          {sendWarning ? <Text style={styles.sendWarningText}>{sendWarning}</Text> : null}
          {sending ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 8 }} />
          ) : null}

          <View style={styles.otpRow}>
            {digits.map((digit, i) => (
              <TextInput
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                style={[styles.otpBox, locked && styles.otpBoxDisabled]}
                value={digit}
                onChangeText={(v) => handleDigitChange(i, v)}
                onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
                keyboardType="number-pad"
                maxLength={1}
                editable={!locked && !verifying}
                selectTextOnFocus
              />
            ))}
          </View>

          {verifyError ? <Text style={styles.verifyErrorText}>{verifyError}</Text> : null}

          <TouchableOpacity
            style={[
              styles.confirmOtpBtn,
              (otpValue.length !== 4 || verifying || locked) && styles.confirmOtpBtnDisabled,
            ]}
            onPress={confirmDelivery}
            disabled={otpValue.length !== 4 || verifying || locked}
          >
            {verifying ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <Text style={styles.actionBtnText}>
                {isPickup ? 'Confirm collection' : 'Confirm delivery'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.resendLink}
            onPress={() => sendOtp(true)}
            disabled={sending || locked}
          >
            <Text style={styles.resendLinkText}>Resend OTP</Text>
          </TouchableOpacity>

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
