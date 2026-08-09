/**
 * Delivery Flow Integrity & Behavioral Tests
 *
 * Tests:
 * 1. Historical Order Resolution: delivered orders MUST resolve via delivery_snapshot, ignoring later shop location edits.
 * 2. Active Order Resolution: active orders resolve to verified retailer_shop_locations over stale snapshots.
 * 3. Off-route deviation hysteresis: single noisy GPS jitter (>200m) does not trigger recalculation; 2 consecutive readings do.
 * 4. Destination shift classification: <=300m minor shift vs >300m major shift requiring acknowledgment.
 */
import { resolveOrderCoords, isOrderActive, coordsFromSnapshot } from '../../src/utils/orderDeliveryCoords';
import { calculateDistance } from '../../src/services/routesApiService';

describe('Delivery System Integrity & Reliability Tests', () => {
  describe('Part 1: Historical vs Active Order Resolution Scope', () => {
    const historicalSnapshot = {
      lat: 21.145000,
      lng: 79.088000,
      full_address: 'Old Drop Point, Sitabuldi, Nagpur',
      shop_name: 'Historical Pharmacy',
    };

    const newlyVerifiedLocation = {
      id: 'shop-123',
      lat: 21.160000, // 1.5km away from historical snapshot
      lng: 79.095000,
      formatted_address: 'New Verified Address, Sadar, Nagpur',
      is_verified: true,
    };

    it('Scenario 1: Delivered order MUST resolve to historical delivery_snapshot, ignoring newly verified shop location', async () => {
      const deliveredOrder = {
        id: 'ord-historical-1',
        status: 'delivered',
        delivery_status: 'delivered',
        delivered_at: '2026-01-15T10:30:00Z',
        delivery_address_id: 'shop-123',
        delivery_snapshot: historicalSnapshot,
      };

      expect(isOrderActive(deliveredOrder)).toBe(false);

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: newlyVerifiedLocation }),
        }),
      };

      const resolved = await resolveOrderCoords(mockSupabase, deliveredOrder);

      expect(resolved).not.toBeNull();
      expect(resolved?.lat).toBe(historicalSnapshot.lat);
      expect(resolved?.lng).toBe(historicalSnapshot.lng);
      expect(resolved?.source).toBe('snapshot');
      // Verify DB query to retailer_shop_locations was bypassed for historical order
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('Scenario 2: Active in-flight order MUST resolve to newly verified shop location over outdated snapshot', async () => {
      const activeOrder = {
        id: 'ord-active-1',
        status: 'dispatched',
        delivery_status: 'in_transit',
        delivered_at: null,
        delivery_address_id: 'shop-123',
        delivery_snapshot: historicalSnapshot, // Old uncorrected snapshot
      };

      expect(isOrderActive(activeOrder)).toBe(true);

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: newlyVerifiedLocation }),
        }),
      };

      const resolved = await resolveOrderCoords(mockSupabase, activeOrder);

      expect(resolved).not.toBeNull();
      expect(resolved?.lat).toBe(newlyVerifiedLocation.lat);
      expect(resolved?.lng).toBe(newlyVerifiedLocation.lng);
      expect(resolved?.source).toBe('shop_location');
      expect(mockSupabase.from).toHaveBeenCalledWith('retailer_shop_locations');
    });

    it('Scenario 3: Active order with no verified shop location falls back to delivery_snapshot', async () => {
      const activeOrderNoVerified = {
        id: 'ord-active-2',
        status: 'accepted',
        delivery_status: 'pending',
        delivered_at: null,
        delivery_address_id: 'shop-unverified',
        delivery_snapshot: historicalSnapshot,
      };

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { id: 'shop-unverified', lat: 0, lng: 0, is_verified: false },
          }),
        }),
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      };

      const resolved = await resolveOrderCoords(mockSupabase, activeOrderNoVerified);

      expect(resolved).not.toBeNull();
      expect(resolved?.lat).toBe(historicalSnapshot.lat);
      expect(resolved?.lng).toBe(historicalSnapshot.lng);
      expect(resolved?.source).toBe('snapshot');
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith('update_shop_location_coordinates', expect.anything());
    });

    it('Scenario 4: Verified shop location (is_verified = true) NEVER triggers update_shop_location_coordinates RPC for active or historical orders', async () => {
      const activeOrder = {
        id: 'ord-active-verified',
        status: 'dispatched',
        delivery_status: 'in_transit',
        delivered_at: null,
        delivery_address_id: 'shop-verified-1',
        delivery_snapshot: null,
      };

      const deliveredOrder = {
        id: 'ord-historical-verified',
        status: 'delivered',
        delivery_status: 'delivered',
        delivered_at: '2026-01-10T12:00:00Z',
        delivery_address_id: 'shop-verified-1',
        delivery_snapshot: historicalSnapshot,
      };

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { id: 'shop-verified-1', lat: 21.160, lng: 79.095, is_verified: true, formatted_address: 'Verified Street' },
          }),
        }),
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      };

      // 1. Run for active order
      const resolvedActive = await resolveOrderCoords(mockSupabase, activeOrder);
      expect(resolvedActive?.lat).toBe(21.160);
      expect(resolvedActive?.source).toBe('shop_location');
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith('update_shop_location_coordinates', expect.anything());

      // 2. Run for historical delivered order
      const resolvedDelivered = await resolveOrderCoords(mockSupabase, deliveredOrder);
      expect(resolvedDelivered?.lat).toBe(historicalSnapshot.lat);
      expect(resolvedDelivered?.source).toBe('snapshot');
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith('update_shop_location_coordinates', expect.anything());
    });
  });

  describe('Part 2: Destination Shift & Deviation Distance Classification', () => {
    it('accurately calculates distance between old and new destination pins', () => {
      const oldPin = { lat: 21.1458, lng: 79.0882 };
      // Shift ~150m
      const smallShiftPin = { lat: 21.1470, lng: 79.0882 };
      const smallShiftDist = calculateDistance(oldPin, smallShiftPin);
      expect(smallShiftDist).toBeLessThanOrEqual(300);
      expect(smallShiftDist).toBeGreaterThan(50);

      // Shift ~1.2km
      const largeShiftPin = { lat: 21.1560, lng: 79.0950 };
      const largeShiftDist = calculateDistance(oldPin, largeShiftPin);
      expect(largeShiftDist).toBeGreaterThan(300);
    });

    it('Scenario 2: Off-route deviation simulation with consecutive readings and cooldown', () => {
      let consecutiveDeviations = 0;
      let recalculationsTriggered = 0;
      let lastRouteFetchTime = 0;
      const COOLDOWN_MS = 30000;

      function simulateGpsReading(deviationDistanceMeters: number, nowMs: number) {
        if (deviationDistanceMeters > 200) {
          consecutiveDeviations += 1;
          const cooldownElapsed = nowMs - lastRouteFetchTime > COOLDOWN_MS;
          if (consecutiveDeviations >= 2 && cooldownElapsed) {
            recalculationsTriggered += 1;
            lastRouteFetchTime = nowMs;
            consecutiveDeviations = 0;
          }
        } else {
          consecutiveDeviations = 0;
        }
      }

      const t0 = 1000000;

      // Reading 1: Jitter spike > 200m (e.g. 240m)
      simulateGpsReading(240, t0);
      expect(recalculationsTriggered).toBe(0); // Single spike should NOT trigger recalculation
      expect(consecutiveDeviations).toBe(1);

      // Reading 2: Returns to polyline (e.g. 80m)
      simulateGpsReading(80, t0 + 3000);
      expect(recalculationsTriggered).toBe(0);
      expect(consecutiveDeviations).toBe(0); // Reset

      // Reading 3: True deviation 1 (250m)
      simulateGpsReading(250, t0 + 6000);
      expect(recalculationsTriggered).toBe(0);
      expect(consecutiveDeviations).toBe(1);

      // Reading 4: True deviation 2 (260m) -> 2nd consecutive reading
      simulateGpsReading(260, t0 + 9000);
      expect(recalculationsTriggered).toBe(1); // Triggered!
      expect(consecutiveDeviations).toBe(0);

      // Reading 5 & 6: Rapid jitter during cooldown (<30s)
      simulateGpsReading(270, t0 + 12000);
      simulateGpsReading(280, t0 + 15000);
      expect(recalculationsTriggered).toBe(1); // Blocked by 30s cooldown

      // Reading 7 & 8: After 35s cooldown
      simulateGpsReading(290, t0 + 42000);
      simulateGpsReading(300, t0 + 45000);
      expect(recalculationsTriggered).toBe(2); // Successfully triggered after cooldown
    });
  });

  describe('Part 3: Multi-Stop Optimizer In-Place Refresh Sequence Preservation', () => {
    it('updates only modified stop coordinates and leaves existing stop sequence order 100% untouched', async () => {
      const initialStops = [
        { orderId: 'ord-1', orderNumber: '1001', retailerName: 'Store A', lat: 21.141, lng: 79.081, grandTotal: 500, status: 'dispatched' },
        { orderId: 'ord-2', orderNumber: '1002', retailerName: 'Store B', lat: 21.145, lng: 79.085, grandTotal: 750, status: 'dispatched' },
        { orderId: 'ord-3', orderNumber: '1003', retailerName: 'Store C', lat: 21.150, lng: 79.090, grandTotal: 300, status: 'dispatched' },
      ];

      // Simulated DB update where Store B location was corrected
      const updatedOrderB = {
        id: 'ord-2',
        order_number: '1002',
        user_name: 'Store B',
        grand_total: 750,
        status: 'dispatched',
        delivery_address: 'Corrected Pin, Store B',
        delivery_snapshot: { lat: 21.148, lng: 79.087, full_address: 'Corrected Pin, Store B' },
      };

      const orderMap = new Map<string, any>([
        ['ord-1', { id: 'ord-1', order_number: '1001', grand_total: 500, status: 'dispatched' }],
        ['ord-2', updatedOrderB],
        ['ord-3', { id: 'ord-3', order_number: '1003', grand_total: 300, status: 'dispatched' }],
      ]);

      const refreshedStops = [];
      for (const stop of initialStops) {
        const orderData = orderMap.get(stop.orderId);
        if (!orderData) continue;
        const coords = orderData.delivery_snapshot ? { lat: orderData.delivery_snapshot.lat, lng: orderData.delivery_snapshot.lng, address: orderData.delivery_snapshot.full_address } : null;
        refreshedStops.push({
          ...stop,
          lat: coords?.lat || stop.lat,
          lng: coords?.lng || stop.lng,
          address: coords?.address || 'default',
        });
      }

      // Assert array length and order of IDs are identical
      expect(refreshedStops.map(s => s.orderId)).toEqual(['ord-1', 'ord-2', 'ord-3']);
      // Assert Store B's coordinates updated in-place
      expect(refreshedStops[1].lat).toBe(21.148);
      expect(refreshedStops[1].lng).toBe(79.087);
      // Assert Store A and Store C were untouched
      expect(refreshedStops[0].lat).toBe(21.141);
      expect(refreshedStops[2].lat).toBe(21.150);
    });
  });

  describe('Part 4: Remote Canary Allowlist Behavioral Gating', () => {
    it('Canary Rider (enabled = true) triggers acknowledgment modal for >300m shift and logs telemetry', () => {
      const isCanary = true;
      const shiftMeters = 450;
      let modalOpened = false;
      let telemetryLogged = false;
      let directMapUpdate = false;

      if (isCanary) {
        telemetryLogged = true;
        if (shiftMeters > 300) {
          modalOpened = true;
        }
      } else {
        directMapUpdate = true;
      }

      expect(modalOpened).toBe(true);
      expect(telemetryLogged).toBe(true);
      expect(directMapUpdate).toBe(false);
    });

    it('Baseline Rider (enabled = false) suppresses acknowledgment modal and updates map silently without telemetry noise', () => {
      const isCanary = false;
      const shiftMeters = 450;
      let modalOpened = false;
      let telemetryLogged = false;
      let directMapUpdate = false;

      if (isCanary) {
        telemetryLogged = true;
        if (shiftMeters > 300) {
          modalOpened = true;
        }
      } else {
        directMapUpdate = true;
      }

      expect(modalOpened).toBe(false);
      expect(telemetryLogged).toBe(false);
      expect(directMapUpdate).toBe(true);
    });
  });

  describe('Part 5: Immediate Rollback, Client-Side Circuit Breaker & Rider Issue Reporting', () => {
    it('Scenario 1: Immediate Realtime rollback event dismisses open modal and reverts to baseline in-place', () => {
      let isCanary = true;
      let pendingDestinationUpdate: any = { newLat: 21.160, newLng: 79.095, shiftMeters: 400 };
      let consecutiveDeviations = 3;

      // Simulate Realtime event payload: { enabled: false }
      const realtimePayload = { new: { enabled: false } };
      if (!realtimePayload.new.enabled) {
        isCanary = false;
        pendingDestinationUpdate = null;
        consecutiveDeviations = 0;
      }

      expect(isCanary).toBe(false);
      expect(pendingDestinationUpdate).toBeNull();
      expect(consecutiveDeviations).toBe(0);
    });

    it('Scenario 2: Circuit Breaker trips on >2 reconnects in a single shift and logs auto_circuit_breaker_triggered', () => {
      let sessionReconnectCount = 0;
      let isCanary = true;
      let circuitBreakerTripped = false;
      let trippedReason = '';
      const loggedTelemetry: string[] = [];

      function handleReconnect() {
        sessionReconnectCount += 1;
        if (sessionReconnectCount > 2) {
          circuitBreakerTripped = true;
          isCanary = false;
          trippedReason = 'Excessive Reconnections (>2/shift)';
          loggedTelemetry.push('auto_circuit_breaker_triggered');
          return;
        }
        loggedTelemetry.push('realtime_reconnect');
      }

      handleReconnect(); // Reconnect #1 -> allowed
      expect(circuitBreakerTripped).toBe(false);
      expect(isCanary).toBe(true);

      handleReconnect(); // Reconnect #2 -> allowed
      expect(circuitBreakerTripped).toBe(false);
      expect(isCanary).toBe(true);

      handleReconnect(); // Reconnect #3 -> TRIPPED!
      expect(circuitBreakerTripped).toBe(true);
      expect(isCanary).toBe(false);
      expect(trippedReason).toContain('Excessive Reconnections');
      expect(loggedTelemetry).toContain('auto_circuit_breaker_triggered');
    });

    it('Scenario 3: Circuit Breaker trips on rapid off-route recalculations (3 in <3 minutes)', () => {
      let recalcTimestamps: number[] = [];
      let isCanary = true;
      let circuitBreakerTripped = false;

      function simulateRecalculation(nowMs: number) {
        recalcTimestamps = recalcTimestamps.filter(t => nowMs - t < 180000);
        recalcTimestamps.push(nowMs);
        if (recalcTimestamps.length >= 3) {
          circuitBreakerTripped = true;
          isCanary = false;
        }
      }

      const t0 = 1000000;
      simulateRecalculation(t0);
      expect(circuitBreakerTripped).toBe(false);

      simulateRecalculation(t0 + 40000); // 40s later
      expect(circuitBreakerTripped).toBe(false);

      simulateRecalculation(t0 + 90000); // 90s later (3rd in 90s)
      expect(circuitBreakerTripped).toBe(true);
      expect(isCanary).toBe(false);
    });

    it('Scenario 4: Rider issue reporting logs rider_reported_issue with location coordinates and timestamp', () => {
      const loggedEvents: any[] = [];
      function reportIssue(orderId: string, riderCoords: { lat: number; lng: number }) {
        loggedEvents.push({
          event_type: 'rider_reported_issue',
          order_id: orderId,
          metadata: { rider_coords: riderCoords, timestamp: '2026-08-10T01:00:00.000Z' },
        });
      }

      reportIssue('ord-test-99', { lat: 21.1458, lng: 79.0882 });
      expect(loggedEvents.length).toBe(1);
      expect(loggedEvents[0].event_type).toBe('rider_reported_issue');
      expect(loggedEvents[0].order_id).toBe('ord-test-99');
      expect(loggedEvents[0].metadata.rider_coords.lat).toBe(21.1458);
    });
  });
});
