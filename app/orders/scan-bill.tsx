import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import {
  pickOrCaptureInvoiceImage,
  uploadInvoiceImage,
  triggerExtraction,
  subscribeToExtractionStatus,
  PickedImage,
} from '../../src/services/invoiceExtraction';
import type { ProcessingStatus } from '../../src/types/invoice';

import NetInfo from '@react-native-community/netinfo';

export default function ScanBillScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user } = useAuthStore();

  const [selectedImage, setSelectedImage] = useState<PickedImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);

  // --- ROLE GUARD: Admin & Delivery staff only ---
  useEffect(() => {
    if (!user) return;
    if (user.role !== 'admin' && user.role !== 'delivery') {
      Alert.alert(
        'Access Restricted',
        'Photo-to-Order (Bill OCR) is only available for Admin and Delivery staff.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)') }]
      );
    }
  }, [user]);

  const handlePickImage = async (source: 'camera' | 'library') => {
    try {
      setErrorMsg('');
      const picked = await pickOrCaptureInvoiceImage(source);
      if (picked) {
        setSelectedImage(picked);
        setProcessingStatus(null);
        setStatusMessage('');
      }
    } catch (err: any) {
      Alert.alert('Permission Error', err.message || 'Failed to access camera/library');
    }
  };

  const startExtraction = async () => {
    if (!selectedImage) {
      Alert.alert('No Image', 'Please capture or select a bill photo first');
      return;
    }

    if (!user?.id) {
      Alert.alert('Not Logged In', 'Please log in to scan bills');
      return;
    }

    // Offline Connectivity Guard (Handles throttled 3G cleanly)
    const netState = await NetInfo.fetch();
    const isOnline = netState.isConnected && (netState.isInternetReachable ?? true);
    if (!isOnline) {
      Alert.alert(
        'No Internet Connection',
        'Bill OCR photo extraction requires an active internet connection. Please check your network and try again.'
      );
      return;
    }

    setUploading(true);
    setErrorMsg('');
    setStatusMessage('Uploading bill photo to secure storage...');
    setProcessingStatus('uploaded');

    try {
      // 1. Upload photo to Supabase Storage & insert invoice_uploads row
      const id = await uploadInvoiceImage(selectedImage.uri, user.id, selectedImage.name);
      setUploadId(id);

      setStatusMessage('Analyzing bill content with Gemini AI...');

      // 2. Trigger extract-invoice Edge Function
      const result = await triggerExtraction(id);

      if (!result.success) {
        throw new Error(result.error || 'AI invoice extraction failed');
      }

      // 3. Subscribe to Realtime / Polling updates for upload status
      const unsubscribe = subscribeToExtractionStatus(id, (status, extraction) => {
        setProcessingStatus(status);

        if (status === 'extracted') {
          setUploading(false);
          setStatusMessage('Invoice extracted successfully!');
          unsubscribe();

          // Navigate to review screen
          setTimeout(() => {
            router.push({
              pathname: '/orders/review-invoice',
              params: { id },
            } as any);
          }, 600);
        } else if (status === 'failed') {
          setUploading(false);
          setErrorMsg('Failed to extract invoice data from photo. Please ensure bill is clear and legible.');
          unsubscribe();
        }
      });
    } catch (err: any) {
      setUploading(false);
      setProcessingStatus('failed');
      setErrorMsg(err.message || 'An error occurred while uploading/processing the bill');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Photo-to-Order (Bill OCR)' }} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Header Info */}
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Ionicons name="sparkles" size={24} color={colors.primary} />
            <Text style={styles.headerTitle}>Scan Wholesaler Bill</Text>
          </View>
          <Text style={styles.headerSub}>
            Take a clear photo of your wholesaler bill. Our AI will automatically extract items, quantities, rates, and match them to catalog products.
          </Text>
        </View>

        {/* Image Preview / Capture Area */}
        <View style={styles.imageCard}>
          {selectedImage ? (
            <View style={styles.previewContainer}>
              <Image source={{ uri: selectedImage.uri }} style={styles.previewImage} resizeMode="contain" />
              {!uploading && (
                <TouchableOpacity style={styles.removeImageBtn} onPress={() => setSelectedImage(null)}>
                  <Ionicons name="close-circle" size={26} color={colors.error} />
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={styles.placeholderContainer}>
              <Ionicons name="document-text-outline" size={64} color={colors.textMuted} />
              <Text style={styles.placeholderText}>No bill photo selected</Text>
              <Text style={styles.placeholderHint}>Capture or choose a clear bill image below</Text>
            </View>
          )}
        </View>

        {/* Action Buttons */}
        {!uploading && (
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.pickBtn} onPress={() => handlePickImage('camera')}>
              <Ionicons name="camera" size={20} color={colors.primary} />
              <Text style={styles.pickBtnText}>Camera</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.pickBtn} onPress={() => handlePickImage('library')}>
              <Ionicons name="images" size={20} color={colors.primary} />
              <Text style={styles.pickBtnText}>Gallery</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Status & Loader Card */}
        {uploading && (
          <View style={styles.statusCard}>
            <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: 12 }} />
            <Text style={styles.statusTitle}>{statusMessage}</Text>
            <Text style={styles.statusSub}>Please keep this screen open while processing...</Text>
          </View>
        )}

        {/* Error Card */}
        {errorMsg ? (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={22} color={colors.error} />
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {/* Start Extraction Button */}
        {selectedImage && !uploading && processingStatus !== 'extracted' && (
          <TouchableOpacity style={styles.extractBtn} onPress={startExtraction}>
            <Ionicons name="sparkles-outline" size={20} color="#fff" />
            <Text style={styles.extractBtnText}>Extract Order with AI</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, gap: 16 },
    card: { backgroundColor: c.surface, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: c.border },
    headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, marginBottom: 6 },
    headerTitle: { fontSize: 18, fontWeight: '700' as const, color: c.text },
    headerSub: { fontSize: 13, color: c.textSecondary, lineHeight: 18 },
    imageCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      height: 320,
      overflow: 'hidden' as const,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
    previewContainer: { width: '100%', height: '100%', position: 'relative' as const },
    previewImage: { width: '100%', height: '100%' },
    removeImageBtn: { position: 'absolute' as const, top: 12, right: 12, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 16 },
    placeholderContainer: { alignItems: 'center' as const, justifyContent: 'center' as const, padding: 20 },
    placeholderText: { fontSize: 16, fontWeight: '600' as const, color: c.text, marginTop: 12 },
    placeholderHint: { fontSize: 12, color: c.textMuted, marginTop: 4, textAlign: 'center' as const },
    btnRow: { flexDirection: 'row' as const, gap: 12 },
    pickBtn: {
      flex: 1,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      backgroundColor: c.surface,
      paddingVertical: 14,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: c.primary,
    },
    pickBtnText: { fontSize: 15, fontWeight: '600' as const, color: c.primary },
    statusCard: {
      backgroundColor: c.surface,
      padding: 20,
      borderRadius: 12,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.primary,
    },
    statusTitle: { fontSize: 15, fontWeight: '700' as const, color: c.text, textAlign: 'center' as const },
    statusSub: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    errorCard: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      backgroundColor: isDark ? '#3B1515' : '#FEE2E2',
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.error,
    },
    errorText: { flex: 1, fontSize: 13, color: c.error, fontWeight: '500' as const },
    extractBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 10,
      backgroundColor: c.primary,
      height: 52,
      borderRadius: 12,
      marginTop: 8,
    },
    extractBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' as const },
  } as const;
}
