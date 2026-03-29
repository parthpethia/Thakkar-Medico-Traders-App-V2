import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import * as ImagePicker from 'expo-image-picker';

import { scanAndIdentifyProduct, ScanResult } from '../../src/services/imageRecognition';
import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { Product, shouldShowPrices } from '../../src/types';

export default function ScanProduct() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const showPrices = shouldShowPrices(user, settings);

  /* ================= PICK IMAGE ================= */

  const pickImage = async (source: 'camera' | 'gallery') => {
    try {
      let pickerResult: ImagePicker.ImagePickerResult;

      if (source === 'camera') {
        if (!ImagePicker.requestCameraPermissionsAsync || !ImagePicker.launchCameraAsync) {
          Alert.alert('Camera Unavailable', 'Your current app build does not support the camera. Please rebuild with the required native modules or run using Expo Go.');
          return;
        }

        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Camera permission is required to take photos.');
          return;
        }
        pickerResult = await ImagePicker.launchCameraAsync({
          base64: true,
          quality: 0.7,
          allowsEditing: true,
        });
      } else {
        if (!ImagePicker.requestMediaLibraryPermissionsAsync || !ImagePicker.launchImageLibraryAsync) {
          Alert.alert('Gallery Unavailable', 'Your current app build does not support the gallery. Please rebuild with the required native modules or run using Expo Go.');
          return;
        }

        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Gallery permission is required to pick images.');
          return;
        }
        pickerResult = await ImagePicker.launchImageLibraryAsync({
          base64: true,
          quality: 0.7,
          allowsEditing: true,
          mediaTypes: ['images'],
        });
      }

      if (pickerResult.canceled || !pickerResult.assets?.[0]) return;

      const asset = pickerResult.assets[0];
      setImageUri(asset.uri);
      setResult(null);

      if (!asset.base64) {
        Alert.alert('Error', 'Could not read image data. Please try again.');
        return;
      }

      // Start scanning
      setScanning(true);
      const scanResult = await scanAndIdentifyProduct(asset.base64);
      setResult(scanResult);

      if (scanResult.matchedProducts.length === 0 && scanResult.rawText) {
        Alert.alert(
          'No matches found',
          'We could not find this product in our catalog. The text we detected:\n\n' +
            scanResult.rawText.substring(0, 200),
        );
      } else if (!scanResult.rawText) {
        Alert.alert(
          'No text detected',
          'Could not read any text from the image. Try taking a clearer photo of the product label.',
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to scan image');
    } finally {
      setScanning(false);
    }
  };

  /* ================= ADD TO CART ================= */

  const handleAddToCart = async (product: Product) => {
    if (!user) {
      Alert.alert('Login required', 'Please login to add items to cart');
      return;
    }
    try {
      setAddingId(product.id);
      await addToCart(product.id, 1);
      Alert.alert('Added to cart', product.name);
    } catch {
      Alert.alert('Error', 'Failed to add to cart');
    } finally {
      setAddingId(null);
    }
  };

  /* ================= RESET ================= */

  const handleReset = () => {
    setImageUri(null);
    setResult(null);
    setScanning(false);
  };

  /* ================= RENDER PRODUCT ITEM ================= */

  const renderProduct = ({ item }: { item: Product }) => {
    const inStock = item.stock_quantity > 0;
    const isAdding = addingId === item.id;

    return (
      <TouchableOpacity
        style={styles.productCard}
        onPress={() => router.push(`/product/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>
            {item.name}
          </Text>
          {item.company && (
            <Text style={styles.productCompany}>{item.company}</Text>
          )}
          {item.pack_size && (
            <Text style={styles.productPack}>{item.pack_size}</Text>
          )}

          <View style={styles.productBottom}>
            {/* Stock status */}
            <View
              style={[
                styles.stockBadge,
                inStock ? styles.inStockBadge : styles.outStockBadge,
              ]}
            >
              <Ionicons
                name={inStock ? 'checkmark-circle' : 'close-circle'}
                size={14}
                color={inStock ? '#43A047' : '#C62828'}
              />
              <Text
                style={[
                  styles.stockText,
                  { color: inStock ? '#43A047' : '#C62828' },
                ]}
              >
                {inStock ? 'Available' : 'Out of Stock'}
              </Text>
            </View>

            {/* Price */}
            {showPrices && (
              <Text style={styles.productPrice}>₹{item.selling_price}</Text>
            )}
          </View>
        </View>

        {/* Add to cart */}
        {inStock && (
          <TouchableOpacity
            style={styles.addCartBtn}
            onPress={() => handleAddToCart(item)}
            disabled={isAdding}
          >
            {isAdding ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="cart-outline" size={20} color="#fff" />
            )}
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  /* ================= MAIN RENDER ================= */

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen
        options={{
          title: 'Scan Product',
          headerStyle: { backgroundColor: '#4C51C9' },
          headerTintColor: '#fff',
        }}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Header info */}
        <View style={styles.headerCard}>
          <View style={styles.headerIcon}>
            <Ionicons name="scan" size={32} color="#4C51C9" />
          </View>
          <Text style={styles.headerTitle}>Identify Product</Text>
          <Text style={styles.headerSubtitle}>
            Take a photo or upload an image of a product box, strip, or label.
            We'll identify it and check availability.
          </Text>
        </View>

        {/* Action buttons */}
        {!scanning && !result && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => pickImage('camera')}
            >
              <View style={styles.actionIconWrap}>
                <Ionicons name="camera" size={28} color="#4C51C9" />
              </View>
              <Text style={styles.actionBtnTitle}>Take Photo</Text>
              <Text style={styles.actionBtnSub}>Use camera to capture</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => pickImage('gallery')}
            >
              <View style={styles.actionIconWrap}>
                <Ionicons name="images" size={28} color="#4C51C9" />
              </View>
              <Text style={styles.actionBtnTitle}>Upload Image</Text>
              <Text style={styles.actionBtnSub}>Pick from gallery</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Scanned image preview */}
        {imageUri && (
          <View style={styles.previewSection}>
            <Image source={{ uri: imageUri }} style={styles.previewImage} />
          </View>
        )}

        {/* Scanning indicator */}
        {scanning && (
          <View style={styles.scanningWrap}>
            <ActivityIndicator size="large" color="#4C51C9" />
            <Text style={styles.scanningText}>Analyzing image...</Text>
            <Text style={styles.scanningSubtext}>
              Reading text and searching our catalog
            </Text>
          </View>
        )}

        {/* Results */}
        {result && !scanning && (
          <View style={styles.resultsSection}>
            {/* Extracted keywords */}
            {result.extractedTexts.length > 0 && (
              <View style={styles.keywordsCard}>
                <Text style={styles.sectionTitle}>
                  <Ionicons name="text" size={16} color="#4C51C9" /> Detected
                  Keywords
                </Text>
                <View style={styles.keywordsWrap}>
                  {result.extractedTexts.slice(0, 15).map((kw, i) => (
                    <View key={i} style={styles.keywordChip}>
                      <Text style={styles.keywordText}>{kw}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Matched products */}
            <View style={styles.matchSection}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="search" size={16} color="#4C51C9" />{' '}
                {result.matchedProducts.length > 0
                  ? `Found ${result.matchedProducts.length} matching product${
                      result.matchedProducts.length > 1 ? 's' : ''
                    }`
                  : 'No matching products found'}
              </Text>

              {result.matchedProducts.length === 0 && (
                <View style={styles.noMatchCard}>
                  <Ionicons name="alert-circle-outline" size={48} color="#ccc" />
                  <Text style={styles.noMatchText}>
                    This product is not available in our catalog.
                  </Text>
                  <Text style={styles.noMatchSub}>
                    Try taking a clearer photo or search manually.
                  </Text>
                </View>
              )}
            </View>

            {result.matchedProducts.length > 0 && (
              <FlatList
                data={result.matchedProducts}
                renderItem={renderProduct}
                keyExtractor={(item) => item.id}
                scrollEnabled={false}
                contentContainerStyle={{ gap: 10 }}
              />
            )}

            {/* Scan again */}
            <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
              <Ionicons name="refresh" size={20} color="#fff" />
              <Text style={styles.resetBtnText}>Scan Another Product</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5FA',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },

  /* Header card */
  headerCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  headerIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ECEDFB',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
  },

  /* Action buttons */
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  actionIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#ECEDFB',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  actionBtnTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  actionBtnSub: {
    fontSize: 12,
    color: '#999',
  },

  /* Preview */
  previewSection: {
    marginBottom: 16,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  previewImage: {
    width: '100%',
    height: 220,
    resizeMode: 'contain',
    backgroundColor: '#f9f9f9',
  },

  /* Scanning */
  scanningWrap: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  scanningText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4C51C9',
    marginTop: 16,
  },
  scanningSubtext: {
    fontSize: 13,
    color: '#888',
    marginTop: 6,
  },

  /* Results */
  resultsSection: {
    marginTop: 4,
  },

  /* Keywords */
  keywordsCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  keywordsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  keywordChip: {
    backgroundColor: '#ECEDFB',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  keywordText: {
    fontSize: 13,
    color: '#4C51C9',
    fontWeight: '500',
  },

  /* Match section */
  matchSection: {
    marginBottom: 12,
  },
  noMatchCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 32,
    alignItems: 'center',
  },
  noMatchText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#666',
    marginTop: 12,
    textAlign: 'center',
  },
  noMatchSub: {
    fontSize: 13,
    color: '#999',
    marginTop: 6,
    textAlign: 'center',
  },

  /* Product card */
  productCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  productInfo: {
    flex: 1,
  },
  productName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  productCompany: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
  productPack: {
    fontSize: 12,
    color: '#4C51C9',
    marginTop: 2,
  },
  productBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 12,
  },
  stockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  inStockBadge: {
    backgroundColor: '#E8F5E9',
  },
  outStockBadge: {
    backgroundColor: '#FFEBEE',
  },
  stockText: {
    fontSize: 12,
    fontWeight: '600',
  },
  productPrice: {
    fontSize: 15,
    fontWeight: '700',
    color: '#4C51C9',
  },
  addCartBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#4C51C9',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },

  /* Reset button */
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#4C51C9',
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 20,
  },
  resetBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
