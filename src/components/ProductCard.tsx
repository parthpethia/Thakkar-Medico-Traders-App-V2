import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Product } from '../types';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface ProductCardProps {
  product: Product;
  onPress: () => void;
  onAddToCart?: () => void;
  showPrices?: boolean;
}

function createStyles(c: AppColors) {
  return {
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      overflow: 'hidden' as const,
      marginBottom: 12,
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
      width: '48%' as const,
    },
    imageContainer: {
      position: 'relative' as const,
      height: 120,
      backgroundColor: c.inputBackground,
    },
    image: {
      width: '100%' as const,
      height: '100%' as const,
      resizeMode: 'cover' as const,
    },
    placeholderImage: {
      width: '100%' as const,
      height: '100%' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: c.primaryMuted,
    },
    discountBadge: {
      position: 'absolute' as const,
      top: 8,
      left: 8,
      backgroundColor: c.success,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
    },
    discountText: {
      color: c.onPrimary,
      fontSize: 10,
      fontWeight: '700' as const,
    },
    outOfStockOverlay: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    outOfStockText: {
      color: c.onPrimary,
      fontSize: 12,
      fontWeight: '700' as const,
    },
    info: {
      padding: 12,
    },
    name: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: c.text,
      marginBottom: 4,
      minHeight: 36,
    },
    priceContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginBottom: 8,
    },
    sellingPrice: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: c.primary,
    },
    mrp: {
      fontSize: 12,
      color: c.textMuted,
      textDecorationLine: 'line-through' as const,
    },
    loginPrompt: {
      fontSize: 12,
      color: c.primary,
      fontStyle: 'italic' as const,
    },
    addButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: c.primary,
      paddingVertical: 8,
      borderRadius: 8,
      gap: 4,
    },
    addButtonText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '600' as const,
    },
  };
}

export const ProductCard: React.FC<ProductCardProps> = React.memo(({
  product,
  onPress,
  onAddToCart,
  showPrices = true,
}) => {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const discount = Math.round(((product.mrp - product.selling_price) / product.mrp) * 100);
  const isOutOfStock = product.stock_quantity <= 0;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.imageContainer}>
        {product.image ? (
          <Image source={{ uri: product.image }} style={styles.image} />
        ) : (
          <View style={styles.placeholderImage}>
            <Ionicons name="medical" size={40} color={colors.primary} />
          </View>
        )}
        {discount > 0 && (
          <View style={styles.discountBadge}>
            <Text style={styles.discountText}>{discount}% OFF</Text>
          </View>
        )}
        {isOutOfStock && (
          <View style={styles.outOfStockOverlay}>
            <Text style={styles.outOfStockText}>Out of Stock</Text>
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>

        {showPrices && (
          <View style={styles.priceContainer}>
            <Text style={styles.sellingPrice}>₹{product.selling_price.toFixed(2)}</Text>
            {product.mrp > product.selling_price && (
              <Text style={styles.mrp}>₹{product.mrp.toFixed(2)}</Text>
            )}
          </View>
        )}

        {!showPrices && (
          <Text style={styles.loginPrompt}>Login to see prices</Text>
        )}

        {onAddToCart && showPrices && !isOutOfStock && (
          <TouchableOpacity
            style={styles.addButton}
            onPress={(e) => {
              e.stopPropagation();
              onAddToCart();
            }}
          >
            <Ionicons name="add" size={20} color={colors.onPrimary} />
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
});
