import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CartItem } from '../store/cartStore';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface Props {
  item: CartItem;
  onUpdateQuantity: (qty: number) => void;
  onRemove: () => void;
}

function createStyles(c: AppColors) {
  return {
    container: {
      flexDirection: 'row' as const,
      padding: 12,
      backgroundColor: c.surface,
      marginBottom: 12,
      borderRadius: 12,
    },
    imageBox: {
      width: 64,
      height: 64,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    image: { width: 64, height: 64, borderRadius: 8 },
    details: { flex: 1, marginHorizontal: 12 },
    name: { fontWeight: '600' as const, color: c.text },
    price: { color: c.textSecondary, marginBottom: 6 },
    row: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },
    qtyBox: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    qty: { fontWeight: '600' as const, color: c.text },
    total: { fontWeight: '700' as const, color: c.primary },
    gst: { fontSize: 11, color: c.textMuted },
  };
}

function CartItemComponent({ item, onUpdateQuantity, onRemove }: Props) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const subtotal = item.selling_price * item.quantity;
  const gst = (subtotal * item.gst_percent) / 100;
  const total = subtotal + gst;

  return (
    <View style={styles.container}>
      <View style={styles.imageBox}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.image} />
        ) : (
          <Ionicons name="cube" size={24} color={colors.primary} />
        )}
      </View>

      <View style={styles.details}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.price}>₹{item.selling_price.toFixed(2)}</Text>

        <View style={styles.row}>
          <View style={styles.qtyBox}>
            <TouchableOpacity onPress={() => onUpdateQuantity(item.quantity - 1)}>
              <Ionicons name="remove" size={18} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.qty}>{item.quantity}</Text>
            <TouchableOpacity onPress={() => onUpdateQuantity(item.quantity + 1)}>
              <Ionicons name="add" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={onRemove}>
            <Ionicons name="trash" size={20} color={colors.error} />
          </TouchableOpacity>
        </View>
      </View>

      <View>
        <Text style={styles.total}>₹{total.toFixed(2)}</Text>
        <Text style={styles.gst}>incl. GST ₹{gst.toFixed(2)}</Text>
      </View>
    </View>
  );
}

export default React.memo(CartItemComponent);
