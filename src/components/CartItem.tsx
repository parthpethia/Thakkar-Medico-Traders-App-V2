import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CartItem as CartItemType } from '../types';

interface CartItemProps {
  item: CartItemType;
  onUpdateQuantity: (quantity: number) => void;
  onRemove: () => void;
}

export const CartItemComponent: React.FC<CartItemProps> = ({ 
  item, 
  onUpdateQuantity, 
  onRemove 
}) => {
  const subtotal = item.selling_price * item.quantity;
  const gstAmount = (subtotal * item.gst_percent) / 100;
  const total = subtotal + gstAmount;

  return (
    <View style={styles.container}>
      <View style={styles.imageContainer}>
        {item.product_image ? (
          <Image source={{ uri: item.product_image }} style={styles.image} />
        ) : (
          <View style={styles.placeholderImage}>
            <Ionicons name="medical" size={24} color="#1E88E5" />
          </View>
        )}
      </View>
      
      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={2}>{item.product_name}</Text>
        <Text style={styles.price}>₹{item.selling_price.toFixed(2)} / unit</Text>
        
        <View style={styles.quantityRow}>
          <View style={styles.quantityControls}>
            <TouchableOpacity 
              style={styles.quantityBtn}
              onPress={() => onUpdateQuantity(item.quantity - 1)}
            >
              <Ionicons name="remove" size={18} color="#1E88E5" />
            </TouchableOpacity>
            <Text style={styles.quantity}>{item.quantity}</Text>
            <TouchableOpacity 
              style={styles.quantityBtn}
              onPress={() => onUpdateQuantity(item.quantity + 1)}
            >
              <Ionicons name="add" size={18} color="#1E88E5" />
            </TouchableOpacity>
          </View>
          
          <TouchableOpacity style={styles.removeBtn} onPress={onRemove}>
            <Ionicons name="trash-outline" size={20} color="#e53935" />
          </TouchableOpacity>
        </View>
      </View>
      
      <View style={styles.totalContainer}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalPrice}>₹{total.toFixed(2)}</Text>
        <Text style={styles.gstInfo}>incl. GST ₹{gstAmount.toFixed(2)}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  imageContainer: {
    width: 70,
    height: 70,
    borderRadius: 8,
    overflow: 'hidden',
    marginRight: 12,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholderImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    flex: 1,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  price: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quantityControls: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  quantityBtn: {
    padding: 8,
  },
  quantity: {
    fontSize: 14,
    fontWeight: '600',
    minWidth: 30,
    textAlign: 'center',
  },
  removeBtn: {
    padding: 8,
  },
  totalContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 80,
  },
  totalLabel: {
    fontSize: 11,
    color: '#888',
  },
  totalPrice: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E88E5',
  },
  gstInfo: {
    fontSize: 10,
    color: '#888',
  },
});
