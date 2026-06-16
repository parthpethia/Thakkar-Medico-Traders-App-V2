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
  location: RetailerShopLocation | null;
  error?: string;
  onChange: () => void;
};

export function DeliverToCard({ location, error, onChange }: Props) {
  return (
    <View style={[styles.card, error ? styles.cardError : null]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Deliver To</Text>
        <TouchableOpacity onPress={onChange} hitSlop={8}>
          <Text style={styles.changeLink}>{location ? 'Change' : 'Select'}</Text>
        </TouchableOpacity>
      </View>

      {location ? (
        <>
          <View style={styles.nameRow}>
            <Text style={styles.shopName}>{location.shop_name}</Text>
            <Text style={styles.branch}>
              {branchDisplayLabel(location.branch_label, location.custom_label)}
            </Text>
            {location.is_verified && <Text>✅</Text>}
            {location.is_locked_by_admin && (
              <Ionicons name="lock-closed" size={14} color="#888" />
            )}
          </View>
          <Text style={styles.line}>{buildShortAddress(location)}</Text>
          {location.landmark ? (
            <Text style={styles.line}>Landmark: {location.landmark}</Text>
          ) : null}
          <Text style={styles.line}>
            {location.receiver_name} · {location.receiver_phone}
          </Text>
          {formatDeliveryWindow(
            location.best_delivery_time_start,
            location.best_delivery_time_end,
          ) ? (
            <View style={styles.timeNote}>
              <Ionicons name="time-outline" size={16} color="#4C51C9" />
              <Text style={styles.timeText}>
                Preferred delivery:{' '}
                {formatDeliveryWindow(
                  location.best_delivery_time_start,
                  location.best_delivery_time_end,
                )}
              </Text>
            </View>
          ) : null}
          {location.entry_notes ? (
            <Text style={styles.notes}>Entry: {location.entry_notes}</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.placeholder}>Add your shop / warehouse delivery location</Text>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#eee',
  },
  cardError: { borderColor: '#E53935' },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '700' },
  changeLink: { color: '#4C51C9', fontWeight: '600', fontSize: 15 },
  nameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 },
  shopName: { fontSize: 16, fontWeight: '700', color: '#222' },
  branch: {
    fontSize: 11,
    fontWeight: '600',
    color: '#4C51C9',
    backgroundColor: '#F3F3FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  line: { fontSize: 13, color: '#555', marginBottom: 4 },
  timeNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    backgroundColor: '#F3F3FF',
    padding: 10,
    borderRadius: 8,
  },
  timeText: { fontSize: 13, color: '#333', flex: 1, fontWeight: '500' },
  notes: { fontSize: 12, color: '#666', marginTop: 6, fontStyle: 'italic' },
  placeholder: { fontSize: 14, color: '#888' },
  error: { color: '#E53935', marginTop: 10, fontSize: 13, fontWeight: '500' },
});
