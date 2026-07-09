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
  if (!MAPS_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.[0]) return null;
  return parseGeocodeResult(json.results[0]);
}

export async function geocodePincode(pincode: string): Promise<GeocodeResult | null> {
  if (!MAPS_KEY || pincode.length !== 6) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    pincode,
  )}&components=country:IN&key=${MAPS_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.[0]) return null;
  return parseGeocodeResult(json.results[0]);
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!MAPS_KEY || !address || address.trim() === '') return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    address,
  )}&key=${MAPS_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.[0]) return null;
  return parseGeocodeResult(json.results[0]);
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
