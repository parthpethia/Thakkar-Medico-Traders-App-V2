import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  branchDisplayLabel,
  buildShortAddress,
  formatDeliveryWindow,
} from '../../constants/shopLocation';
import type { RetailerShopLocation } from '../../types/shopLocation';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';

type Props = {
  location: RetailerShopLocation | null;
  error?: string;
  onChange: () => void;
};

export function DeliverToCard({ location, error, onChange }: Props) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

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
              <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
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
              <Ionicons name="time-outline" size={16} color={colors.primary} />
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

function createStyles(c: AppColors) {
  return {
    card: {
      backgroundColor: c.surface,
      padding: 16,
      borderRadius: 12,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardError: { borderColor: c.error },
    titleRow: { flexDirection: 'row' as const, justifyContent: 'space-between', marginBottom: 10 },
    title: { fontSize: 16, fontWeight: '700' as const, color: c.text },
    changeLink: { color: c.primary, fontWeight: '600' as const, fontSize: 15 },
    nameRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, gap: 8, marginBottom: 6 },
    shopName: { fontSize: 16, fontWeight: '700' as const, color: c.text },
    branch: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: c.primary,
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 12,
    },
    line: { fontSize: 13, color: c.textSecondary, marginBottom: 4 },
    timeNote: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      marginTop: 8,
      backgroundColor: c.primaryMuted,
      padding: 10,
      borderRadius: 8,
    },
    timeText: { fontSize: 13, color: c.text, flex: 1, fontWeight: '500' as const },
    notes: { fontSize: 12, color: c.textSecondary, marginTop: 6, fontStyle: 'italic' as const },
    placeholder: { fontSize: 14, color: c.textMuted },
    error: { color: c.error, marginTop: 10, fontSize: 13, fontWeight: '500' as const },
  } as const;
}
