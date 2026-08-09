/**
 * ProofOfDeliverySheet — Bottom sheet for rider proof of delivery capture.
 *
 * Flow:
 * 1. Rider selects Take Photo (camera) or Choose from Gallery.
 * 2. Preview thumbnail displayed with optional note text input.
 * 3. On Confirm Delivery:
 *    - Uploads photo to Supabase Storage: delivery-proofs/{orderId}/{riderId}.jpg (upsert: true)
 *    - Obtains public URL & inserts row into delivery_proofs with GPS coordinates.
 *    - Updates orders table (delivery_status='delivered', status='delivered', delivered_at=now()).
 *    - Stops location broadcasting and triggers success state.
 * 4. Error fallback:
 *    - If upload fails, shows Retry button and "Skip photo, mark delivered anyway" option.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  Image,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../services/supabase';
import { stopOrderTracking } from '../../services/riderLocationService';
import { uploadDeliveryPhoto } from '../../utils/deliveryPhoto';

export interface ProofOfDeliverySheetProps {
  visible: boolean;
  orderId: string;
  orderNumber: string;
  shopName: string;
  riderId: string;
  riderLat?: number | null;
  riderLng?: number | null;
  onClose: () => void;
  onSuccess: (photoUrl: string | null) => void;
}

export function ProofOfDeliverySheet({
  visible,
  orderId,
  orderNumber,
  shopName,
  riderId,
  riderLat,
  riderLng,
  onClose,
  onSuccess,
}: ProofOfDeliverySheetProps) {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Reset state on close
  const handleClose = () => {
    if (uploading) return;
    setPhotoUri(null);
    setNotes('');
    setUploadError(null);
    onClose();
  };

  // 1. Pick from Camera
  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Camera permission is required to capture delivery photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsEditing: false,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setPhotoUri(result.assets[0].uri);
        setUploadError(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not launch camera';
      Alert.alert('Camera Error', msg);
    }
  };

  // 2. Pick from Gallery
  const handlePickFromGallery = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Gallery permission is required to select delivery photo.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsEditing: false,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setPhotoUri(result.assets[0].uri);
        setUploadError(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not launch photo library';
      Alert.alert('Gallery Error', msg);
    }
  };

  // 3. Confirm Delivery with Photo Upload
  const handleConfirmDelivery = async () => {
    if (!photoUri) {
      Alert.alert('Photo Required', 'Please take or select a delivery photo, or use skip option.');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      // Step A: Upload photo using uploadDeliveryPhoto utility to 'delivery-photos' bucket
      const uploadedUrl = await uploadDeliveryPhoto(orderId, photoUri);

      if (!uploadedUrl) {
        throw new Error('Storage photo upload failed. Please retry or skip photo.');
      }

      // Step B: Insert / update delivery_proofs with GPS coordinates and notes
      const { error: dbProofError } = await supabase.from('delivery_proofs').upsert(
        {
          order_id: orderId,
          rider_id: riderId,
          photo_url: uploadedUrl,
          captured_lat: riderLat ?? null,
          captured_lng: riderLng ?? null,
          captured_at: new Date().toISOString(),
          notes: notes.trim() || null,
        },
        { onConflict: 'order_id' },
      );

      if (dbProofError) {
        console.warn('[ProofOfDelivery] delivery_proofs insert warning:', dbProofError);
      }

      // Step C: Update order status to delivered
      const nowIso = new Date().toISOString();
      const { error: orderError } = await supabase
        .from('orders')
        .update({
          delivery_status: 'delivered',
          status: 'delivered',
          delivered_at: nowIso,
        })
        .eq('id', orderId);

      if (orderError) {
        throw new Error(`Failed to update order status: ${orderError.message}`);
      }

      // Step D: Stop location broadcasting
      await stopOrderTracking();

      setUploading(false);
      onSuccess(uploadedUrl);
    } catch (err: unknown) {
      setUploading(false);
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
    }
  };

  // 4. Skip Photo Fallback
  const handleSkipPhotoDelivery = async () => {
    Alert.alert(
      'Skip Photo Proof?',
      'Are you sure you want to mark this order as delivered without a proof photo?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Mark Delivered',
          style: 'destructive',
          onPress: async () => {
            setUploading(true);
            try {
              const nowIso = new Date().toISOString();
              const { error: orderError } = await supabase
                .from('orders')
                .update({
                  delivery_status: 'delivered',
                  status: 'delivered',
                  delivered_at: nowIso,
                })
                .eq('id', orderId);

              if (orderError) {
                throw new Error(orderError.message);
              }

              await stopOrderTracking();
              setUploading(false);
              onSuccess(null);
            } catch (err: unknown) {
              setUploading(false);
              const msg = err instanceof Error ? err.message : 'Failed to deliver order';
              Alert.alert('Error', msg);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.headerTitle}>Mark as Delivered</Text>
              <Text style={styles.headerSubtitle}>
                Order #{orderNumber} · {shopName}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} disabled={uploading} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color="#64748B" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/* Step 1: Prompt when no photo selected yet */}
            {!photoUri ? (
              <View style={styles.promptCard}>
                <View style={styles.cameraIconCircle}>
                  <Ionicons name="camera" size={36} color="#1565C0" />
                </View>
                <Text style={styles.promptTitle}>Take a delivery photo</Text>
                <Text style={styles.promptDesc}>
                  Capture a photo of the delivered package with the shop or receiver for proof.
                </Text>

                <View style={styles.pickerButtonsRow}>
                  <TouchableOpacity
                    style={styles.cameraBtn}
                    onPress={handleTakePhoto}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="camera-outline" size={18} color="#FFFFFF" />
                    <Text style={styles.cameraBtnText}>Take Photo</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.galleryBtn}
                    onPress={handlePickFromGallery}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="images-outline" size={18} color="#1565C0" />
                    <Text style={styles.galleryBtnText}>Choose from Gallery</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              /* Step 2: Photo preview & note field */
              <View style={styles.previewContainer}>
                <View style={styles.previewFrame}>
                  <Image source={{ uri: photoUri }} style={styles.previewImage} resizeMode="cover" />
                  <TouchableOpacity
                    style={styles.retakeFloatingBtn}
                    onPress={handleTakePhoto}
                    disabled={uploading}
                  >
                    <Ionicons name="camera-reverse" size={16} color="#FFFFFF" />
                    <Text style={styles.retakeFloatingText}>Retake</Text>
                  </TouchableOpacity>
                </View>

                {/* Notes Input */}
                <View style={styles.notesSection}>
                  <Text style={styles.notesLabel}>Note (optional)</Text>
                  <TextInput
                    style={styles.notesInput}
                    placeholder="e.g. Handed over to shop manager Ramesh"
                    placeholderTextColor="#94A3B8"
                    value={notes}
                    onChangeText={setNotes}
                    maxLength={150}
                    editable={!uploading}
                  />
                </View>

                {/* Upload Error Banner */}
                {uploadError ? (
                  <View style={styles.errorBanner}>
                    <Ionicons name="alert-circle" size={18} color="#D32F2F" />
                    <Text style={styles.errorBannerText}>{uploadError}</Text>
                  </View>
                ) : null}

                {/* Confirm Delivery Button */}
                <TouchableOpacity
                  style={[styles.confirmBtn, uploading && styles.confirmBtnDisabled]}
                  onPress={handleConfirmDelivery}
                  disabled={uploading}
                  activeOpacity={0.88}
                >
                  {uploading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator size="small" color="#FFFFFF" />
                      <Text style={styles.confirmBtnText}>Uploading delivery proof…</Text>
                    </View>
                  ) : (
                    <View style={styles.loadingRow}>
                      <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
                      <Text style={styles.confirmBtnText}>Confirm Delivery</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Step 3: Skip photo option */}
            {!uploading && (
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={handleSkipPhotoDelivery}
                activeOpacity={0.7}
              >
                <Text style={styles.skipBtnText}>Skip photo, mark delivered anyway</Text>
              </TouchableOpacity>
            )}
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
    color: '#0F172A',
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
  promptCard: {
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 16,
  },
  cameraIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#E3F2FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  promptTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: 6,
  },
  promptDesc: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
    paddingHorizontal: 12,
  },
  pickerButtonsRow: {
    width: '100%',
    gap: 10,
  },
  cameraBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 13,
    borderRadius: 12,
    gap: 8,
  },
  cameraBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  galleryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EEF2FF',
    paddingVertical: 13,
    borderRadius: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  galleryBtnText: {
    color: '#1565C0',
    fontSize: 14,
    fontWeight: '700',
  },
  previewContainer: {
    marginBottom: 16,
  },
  previewFrame: {
    position: 'relative',
    width: '100%',
    height: 220,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#0F172A',
    marginBottom: 14,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  retakeFloatingBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  retakeFloatingText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  notesSection: {
    marginBottom: 14,
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
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFEBEE',
    borderWidth: 1,
    borderColor: '#FFCDD2',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    gap: 8,
  },
  errorBannerText: {
    color: '#D32F2F',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  confirmBtn: {
    backgroundColor: '#2E7D32',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  confirmBtnDisabled: {
    backgroundColor: '#81C784',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  skipBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  skipBtnText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
