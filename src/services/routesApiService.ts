/**
 * Routes API Service
 *
 * Multi-tier routing engine:
 * Tier 1 (Primary): OSRM Public Server (router.project-osrm.org)
 * Tier 2 (Secondary): Google Routes API v2 (only if OSRM returns error and key is set)
 * Tier 3 (Tertiary): OSRM Secondary Mirror (routing.openstreetmap.de)
 * Tier 4 (Fallback): Direct street-interpolated straight path (100% offline guaranteed)
 */
import { getGoogleMapsApiKey } from './googleMapsApi';
import { supabase } from './supabase';
import type { RouteResult } from '../types';

export type { RouteResult };

export interface LatLng {
  lat: number;
  lng: number;
}

export type LatLngInput = { lat: number; lng: number } | { latitude: number; longitude: number };

export const THAKKAR_MEDICO = {
  name: 'Thakkar Medico',
  address: 'Sandesh Dawa Bazar, Ganjipeth, Nagpur - 440018',
  lat: 21.150167,
  lng: 79.099140,
} as const;

export const OSRM_BASE = (
  process.env.EXPO_PUBLIC_OSRM_ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving'
).replace(/\/+$/, '');

export const OSRM_MIRROR = (
  process.env.EXPO_PUBLIC_OSRM_MIRROR_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving'
).replace(/\/+$/, '');

const TIMEOUT_MS = 4000; // 4s timeout per routing call

/**
 * Asynchronously record routing latency or fallback event in telemetry table.
 */
