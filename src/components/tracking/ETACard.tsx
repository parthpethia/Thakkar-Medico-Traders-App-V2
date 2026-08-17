/**
 * ETACard — Bottom floating expandable card for the Admin Live Delivery Tracking screen.
 *
 * Collapsed view (~80px):
 *   - Animated scooter dot + ETA time + minutes remaining + km distance
 *   - Live status pill (IN TRANSIT / ARRIVING SOON / SIGNAL LOST / OFF ROUTE / DELIVERED)
 *
 * Expanded view (~320px, tap to expand):
 *   - Row 1: Rider info (Name, Call button, Battery % with low battery warning, Speed, Last update age)
 *   - Row 2: ETA block with progress bar (percentage of route completed)
 *   - Row 3: SLA warning (amber/orange if ETA > preferred delivery window end)
 *   - Row 4: Order summary (Order #, shop name, landmark, receiver contact)
 *   - Row 5: Timeline strip (Placed → Confirmed → Dispatched → In Transit → Delivered) with timestamps
 *   - Row 6: Action buttons (Call Rider, Call Receiver, Order Details Modal)
 *   - Row 7: Admin ops notes
 *   - Phase 2 hook: Delivery photo thumbnail placeholder
 */
import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Linking,
  Modal,
  Image,
  StyleSheet,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatETA } from '../../services/routesApiService';
import { triggerNotification } from '../../services/notificationTriggerService';

export interface ETACardTimeline {
  placed_at: string | null;
  confirmed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

export interface ETACardProps {
  orderId?: string;
  etaSeconds: number | null;
  distanceMeters: number | null;
  totalDistanceMeters?: number | null;
  orderNumber: string;
  shopName: string;
  landmark: string;
  receiverName: string;
  receiverPhone: string;
  riderName: string;
  riderPhone: string;
  batteryLevel?: number | null;
  speedKmh?: number | null;
  deliveryWindow?: string;
  deliveryStatus?: string | null;
  dispatchedAt: string | null;
  lastUpdatedAt: string | null;
  isDelivered: boolean;
  isOffRoute?: boolean;
  geofenceArrived?: boolean;
  adminNotes?: string | null;
  timeline?: ETACardTimeline | null;
  orderItems?: any[];
  grandTotal?: number | null;
  paymentMode?: string | null;
  gstin?: string | null;
  proof?: {
    id: string;
    photo_url: string;
    captured_lat?: number | null;
    captured_lng?: number | null;
    captured_at: string;
    notes?: string | null;
  } | null;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatTimeString(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}

/**
 * Check if the calculated arrival timestamp will exceed the preferred delivery window end time.
 * Supports formats like "10:00 AM - 01:00 PM" or "10 AM – 1 PM" or "Morning (10 AM - 1 PM)".
 */
function checkSlaBreach(etaSeconds: number | null, windowStr?: string): boolean {
  if (!etaSeconds || !windowStr || windowStr.trim() === '') return false;

  try {
    const arrivalTimeMs = Date.now() + etaSeconds * 1000;
    const clean = windowStr.replace(/–/g, '-');
    const parts = clean.split('-');
    if (parts.length < 2) return false;

    const endPart = parts[1].trim();
    const match = endPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return false;

    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridian = (match[3] || '').toUpperCase();

    if (meridian === 'PM' && hour < 12) hour += 12;
    if (meridian === 'AM' && hour === 12) hour = 0;

    const windowEndDate = new Date();
    windowEndDate.setHours(hour, minute, 0, 0);

    return arrivalTimeMs > windowEndDate.getTime();
  } catch {
    return false;
  }
}

export function ETACard({
  orderId,
  etaSeconds,
  distanceMeters,
  totalDistanceMeters,
  orderNumber,
  shopName,
  landmark,
  receiverName,
  receiverPhone,
  riderName,
  riderPhone,
  batteryLevel,
  speedKmh,
  deliveryWindow,
  deliveryStatus,
  dispatchedAt,
  lastUpdatedAt,
  isDelivered,
  isOffRoute,
  geofenceArrived,
  adminNotes,
  timeline,
  orderItems,
  grandTotal,
  paymentMode,
  gstin,
  proof,
}: ETACardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [secondsAgo, setSecondsAgo] = useState(0);

  // SLA breach notification guard (fire once per session)
  const slaNotificationSentRef = useRef(false);

  // Pulse animation for arriving soon and active status
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulseAnim]);

