/**
 * ETA calculation utilities for delivery tracking.
 *
 * Uses Haversine formula for distance + speed-based time estimation.
 * Falls back to straight-line distance at a conservative average speed
 * when live speed data is unavailable.
 */

const EARTH_RADIUS_KM = 6371;
const DEFAULT_CITY_SPEED_KMH = 25; // Conservative avg for Indian city roads

/** Convert degrees to radians. */
function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Haversine distance between two GPS coordinates.
 * @returns Distance in kilometres
 */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate ETA in seconds from current position to destination.
 *
 * @param driverLat   Driver's current latitude
 * @param driverLng   Driver's current longitude
 * @param destLat     Destination latitude
 * @param destLng     Destination longitude
 * @param speedKmh    Current speed in km/h (if available from GPS)
 * @returns Estimated time in seconds, or null if inputs are invalid
 */
export function calculateETA(
  driverLat: number,
  driverLng: number,
  destLat: number,
  destLng: number,
  speedKmh?: number | null,
): number | null {
  if (
    !isFinite(driverLat) ||
    !isFinite(driverLng) ||
    !isFinite(destLat) ||
    !isFinite(destLng)
  ) {
    return null;
  }

  const distKm = haversineDistanceKm(driverLat, driverLng, destLat, destLng);

  // Too close — already there
  if (distKm < 0.05) return 0; // < 50 metres

  // Road distance is roughly 1.3× straight-line (city road factor)
  const roadDistKm = distKm * 1.3;

  // Use live speed if available and reasonable (> 3 km/h), otherwise fallback
  const effectiveSpeed =
    speedKmh && speedKmh > 3 ? speedKmh : DEFAULT_CITY_SPEED_KMH;

  const etaHours = roadDistKm / effectiveSpeed;
  return Math.round(etaHours * 3600);
}

/**
 * Format ETA seconds into a human-readable string.
 * @param seconds  ETA in seconds
 * @returns  e.g. "8 min", "1 hr 12 min", "< 1 min"
 */
export function formatETA(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) {
    return '—';
  }
  if (seconds <= 0) return 'Arrived';
  if (seconds < 60) return '< 1 min';

  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;

  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (remainMins === 0) return `${hrs} hr`;
  return `${hrs} hr ${remainMins} min`;
}

/**
 * Check if an order is approaching or past its SLA deadline.
 * @returns 'overdue' | 'at_risk' | 'on_track' | null (no SLA set)
 */
export function getSlaStatus(
  slaDeadline: string | null | undefined,
  warningMinutes: number = 30,
): 'overdue' | 'at_risk' | 'on_track' | null {
  if (!slaDeadline) return null;

  const deadline = new Date(slaDeadline).getTime();
  const now = Date.now();

  if (now > deadline) return 'overdue';
  if (deadline - now < warningMinutes * 60 * 1000) return 'at_risk';
  return 'on_track';
}

/**
 * Format remaining SLA time.
 * @returns e.g. "1h 23m left", "Overdue by 15m"
 */
export function formatSlaCountdown(
  slaDeadline: string | null | undefined,
): string {
  if (!slaDeadline) return '—';

  const deadline = new Date(slaDeadline).getTime();
  const diff = deadline - Date.now();

  if (diff <= 0) {
    const overMins = Math.ceil(Math.abs(diff) / 60000);
    if (overMins < 60) return `Overdue ${overMins}m`;
    return `Overdue ${Math.floor(overMins / 60)}h ${overMins % 60}m`;
  }

  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}
