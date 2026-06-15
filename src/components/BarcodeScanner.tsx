// P6: BarcodeScanner component — full-screen camera with scanning overlay
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Linking,
  Modal,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

interface BarcodeScannerProps {
  visible: boolean;
  onScan: (code: string) => void;
  onClose: () => void;
  hint?: string;
}

const FRAME_SIZE = 260;

export function BarcodeScanner({ visible, onScan, onClose, hint }: BarcodeScannerProps) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [torchOn, setTorchOn] = useState(false);
  const [scanned, setScanned] = useState(false);
  const flashAnim = useRef(new Animated.Value(0)).current;
  const cornerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setScanned(false);
      setTorchOn(false);
      // Animate corner brackets
      Animated.loop(
        Animated.sequence([
          Animated.timing(cornerAnim, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          }),
          Animated.timing(cornerAnim, {
            toValue: 0,
            duration: 1500,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    }
  }, [visible]);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned || !data) return;
    setScanned(true);

    // Success flash
    Animated.sequence([
      Animated.timing(flashAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(flashAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-close after 300ms
    setTimeout(() => {
      onScan(data);
      onClose();
    }, 300);
  };

  const cornerOpacity = cornerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1],
  });

  if (!visible) return null;

  // Permission not yet determined
  if (!permission) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.container}>
          <View style={styles.center}>
            <Text style={styles.permText}>{t('common.loading')}</Text>
          </View>
        </View>
      </Modal>
    );
  }

  // Permission denied
  if (!permission.granted) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.container}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <View style={styles.center}>
            <Ionicons name="camera-outline" size={64} color="#888" />
            <Text style={styles.permTitle}>{t('scanner.permissionTitle')}</Text>
            <Text style={styles.permText}>{t('scanner.permissionMessage')}</Text>
            <TouchableOpacity style={styles.settingsBtn} onPress={() => Linking.openSettings()}>
              <Text style={styles.settingsBtnText}>{t('scanner.openSettings')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.settingsBtn, { backgroundColor: '#555', marginTop: 10 }]}
              onPress={requestPermission}
            >
              <Text style={styles.settingsBtnText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={{
            barcodeTypes: [
              'ean13',
              'ean8',
              'upc_a',
              'upc_e',
              'code128',
              'code39',
              'code93',
              'itf14',
              'qr',
            ],
          }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />

        {/* Overlay */}
        <View style={styles.overlay}>
          {/* Top */}
          <View style={styles.overlaySection} />

          {/* Middle with frame */}
          <View style={styles.middleRow}>
            <View style={styles.overlaySection} />
            <View style={styles.scanFrame}>
              {/* Animated corner brackets */}
              <Animated.View style={[styles.corner, styles.topLeft, { opacity: cornerOpacity }]} />
              <Animated.View style={[styles.corner, styles.topRight, { opacity: cornerOpacity }]} />
              <Animated.View style={[styles.corner, styles.bottomLeft, { opacity: cornerOpacity }]} />
              <Animated.View style={[styles.corner, styles.bottomRight, { opacity: cornerOpacity }]} />
            </View>
            <View style={styles.overlaySection} />
          </View>

          {/* Bottom */}
          <View style={styles.overlaySection}>
            <Text style={styles.hintText}>
              {hint || t('scanner.hint')}
            </Text>
          </View>
        </View>

        {/* Success flash */}
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            styles.flash,
            { opacity: flashAnim },
          ]}
          pointerEvents="none"
        />

        {/* Close button */}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>

        {/* Torch toggle */}
        <TouchableOpacity
          style={styles.torchBtn}
          onPress={() => setTorchOn((prev) => !prev)}
        >
          <Ionicons
            name={torchOn ? 'flashlight' : 'flashlight-outline'}
            size={24}
            color="#fff"
          />
          <Text style={styles.torchText}>{t('scanner.torch')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const CORNER_LEN = 30;
const CORNER_WIDTH = 4;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlaySection: {
    flex: 1,
    width: '100%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  middleRow: {
    flexDirection: 'row',
    height: FRAME_SIZE,
  },
  scanFrame: {
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: CORNER_LEN,
    height: CORNER_LEN,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: '#fff',
    borderTopLeftRadius: 4,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: '#fff',
    borderTopRightRadius: 4,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: '#fff',
    borderBottomLeftRadius: 4,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: '#fff',
    borderBottomRightRadius: 4,
  },
  hintText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
    opacity: 0.9,
  },
  flash: {
    backgroundColor: '#4C51C9',
  },
  closeBtn: {
    position: 'absolute',
    top: 56,
    left: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  torchBtn: {
    position: 'absolute',
    top: 56,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    zIndex: 10,
  },
  torchText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  permTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  permText: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  settingsBtn: {
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  settingsBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