  // Refresh "last updated" timer
  useEffect(() => {
    if (!lastUpdatedAt) return;
    const update = () => {
      const diff = Math.max(
        0,
        Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 1000),
      );
      setSecondsAgo(diff);
    };
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [lastUpdatedAt]);

  const signalLost = secondsAgo > 120; // >2 minutes
  const isSlaBreached = checkSlaBreach(etaSeconds, deliveryWindow);

  // Formatted ETA values
  const etaData = useMemo(() => {
    if (etaSeconds != null && etaSeconds > 0) {
      return formatETA(etaSeconds);
    }
    return null;
  }, [etaSeconds]);

  // Trigger order_late_sla push notification to admin (once per order session)
  useEffect(() => {
    if (isSlaBreached && !slaNotificationSentRef.current && (orderId || orderNumber)) {
      slaNotificationSentRef.current = true;
      void triggerNotification({
        order_id: orderId || orderNumber,
        event_type: 'order_late_sla',
        recipient_role: 'admin',
        data: {
          order_number: orderNumber,
          preferred_window: deliveryWindow || 'preferred window',
          eta_time: etaData?.arrivalTime || 'delayed',
        },
      });
    }
  }, [isSlaBreached, orderId, orderNumber, deliveryWindow, etaData?.arrivalTime]);

  // Route progress percentage (0 - 100)
  const progressPercent = useMemo(() => {
    if (isDelivered) return 100;
    if (!distanceMeters) return 30;
    const total = totalDistanceMeters || distanceMeters * 1.6;
    if (total <= 0) return 40;
    const completed = Math.max(0, total - distanceMeters);
    const pct = Math.round((completed / total) * 100);
    return Math.min(95, Math.max(10, pct));
  }, [isDelivered, distanceMeters, totalDistanceMeters]);

  // Call actions
  const callRider = () => {
    if (!riderPhone) return;
    Linking.openURL(`tel:${riderPhone.replace(/[^+\d]/g, '')}`).catch(() => {});
  };

  const callReceiver = () => {
    if (!receiverPhone) return;
    Linking.openURL(`tel:${receiverPhone.replace(/[^+\d]/g, '')}`).catch(() => {});
  };

  // Status Pill Configuration
  let statusBadge = { label: 'IN TRANSIT', bg: '#E3F2FD', text: '#1565C0', pulse: false };
  if (isDelivered) {
    statusBadge = { label: 'DELIVERED', bg: '#E8F5E9', text: '#2E7D32', pulse: false };
  } else if (isOffRoute) {
    statusBadge = { label: 'OFF ROUTE', bg: '#FFEBEE', text: '#D32F2F', pulse: true };
  } else if (geofenceArrived || deliveryStatus === 'arriving_soon') {
    statusBadge = { label: 'ARRIVING SOON', bg: '#E8F5E9', text: '#2E7D32', pulse: true };
  } else if (signalLost || deliveryStatus === 'signal_lost') {
    statusBadge = { label: 'SIGNAL LOST', bg: '#FFF3E0', text: '#E65100', pulse: false };
  }

  // Battery status helper
  const isBatteryLow = batteryLevel != null && batteryLevel < 20;
  const isBatteryCritical = batteryLevel != null && batteryLevel < 10;

