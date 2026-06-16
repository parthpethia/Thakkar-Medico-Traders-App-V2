import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  branchDisplayLabel,
  buildShortAddress,
  formatDeliveryWindow,
} from '../../constants/shopLocation';
import type { RetailerShopLocation } from '../../types/shopLocation';

type Props = {
  location: RetailerShopLocation;
  onDeliverHere?: () => void;
  onEdit?: () => void;
  onSetDefault?: () => void;
  onDelete?: () => void;
  compact?: boolean;
};

export function ShopLocationCard({
  location,
  onDeliverHere,
  onEdit,
  onSetDefault,
  onDelete,
  compact,
}: Props) {
  const branch = branchDisplayLabel(location.branch_label, location.custom_label);
  const window = formatDeliveryWindow(
    location.best_delivery_time_start,
    location.best_delivery_time_end,
  );

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.branchTag}>{branch}</Text>
        {location.is_verified && <Text style={styles.badge}>✅ Verified</Text>}
        {location.is_locked_by_admin && (
          <View style={styles.lockRow}>
            <Ionicons name="lock-closed" size={14} color="#888" />
            <Text style={styles.lockHint}>Managed by your account manager</Text>
          </View>
        )}
        {location.is_default && <Text style={styles.defaultBadge}>Default</Text>}
      </View>

      <Text style={styles.shopName}>{location.shop_name}</Text>
      <Text style={styles.address} numberOfLines={2}>
        {buildShortAddress(location)}
      </Text>
      {location.landmark ? (
        <Text style={styles.landmark} numberOfLines={1}>
          Landmark: {location.landmark}
        </Text>
      ) : null}

      <Text style={styles.receiver}>
        {location.receiver_name} · {location.receiver_phone}
      </Text>
      {location.gstin ? <Text style={styles.meta}>GSTIN: {location.gstin}</Text> : null}
      {window ? <Text style={styles.meta}>Best delivery: {window}</Text> : null}

      {!compact && (
        <View style={styles.actions}>
          {onDeliverHere && (
            <TouchableOpacity style={styles.primaryBtn} onPress={onDeliverHere}>
              <Text style={styles.primaryBtnText}>Deliver Here</Text>
            </TouchableOpacity>
          )}
          <View style={styles.secondaryRow}>
            {!location.is_default && onSetDefault && (
              <TouchableOpacity onPress={onSetDefault}>
                <Text style={styles.link}>Set as Default</Text>
              </TouchableOpacity>
            )}
            {onEdit && !location.is_locked_by_admin && (
              <TouchableOpacity onPress={onEdit} style={styles.iconBtn}>
                <Ionicons name="pencil" size={18} color="#4C51C9" />
              </TouchableOpacity>
            )}
            {onDelete && !location.is_locked_by_admin && (
              <TouchableOpacity onPress={onDelete} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={18} color="#E53935" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#eee',
  },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 },
  branchTag: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4C51C9',
    backgroundColor: '#F3F3FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badge: { fontSize: 11, color: '#2E7D32' },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lockHint: { fontSize: 10, color: '#888' },
  defaultBadge: { fontSize: 11, color: '#FF8F00', fontWeight: '600' },
  shopName: { fontSize: 16, fontWeight: '700', color: '#222', marginBottom: 4 },
  address: { fontSize: 13, color: '#555', marginBottom: 4 },
  landmark: { fontSize: 12, color: '#777', marginBottom: 4 },
  receiver: { fontSize: 13, color: '#333', marginTop: 4 },
  meta: { fontSize: 12, color: '#666', marginTop: 2 },
  actions: { marginTop: 12 },
  primaryBtn: {
    backgroundColor: '#4C51C9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  link: { color: '#4C51C9', fontWeight: '600', fontSize: 14 },
  iconBtn: { padding: 4 },
});
