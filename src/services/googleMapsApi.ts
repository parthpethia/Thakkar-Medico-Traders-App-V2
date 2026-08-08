const MAPS_KEY =
  (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY ||
    '').trim();

export function getGoogleMapsApiKey(): string {
  return MAPS_KEY;
}

export interface GeocodeResult {
  formatted_address: string;
  lat: number;
  lng: number;
  street?: string;
  area?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

function pickComponent(components: any[], type: string): string | undefined {
  const c = components?.find((x) => x.types?.includes(type));
  return c?.long_name;
}

function parseGeocodeResult(result: any): GeocodeResult {
  const components = result.address_components || [];
  return {
    formatted_address: result.formatted_address || '',
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    street:
      pickComponent(components, 'route') ||
      pickComponent(components, 'sublocality_level_2'),
    area:
      pickComponent(components, 'sublocality') ||
      pickComponent(components, 'sublocality_level_1') ||
      pickComponent(components, 'neighborhood'),
    city:
      pickComponent(components, 'locality') ||
      pickComponent(components, 'administrative_area_level_2'),
    state: pickComponent(components, 'administrative_area_level_1'),
    pincode: pickComponent(components, 'postal_code'),
  };
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThakkarMedicoApp/1.0' },
    });
    if (!res.ok) return null;
    const item = await res.json();
    if (!item || !item.address) return null;

    const addr = item.address;
    return {
      formatted_address: item.display_name || '',
      lat,
      lng,
      street: addr.road || addr.suburb || addr.street,
      area: addr.neighbourhood || addr.suburb || addr.city_district,
      city: addr.city || addr.town || addr.state_district || 'Nagpur',
      state: addr.state || 'Maharashtra',
      pincode: addr.postcode,
    };
  } catch (err) {
    console.warn('[ReverseGeocode] Nominatim reverse-geocode error:', err);
    return null;
  }
}

export async function geocodePincode(pincode: string): Promise<GeocodeResult | null> {
  if (pincode.length !== 6) return null;
  if (MAPS_KEY) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        pincode,
      )}&components=country:IN&key=${MAPS_KEY}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        return parseGeocodeResult(json.results[0]);
      }
    } catch {
      /* fallback to OSM */
    }
  }
  return freeGeocodeAddress(`${pincode}, Maharashtra, India`);
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!address || address.trim() === '') return null;
  const trimmed = address.trim();

  if (MAPS_KEY) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        trimmed,
      )}&key=${MAPS_KEY}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        return parseGeocodeResult(json.results[0]);
      }
    } catch {
      /* fallback to OSM */
    }
  }

  // Free fallback via Nominatim / Photon (no API key required)
  return freeGeocodeAddress(trimmed);
}

/**
 * Free geocoding fallback using OpenStreetMap / Nominatim & Photon.
 * Works out-of-the-box in India without needing a Google API key.
 */
export async function freeGeocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!address || address.trim() === '') return null;

  // Clean address for search
  let query = address.trim();
  if (!query.toLowerCase().includes('india') && !query.toLowerCase().includes('nagpur')) {
    query = `${query}, Nagpur, Maharashtra, India`;
  }

  // 1. Try Nominatim (OpenStreetMap)
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query,
    )}&format=json&limit=1&addressdetails=1&countrycodes=in`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThakkarMedicoApp/1.0' },
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const item = data[0];
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const addr = item.address || {};
        return {
          formatted_address: item.display_name || address,
          lat,
          lng,
          street: addr.road || addr.suburb,
          area: addr.neighbourhood || addr.suburb || addr.city_district,
          city: addr.city || addr.town || addr.state_district || 'Nagpur',
          state: addr.state || 'Maharashtra',
          pincode: addr.postcode,
        };
      }
    }
  } catch (err) {
    console.warn('[FreeGeocode] Nominatim failed:', err);
  }

  // 2. Try Photon (Komoot OSM search)
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const feat = data.features[0];
      const [lng, lat] = feat.geometry.coordinates;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const props = feat.properties || {};
        return {
          formatted_address: props.name ? `${props.name}, ${props.city || 'Nagpur'}` : address,
          lat,
          lng,
          street: props.street || props.name,
          city: props.city || 'Nagpur',
          state: props.state || 'Maharashtra',
          pincode: props.postcode,
        };
      }
    }
  } catch (err) {
    console.warn('[FreeGeocode] Photon failed:', err);
  }

  return null;
}

export interface PlaceSuggestion {
  place_id: string;
  description: string;
}

export async function autocompletePlaces(query: string): Promise<PlaceSuggestion[]> {
  if (!MAPS_KEY || query.trim().length < 2) return [];
  const params = new URLSearchParams({
    input: query.trim(),
    key: MAPS_KEY,
    types: 'establishment',
    components: 'country:in',
  });
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') return [];
  return (json.predictions || []).map((p: any) => ({
    place_id: p.place_id,
    description: p.description,
  }));
}

export async function placeDetails(placeId: string): Promise<GeocodeResult | null> {
  if (!MAPS_KEY) return null;
  const params = new URLSearchParams({
    place_id: placeId,
    key: MAPS_KEY,
    fields: 'formatted_address,geometry,address_component,name',
  });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' || !json.result) return null;
  const r = json.result;
  const base = parseGeocodeResult({
    formatted_address: r.formatted_address,
    address_components: r.address_components,
    geometry: r.geometry,
  });
  return base;
}