  return (
    <View style={[styles.container, expanded && styles.containerExpanded]}>
      {/* ─── Collapsed / Header Bar (Tap to toggle) ─────────────────────────── */}
      <TouchableOpacity
        style={styles.headerBar}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.88}
      >
        <View style={styles.headerLeft}>
          <Animated.View
            style={[
              styles.liveDot,
              statusBadge.pulse && { opacity: pulseAnim },
              { backgroundColor: statusBadge.text },
            ]}
          />
          <View style={styles.headerEtaBlock}>
            {etaData ? (
              <Text style={styles.headerEtaText} numberOfLines={1}>
                Arriving at ~{etaData.arrivalTime} · {etaData.minutesRemaining} min
                {distanceMeters ? ` · ${formatDistance(distanceMeters)}` : ''}
              </Text>
            ) : (
              <Text style={styles.headerEtaText}>🛵 Live Delivery in Progress</Text>
            )}
          </View>
        </View>

        <View style={styles.headerRight}>
          <View style={[styles.statusPill, { backgroundColor: statusBadge.bg }]}>
            <Text style={[styles.statusPillText, { color: statusBadge.text }]}>
              {statusBadge.label}
            </Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={20}
            color="#78909C"
            style={{ marginLeft: 4 }}
          />
        </View>
      </TouchableOpacity>