function recordRoutingTelemetry(tier: string, latencyMs: number, success: boolean, meta?: any): void {
  try {
    void supabase.from('delivery_telemetry_events').insert({
      event_type: success ? 'routing_success' : 'routing_fallback',
      metadata: {
        tier,
        latency_ms: latencyMs,
        success,
        ...meta,
      },
    });
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Returns the primary configured routing endpoint.
 */
export function getRoutingEndpoint(): string {
  return OSRM_BASE;
}

function normalizeLatLng(p: LatLngInput): LatLng {
  if ('latitude' in p && 'longitude' in p) {
    return { lat: p.latitude, lng: p.longitude };
  }
  return { lat: (p as any).lat, lng: (p as any).lng };
}

/**
 * Fetch route between origin and destination.
 * OSRM Primary -> Google Routes fallback -> OSRM Mirror -> Direct fallback.
 */
export async function fetchRoute(
  originInput: LatLngInput,
  destinationInput: LatLngInput,
): Promise<RouteResult | null> {
  const origin = normalizeLatLng(originInput);
  const destination = normalizeLatLng(destinationInput);

  // Validate coordinates
  if (
    !Number.isFinite(origin.lat) ||
    !Number.isFinite(origin.lng) ||
    !Number.isFinite(destination.lat) ||
    !Number.isFinite(destination.lng) ||
    (origin.lat === 0 && origin.lng === 0) ||
    (destination.lat === 0 && destination.lng === 0)
  ) {
    return null;
  }

  const startT = Date.now();

  // Tier 1: Primary OSRM
  try {
    const osrmResult = await fetchOsrm(OSRM_BASE, origin, destination, 'osrm');
    const elapsed = Date.now() - startT;
    if (osrmResult && osrmResult.polylineCoords.length > 0) {
      if (elapsed > 2000) {
        recordRoutingTelemetry('osrm_primary', elapsed, true, { note: 'slow_p95' });
      }
      return osrmResult;
    }
  } catch (err) {
    console.warn('[RoutesAPI] Primary OSRM failed:', err);
    recordRoutingTelemetry('osrm_primary', Date.now() - startT, false, { error: String(err) });
  }

  // Tier 2: Google Routes API v2 fallback (if key is configured)
  const apiKey = getGoogleMapsApiKey();
  if (apiKey) {
    const gStart = Date.now();
    try {
      const googleResult = await fetchGoogleRoute(origin, destination, apiKey);
      if (googleResult && googleResult.polylineCoords.length > 0) {
        recordRoutingTelemetry('google_routes', Date.now() - gStart, true);
        return googleResult;
      }
    } catch (err) {
      console.warn('[RoutesAPI] Google Routes fallback failed:', err);
      recordRoutingTelemetry('google_routes', Date.now() - gStart, false, { error: String(err) });
    }
  }

  // Tier 3: Secondary OSRM Mirror (OSM Germany)
  const mStart = Date.now();
  try {
    const mirrorResult = await fetchOsrm(OSRM_MIRROR, origin, destination, 'osrm_mirror');
    if (mirrorResult && mirrorResult.polylineCoords.length > 0) {
      recordRoutingTelemetry('osrm_mirror', Date.now() - mStart, true);
      return mirrorResult;
    }
  } catch (err) {
    console.warn('[RoutesAPI] Secondary OSRM mirror failed:', err);
    recordRoutingTelemetry('osrm_mirror', Date.now() - mStart, false, { error: String(err) });
  }

  // Tier 4: Direct Straight-line Fallback with road estimation
  recordRoutingTelemetry('direct_fallback', Date.now() - startT, true, { note: 'all_apis_exhausted' });
  return generateDirectFallbackRoute(origin, destination);
}

/**
 * Format duration in seconds to structured ETA object.
 * minutesRemaining: Math.ceil(durationSeconds / 60)
 * arrivalTime: e.g. "11:42 AM"
 */
export function formatETA(durationSeconds: number): {
  minutesRemaining: number;
  arrivalTime: string;
} {
  const minutesRemaining = Math.max(1, Math.ceil(durationSeconds / 60));
  const arrivalDate = new Date(Date.now() + durationSeconds * 1000);

  let arrivalTime = '';
  try {
    arrivalTime = arrivalDate.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    const h = arrivalDate.getHours();
    const m = arrivalDate.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    arrivalTime = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  return { minutesRemaining, arrivalTime };
}

/**
 * Calculate Haversine distance in meters between two lat/lng points.
 */
export function calculateDistance(aInput: LatLngInput, bInput: LatLngInput): number {
  const a = normalizeLatLng(aInput);
  const b = normalizeLatLng(bInput);
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export const distanceBetween = calculateDistance;

// =============================================================================
// Helper Implementations
// =============================================================================

async function fetchOsrm(
  baseUrl: string,
  origin: LatLng,
  destination: LatLng,
  source: 'osrm' | 'osrm_mirror',
): Promise<RouteResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const url = `${baseUrl}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=false`;

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return null;
    }

    const route = data.routes[0];
    const polylineCoords: [number, number][] = (route.geometry?.coordinates || []).map(
      ([lng, lat]: [number, number]) => [lat, lng] as [number, number],
    );

    return {
      durationSeconds: Math.round(route.duration || 0),
      distanceMeters: Math.round(route.distance || 0),
      polylineCoords,
      source,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchGoogleRoute(
  origin: LatLng,
  destination: LatLng,
  apiKey: string,
): Promise<RouteResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body = {
    origin: {
      location: {
        latLng: {
          latitude: origin.lat,
          longitude: origin.lng,
        },
      },
    },
    destination: {
      location: {
        latLng: {
          latitude: destination.lat,
          longitude: destination.lng,
        },
      },
    },
    travelMode: 'TWO_WHEELER',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    polylineEncoding: 'GEO_JSON_LINESTRING',
  };

  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) return null;

    const json = await response.json();
    const route = json.routes?.[0];
    if (!route) return null;

    const durationStr = route.duration || '0s';
    const durationSeconds = parseInt(durationStr.replace('s', ''), 10) || 0;
    const distanceMeters = route.distanceMeters || 0;

    let polylineCoords: [number, number][] = [];
    const geoJson = route.polyline?.geoJsonLinestring;
    if (geoJson?.coordinates) {
      polylineCoords = geoJson.coordinates.map(
        ([lng, lat]: [number, number]) => [lat, lng] as [number, number],
      );
    }

    return {
      durationSeconds,
      distanceMeters,
      polylineCoords,
      source: 'google_routes',
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

function generateDirectFallbackRoute(origin: LatLng, destination: LatLng): RouteResult {
  const straightDistM = calculateDistance(origin, destination);
  // In city traffic, realistic road distance is ~1.3x straight-line
  const roadDistM = Math.round(straightDistM * 1.3);
  // Average 25 km/h city riding speed
  const speedMps = (25 * 1000) / 3600;
  const durationSeconds = Math.max(30, Math.round(roadDistM / speedMps));

  return {
    durationSeconds,
    distanceMeters: roadDistM,
    polylineCoords: [
      [origin.lat, origin.lng],
      [destination.lat, destination.lng],
    ],
    source: 'direct_fallback',
  };
}
