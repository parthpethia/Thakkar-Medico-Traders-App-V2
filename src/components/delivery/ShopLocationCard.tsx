import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
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
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

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
            <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
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
                <Ionicons name="pencil" size={18} color={colors.primary} />
              </TouchableOpacity>
            )}
            {onDelete && !location.is_locked_by_admin && (
              <TouchableOpacity onPress={onDelete} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={18} color={colors.error} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function createStyles(c: AppColors) {
  return {
    card: {
      backgroundColor: c.surfaceSecondary,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    headerRow: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginBottom: 6,
    },
    branchTag: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: c.primary,
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 20,
    },
    badge: { fontSize: 11, color: c.success },
    lockRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    lockHint: { fontSize: 10, color: c.textMuted },
    defaultBadge: { fontSize: 11, color: c.warning, fontWeight: '600' as const },
    shopName: { fontSize: 16, fontWeight: '700' as const, color: c.text, marginBottom: 4 },
    address: { fontSize: 13, color: c.textSecondary, marginBottom: 4 },
    landmark: { fontSize: 12, color: c.textMuted, marginBottom: 4 },
    receiver: { fontSize: 13, color: c.text, marginTop: 4 },
    meta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    actions: { marginTop: 12 },
    primaryBtn: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center' as const,
      marginBottom: 8,
    },
    primaryBtnText: { color: c.onPrimary, fontWeight: '700' as const, fontSize: 15 },
    secondaryRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 16 },
    link: { color: c.primary, fontWeight: '600' as const, fontSize: 14 },
    iconBtn: { padding: 4 },
  };
}