      {/* ─── Expanded View ─────────────────────────────────────────────────── */}
      {expanded && (
        <ScrollView style={styles.expandedBody} showsVerticalScrollIndicator={false}>
          {/* Critical Battery Banner */}
          {isBatteryCritical && (
            <View style={styles.criticalAlertBanner}>
              <Ionicons name="battery-dead" size={16} color="#D32F2F" />
              <Text style={styles.criticalAlertText}>
                ⚠️ Rider battery critical ({batteryLevel}%) — tracking may drop soon
              </Text>
            </View>
          )}

          {/* Row 1: Rider Info */}
          <View style={styles.riderRow}>
            <View style={styles.riderLeft}>
              <Text style={styles.riderIcon}>🛵</Text>
              <View>
                <Text style={styles.riderName}>{riderName || 'Assigned Delivery Partner'}</Text>
                <Text style={styles.riderMetaText}>
                  Last update: {secondsAgo < 5 ? 'Just now' : `${secondsAgo}s ago`}
                  {speedKmh ? ` · ⚡ ${speedKmh} km/h` : ''}
                </Text>
              </View>
            </View>

            <View style={styles.riderRight}>
              {batteryLevel != null && (
                <View style={styles.batteryBadge}>
                  <Ionicons
                    name={isBatteryLow ? 'battery-dead' : 'battery-charging'}
                    size={16}
                    color={isBatteryLow ? '#D32F2F' : '#2E7D32'}
                  />
                  <Text
                    style={[
                      styles.batteryText,
                      isBatteryLow && { color: '#D32F2F', fontWeight: '800' },
                    ]}
                  >
                    {batteryLevel}%
                  </Text>
                </View>
              )}
              {riderPhone ? (
                <TouchableOpacity style={styles.callSmallBtn} onPress={callRider}>
                  <Ionicons name="call" size={14} color="#fff" />
                  <Text style={styles.callSmallBtnText}>Call</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {/* Row 2: ETA Block + Progress Bar */}
          <View style={styles.etaCardBlock}>
            <View style={styles.etaBlockHeader}>
              <Text style={styles.etaLabel}>Estimated Arrival</Text>
              <Text style={styles.etaValue}>
                {etaData ? `~${etaData.arrivalTime}` : 'Calculating…'}
              </Text>
            </View>

            <View style={styles.progressTrack}>
              <View style={[styles.progressBar, { width: `${progressPercent}%` }]} />
            </View>

            <View style={styles.etaSubRow}>
              <Text style={styles.etaSubText}>
                {etaData ? `${etaData.minutesRemaining} min remaining` : 'Route loading'}
                {distanceMeters ? ` · ${formatDistance(distanceMeters)} to go` : ''}
              </Text>
              <Text style={styles.etaPctText}>{progressPercent}% completed</Text>
            </View>
          </View>

          {/* Row 3: SLA Warning (Conditional) */}
          {isSlaBreached && (
            <View style={styles.slaWarningBanner}>
              <Ionicons name="warning-outline" size={18} color="#E65100" />
              <View style={{ flex: 1 }}>
                <Text style={styles.slaWarningTitle}>
                  ⚠️ May arrive after preferred window ({deliveryWindow})
                </Text>
                <Text style={styles.slaWarningSub}>
                  Expected at ~{etaData?.arrivalTime || 'later than window'}
                </Text>
              </View>
            </View>
          )}

          {/* Row 4: Order Summary */}
          <View style={styles.orderSummaryCard}>
            <View style={styles.summaryRow}>
              <Ionicons name="storefront-outline" size={16} color="#1565C0" />
              <Text style={styles.summaryTitle} numberOfLines={1}>
                Order #{orderNumber} · {shopName}
              </Text>
            </View>
            {landmark ? (
              <View style={styles.summaryRow}>
                <Ionicons name="location-outline" size={16} color="#D32F2F" />
                <Text style={styles.summarySub} numberOfLines={1}>
                  {landmark}
                </Text>
              </View>
            ) : null}
            <View style={styles.summaryRow}>
              <Ionicons name="person-outline" size={16} color="#00796B" />
              <Text style={styles.summarySub}>
                Receiver: {receiverName} {receiverPhone ? `· ${receiverPhone}` : ''}
              </Text>
            </View>
            {deliveryWindow ? (
              <View style={styles.summaryRow}>
                <Ionicons name="time-outline" size={16} color="#FB8C00" />
                <Text style={styles.summarySub}>Preferred window: {deliveryWindow}</Text>
              </View>
            ) : null}
          </View>

          {/* Row 5: Timeline Strip */}
          <View style={styles.timelineCard}>
            <Text style={styles.timelineTitle}>Live Order Timeline</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.timelineScroll}>
              <View style={styles.timelineStrip}>
                <TimelineStep
                  label="Placed"
                  time={timeline?.placed_at}
                  isCompleted={!!timeline?.placed_at}
                  isCurrent={!timeline?.confirmed_at}
                />
                <TimelineConnector isCompleted={!!timeline?.confirmed_at} />
                <TimelineStep
                  label="Confirmed"
                  time={timeline?.confirmed_at}
                  isCompleted={!!timeline?.confirmed_at}
                  isCurrent={!!timeline?.confirmed_at && !timeline?.dispatched_at}
                />
                <TimelineConnector isCompleted={!!timeline?.dispatched_at} />
                <TimelineStep
                  label="Dispatched"
                  time={timeline?.dispatched_at || dispatchedAt}
                  isCompleted={!!timeline?.dispatched_at || !!dispatchedAt}
                  isCurrent={
                    (!!timeline?.dispatched_at || !!dispatchedAt) &&
                    !isDelivered &&
                    !geofenceArrived
                  }
                />
                <TimelineConnector isCompleted={geofenceArrived || isDelivered} />
                <TimelineStep
                  label="In Transit"
                  time={geofenceArrived ? 'Arriving' : etaData?.arrivalTime}
                  isCompleted={geofenceArrived || isDelivered}
                  isCurrent={geofenceArrived && !isDelivered}
                />
                <TimelineConnector isCompleted={isDelivered} />
                <TimelineStep
                  label="Delivered"
                  time={timeline?.delivered_at}
                  isCompleted={isDelivered}
                  isCurrent={isDelivered}
                />
              </View>
            </ScrollView>
          </View>

          {/* Row 6: Action Buttons */}
          <View style={styles.actionButtonsRow}>
            {riderPhone ? (
              <TouchableOpacity style={styles.actionBtnPrimary} onPress={callRider}>
                <Ionicons name="call" size={16} color="#fff" />
                <Text style={styles.actionBtnText}>Call Rider</Text>
              </TouchableOpacity>
            ) : null}

            {receiverPhone ? (
              <TouchableOpacity style={styles.actionBtnSecondary} onPress={callReceiver}>
                <Ionicons name="person" size={16} color="#1565C0" />
                <Text style={styles.actionBtnSecondaryText}>Call Receiver</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              style={styles.actionBtnOutline}
              onPress={() => setShowDetailsModal(true)}
            >
              <Ionicons name="document-text-outline" size={16} color="#37474F" />
              <Text style={styles.actionBtnOutlineText}>Order Details</Text>
            </TouchableOpacity>
          </View>

          {/* Row 7: Admin Ops Notes */}
          {adminNotes ? (
            <View style={styles.opsNotesBox}>
              <Ionicons name="lock-closed" size={14} color="#78909C" />
              <Text style={styles.opsNotesText}>Ops note: {adminNotes}</Text>
            </View>
          ) : null}

          {/* Row 8: Delivery Proof Photo (Phase 2 Hook) */}
          {proof?.photo_url ? (
            <View style={styles.proofSection}>
              <Text style={styles.proofSectionTitle}>Delivery Proof Photo</Text>
              <TouchableOpacity
                style={styles.proofCardWrapper}
                onPress={() => setShowPhotoModal(true)}
                activeOpacity={0.85}
              >
                <Image
                  source={{ uri: proof.photo_url }}
                  style={styles.proofThumbnail}
                  resizeMode="cover"
                />
                <View style={styles.proofOverlay}>
                  <Ionicons name="expand" size={16} color="#FFFFFF" />
                  <Text style={styles.proofOverlayText}>View Full Photo</Text>
                </View>
              </TouchableOpacity>
              <Text style={styles.proofTimestampText}>
                Captured: {formatTimeString(proof.captured_at)}
              </Text>
              {proof.notes ? (
                <Text style={styles.proofNotesText}>Note: {proof.notes}</Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}

      {/* ─── Full-Screen Delivery Proof Modal ───────────────────────────────── */}
      <Modal
        visible={showPhotoModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowPhotoModal(false)}
      >
        <View style={styles.photoModalOverlay}>
          <TouchableOpacity
            style={styles.photoModalCloseBtn}
            onPress={() => setShowPhotoModal(false)}
            activeOpacity={0.8}
          >
            <Ionicons name="close" size={28} color="#FFFFFF" />
          </TouchableOpacity>
          {proof?.photo_url ? (
            <View style={styles.photoModalContainer}>
              <Image
                source={{ uri: proof.photo_url }}
                style={styles.photoModalImage}
                resizeMode="contain"
              />
              <View style={styles.photoModalFooter}>
                <Text style={styles.photoModalShopName}>{shopName}</Text>
                <Text style={styles.photoModalTime}>
                  Proof recorded at {formatTimeString(proof.captured_at)}
                </Text>
                {proof.notes ? (
                  <Text style={styles.photoModalNotes}>Note: {proof.notes}</Text>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      </Modal>

      {/* ─── Order Details Modal ───────────────────────────────────────────── */}
      <Modal visible={showDetailsModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Order #{orderNumber} Details</Text>
              <TouchableOpacity
                onPress={() => setShowDetailsModal(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={22} color="#37474F" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalBody}>
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Customer & Shop</Text>
                <Text style={styles.modalRowText}>🏪 {shopName}</Text>
                {gstin ? <Text style={styles.modalRowText}>📑 GSTIN: {gstin}</Text> : null}
                <Text style={styles.modalRowText}>👤 Receiver: {receiverName} ({receiverPhone || 'No phone'})</Text>
                <Text style={styles.modalRowText}>📍 Landmark: {landmark || 'N/A'}</Text>
                {paymentMode ? <Text style={styles.modalRowText}>💳 Payment Mode: {paymentMode.toUpperCase()}</Text> : null}
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Items</Text>
                {(orderItems || []).map((item: any, idx: number) => (
                  <View key={idx} style={styles.modalItemRow}>
                    <Text style={styles.modalItemQty}>{item.qty || item.quantity || 1}x</Text>
                    <Text style={styles.modalItemName} numberOfLines={2}>
                      {item.product_name || item.name || 'Item'}
                    </Text>
                    <Text style={styles.modalItemPrice}>
                      ₹{((item.selling_price || item.price || 0) * (item.qty || item.quantity || 1)).toFixed(2)}
                    </Text>
                  </View>
                ))}
                {grandTotal != null ? (
                  <View style={styles.modalTotalRow}>
                    <Text style={styles.modalTotalLabel}>Grand Total</Text>
                    <Text style={styles.modalTotalValue}>₹{grandTotal.toFixed(2)}</Text>
                  </View>
                ) : null}
              </View>

              {adminNotes ? (
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>Admin / Warehouse Notes</Text>
                  <Text style={styles.modalRowText}>{adminNotes}</Text>
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Timeline Sub-components ─────────────────────────────────────────────────

function TimelineStep({
  label,
  time,
  isCompleted,
  isCurrent,
}: {
  label: string;
  time?: string | null;
  isCompleted: boolean;
  isCurrent: boolean;
}) {
  return (
    <View style={styles.stepContainer}>
      <View
        style={[
          styles.stepDot,
          isCompleted && styles.stepDotCompleted,
          isCurrent && styles.stepDotCurrent,
        ]}
      >
        {isCompleted ? (
          <Ionicons name="checkmark" size={12} color="#fff" />
        ) : (
          <View style={styles.stepDotInner} />
        )}
      </View>
      <Text style={[styles.stepLabel, (isCompleted || isCurrent) && styles.stepLabelActive]}>
        {label}
      </Text>
      <Text style={styles.stepTime}>{formatTimeString(time)}</Text>
    </View>
  );
}

function TimelineConnector({ isCompleted }: { isCompleted: boolean }) {
  return (
    <View style={[styles.stepConnector, isCompleted && styles.stepConnectorCompleted]} />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 16,
    borderWidth: 1,
    borderColor: '#EEEEEE',
    zIndex: 100,
  },
  containerExpanded: {
    maxHeight: '65%',
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    minHeight: 68,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  headerEtaBlock: {
    flex: 1,
  },
  headerEtaText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1A1D20',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  expandedBody: {
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  criticalAlertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFEBEE',
    borderWidth: 1,
    borderColor: '#FFCDD2',
    padding: 8,
    borderRadius: 8,
    marginBottom: 10,
    gap: 6,
  },
  criticalAlertText: {
    color: '#D32F2F',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  riderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8FAFC',
    padding: 12,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  riderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  riderIcon: {
    fontSize: 22,
  },
  riderName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1E293B',
  },
  riderMetaText: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  riderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  batteryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  batteryText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
  },
  callSmallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1565C0',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    gap: 4,
  },
  callSmallBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  etaCardBlock: {
    backgroundColor: '#F0F7FF',
    padding: 12,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#D0E4FF',
  },
  etaBlockHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  etaLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#546E7A',
  },
  etaValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1565C0',
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#E1ECF9',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#1565C0',
    borderRadius: 4,
  },
  etaSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  etaSubText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
  },
  etaPctText: {
    fontSize: 11,
    color: '#1565C0',
    fontWeight: '700',
  },
  slaWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFE082',
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    gap: 8,
  },
  slaWarningTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#E65100',
  },
  slaWarningSub: {
    fontSize: 11,
    color: '#F57C00',
    marginTop: 1,
  },
  orderSummaryCard: {
    backgroundColor: '#FAFAFA',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#EEEEEE',
    marginBottom: 10,
    gap: 6,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1A1D20',
    flex: 1,
  },
  summarySub: {
    fontSize: 12,
    color: '#424242',
    flex: 1,
  },
  timelineCard: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#EEEEEE',
    marginBottom: 12,
  },
  timelineTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#37474F',
    marginBottom: 10,
  },
  timelineScroll: {
    paddingBottom: 4,
  },
  timelineStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  stepContainer: {
    alignItems: 'center',
    width: 68,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  stepDotCompleted: {
    backgroundColor: '#2E7D32',
  },
  stepDotCurrent: {
    backgroundColor: '#1565C0',
  },
  stepDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
  stepLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#9E9E9E',
    textAlign: 'center',
  },
  stepLabelActive: {
    color: '#212121',
    fontWeight: '700',
  },
  stepTime: {
    fontSize: 9,
    color: '#757575',
    marginTop: 1,
  },
  stepConnector: {
    width: 24,
    height: 2,
    backgroundColor: '#E0E0E0',
    marginBottom: 18,
  },
  stepConnectorCompleted: {
    backgroundColor: '#2E7D32',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  actionBtnPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 11,
    borderRadius: 10,
    gap: 6,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  actionBtnSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E3F2FD',
    paddingVertical: 11,
    borderRadius: 10,
    gap: 6,
    borderWidth: 1,
    borderColor: '#BBDEFB',
  },
  actionBtnSecondaryText: {
    color: '#1565C0',
    fontSize: 12,
    fontWeight: '700',
  },
  actionBtnOutline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFAFA',
    paddingVertical: 11,
    borderRadius: 10,
    gap: 6,
    borderWidth: 1,
    borderColor: '#CFD8DC',
  },
  actionBtnOutlineText: {
    color: '#37474F',
    fontSize: 12,
    fontWeight: '700',
  },
  opsNotesBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#ECEFF1',
    padding: 8,
    borderRadius: 8,
  },
  opsNotesText: {
    fontSize: 11,
    color: '#455A64',
    fontStyle: 'italic',
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1D20',
  },
  modalCloseBtn: {
    padding: 4,
  },
  modalBody: {
    paddingBottom: 24,
  },
  modalSection: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  modalSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1565C0',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  modalRowText: {
    fontSize: 13,
    color: '#37474F',
    marginBottom: 4,
  },
  modalItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  modalItemQty: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1565C0',
    width: 32,
  },
  modalItemName: {
    fontSize: 13,
    color: '#263238',
    flex: 1,
    paddingHorizontal: 6,
  },
  modalItemPrice: {
    fontSize: 13,
    fontWeight: '700',
    color: '#37474F',
  },
  modalTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#CFD8DC',
  },
  modalTotalLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1A1D20',
  },
  modalTotalValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1565C0',
  },
  proofSection: {
    marginTop: 12,
    backgroundColor: '#F8FAFC',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  proofSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#334155',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  proofCardWrapper: {
    position: 'relative',
    width: 140,
    height: 100,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#0F172A',
    marginBottom: 6,
  },
  proofThumbnail: {
    width: '100%',
    height: '100%',
  },
  proofOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  proofOverlayText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  proofTimestampText: {
    fontSize: 11,
    color: '#64748B',
  },
  proofNotesText: {
    fontSize: 11,
    color: '#0F766E',
    fontStyle: 'italic',
    marginTop: 2,
  },
  photoModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  photoModalCloseBtn: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 20,
    padding: 6,
  },
  photoModalContainer: {
    width: '100%',
    maxHeight: '80%',
    alignItems: 'center',
  },
  photoModalImage: {
    width: '100%',
    height: 380,
    borderRadius: 12,
  },
  photoModalFooter: {
    marginTop: 16,
    alignItems: 'center',
  },
  photoModalShopName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  photoModalTime: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  photoModalNotes: {
    color: '#38BDF8',
    fontSize: 13,
    marginTop: 6,
  },
});
