import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CartItem } from '../store/cartStore';

interface Props {
  item: CartItem;
  onUpdateQuantity: (qty: number) => void;
  onRemove: () => void;
}

export default function CartItemComponent({
  item,
  onUpdateQuantity,
  onRemove,
}: Props) {
  const subtotal = item.selling_price * item.quantity;
  const gst = (subtotal * item.gst_percent) / 100;
  const total = subtotal + gst;

  return (
    <View style={styles.container}>
      <View style={styles.imageBox}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.image} />
        ) : (
          <Ionicons name="cube" size={24} color="#4C51C9" />
        )}
      </View>

      <View style={styles.details}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.price}>
          ₹{item.selling_price.toFixed(2)}
        </Text>

        <View style={styles.row}>
          <View style={styles.qtyBox}>
            <TouchableOpacity onPress={() => onUpdateQuantity(item.quantity - 1)}>
              <Ionicons name="remove" size={18} />
            </TouchableOpacity>
            <Text style={styles.qty}>{item.quantity}</Text>
            <TouchableOpacity onPress={() => onUpdateQuantity(item.quantity + 1)}>
              <Ionicons name="add" size={18} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={onRemove}>
            <Ionicons name="trash" size={20} color="#e53935" />
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

const styles = StyleSheet.create({
  container: { flexDirection: 'row', padding: 12, backgroundColor: '#fff', marginBottom: 12, borderRadius: 12 },
  imageBox: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  image: { width: 64, height: 64, borderRadius: 8 },
  details: { flex: 1, marginHorizontal: 12 },
  name: { fontWeight: '600' },
  price: { color: '#666', marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  qtyBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qty: { fontWeight: '600' },
  total: { fontWeight: '700', color: '#4C51C9' },
  gst: { fontSize: 11, color: '#888' },
});
