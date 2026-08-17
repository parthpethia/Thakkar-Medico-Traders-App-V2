import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';

import { triggerNotification } from '../../services/notificationTriggerService';

export type DeliveryStaffRow = {
  id: string;
  name: string;
  phone: string | null;
  is_on_duty: boolean;
  current_order_count: number;
};

type Props = {
  visible: boolean;
  orderId: string;
  orderNumber: string;
  onClose: () => void;
  onAssigned: () => void;
};

export function AssignDeliveryModal({
  visible,
  orderId,
  orderNumber,
  onClose,
  onAssigned,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [staff, setStaff] = useState<DeliveryStaffRow[]>([]);
  const [showOffDuty, setShowOffDuty] = useState(true);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('list_delivery_staff', {
        p_on_duty_only: !showOffDuty,
      });
      if (error) throw error;
      setStaff((data || []) as DeliveryStaffRow[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load drivers';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
    }
  }, [showOffDuty]);

  useEffect(() => {
    if (visible) void loadStaff();
  }, [visible, loadStaff]);

  const assignTo = async (profileId: string) => {
    setAssigning(profileId);
    try {
      const { error } = await supabase.rpc('assign_order_to_delivery', {
        p_order_id: orderId,
        p_delivery_profile_id: profileId,
      });
      if (error) throw error;

      // Asynchronously trigger notifications
      (async () => {
        try {
          const { data: orderDetails } = await supabase
            .from('orders')
            .select('order_number, user_id, destination_landmark')
            .eq('id', orderId)
            .maybeSingle();

          let shopName = 'Destination Store';
          if (orderDetails?.user_id) {
            const { data: prof } = await supabase
              .from('profiles')
              .select('name, business_name')
              .eq('id', orderDetails.user_id)
              .maybeSingle();
            if (prof?.business_name || prof?.name) {
              shopName = prof.business_name || prof.name;
            }
          }

          const assignedStaff = staff.find((s) => s.id === profileId);
          const orderNum = orderNumber || orderDetails?.order_number || orderId.slice(0, 8);

          // 1. Notify Rider: New Delivery Assigned
          void triggerNotification({
            order_id: orderId,
            event_type: 'order_assigned',
            recipient_user_id: profileId,
            data: {
              order_number: orderNum,
              shop_name: shopName,
              landmark: orderDetails?.destination_landmark || '',
            },
          });

          // 2. Notify Retailer: Order Dispatched
          if (orderDetails?.user_id) {
            void triggerNotification({
              order_id: orderId,
              event_type: 'order_dispatched',
              recipient_user_id: orderDetails.user_id,
              data: {
                order_number: orderNum,
                rider_name: assignedStaff?.name || 'Delivery Partner',
                shop_name: shopName,
                eta_minutes: 15,
              },
            });
          }
        } catch (notifErr) {
          console.warn('[AssignDeliveryModal] Push notification error:', notifErr);
        }
      })();

      Alert.alert('Assigned', `Order #${orderNumber} assigned to driver.`);
      onAssigned();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Assign failed';
      Alert.alert('Error', msg);
    } finally {
      setAssigning(null);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Assign driver</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>Order #{orderNumber}</Text>

          <TouchableOpacity
            style={styles.toggleRow}
            onPress={() => setShowOffDuty((v) => !v)}
          >
            <Ionicons
              name={showOffDuty ? 'checkbox' : 'square-outline'}
              size={20}
              color={colors.primary}
            />
            <Text style={styles.toggleText}>Include off-duty drivers</Text>
          </TouchableOpacity>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
          ) : (
            <FlatList
              data={staff}
              keyExtractor={(item) => item.id}
              style={{ maxHeight: 360 }}
              ListEmptyComponent={
                <Text style={styles.empty}>No delivery staff found.</Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.row}
                  disabled={!!assigning}
                  onPress={() => assignTo(item.id)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{item.name}</Text>
                    <Text style={styles.meta}>
                      {item.is_on_duty ? 'On duty' : 'Off duty'} · {item.current_order_count}{' '}
                      active
                    </Text>
                  </View>
                  {assigning === item.id ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons name="person-add" size={22} color={colors.primary} />
                  )}
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return {
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end' as const,
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 20,
      paddingBottom: 28,
    },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
    },
    title: { fontSize: 18, fontWeight: '700' as const, color: c.text },
    sub: { fontSize: 14, color: c.textSecondary, marginTop: 4, marginBottom: 12 },
    toggleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, marginBottom: 12 },
    toggleText: { fontSize: 13, color: c.text },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    name: { fontSize: 15, fontWeight: '600' as const, color: c.text },
    meta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    empty: { textAlign: 'center' as const, color: c.textMuted, marginVertical: 20 },
  };
}
