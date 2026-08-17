/**
 * RiderMiniMap — Fully Interactive Leaflet Map for the Delivery Person screen.
 *
 * Features:
 * - Full Touch & Gesture Support: Pinch zoom in/out, double-tap zoom, smooth panning
 * - Floating In-Map Quick Controls: Zoom (+ / −), Fit Route (🗺️), Recenter on Rider (🎯)
 * - Rider's current position (blue pulsing pin with heading arrow)
 * - Destination marker (red shop pin)
 * - Active OSRM Route polyline (blue, weight 5)
 * - Navigation to external Google Maps is reserved for the prominent "Navigate" action button
 */
import React, { useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

export interface RiderMiniMapRef {
  updateRiderPosition: (lat: number, lng: number, heading?: number | null) => void;
  updateRouteCoords: (coords: [number, number][]) => void;
  updateDestination: (lat: number, lng: number, shopName?: string, address?: string) => void;
}

export interface RiderMiniMapProps {
  riderLat: number;
  riderLng: number;
  destLat: number;
  destLng: number;
  destShopName?: string;
  destAddress?: string;
  routeCoords?: [number, number][];
  onNavigatePress?: () => void;
}

const RIDER_MINI_MAP_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
  <style>
    html, body, #map {
      margin: 0; padding: 0; height: 100%; width: 100%;
      background: #0F172A;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }

    /* Rider Marker: Animated Blue Pulse */
    .rider-pin-wrap {
      position: relative; width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center;
    }
    .rider-pulse {
      position: absolute; width: 100%; height: 100%;
      border-radius: 50%;
      background: rgba(21, 101, 192, 0.45);
      animation: pulse-ring 2s infinite ease-out;
      pointer-events: none;
    }
    .rider-core {
      position: relative; z-index: 2;
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #1E88E5 0%, #0D47A1 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 4px 14px rgba(13, 71, 161, 0.5);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.35s ease;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.6); opacity: 1; }
      100% { transform: scale(2.3); opacity: 0; }
    }

    /* Destination Marker: Red Shop Pin */
    .dest-pin-wrap {
      position: relative; width: 38px; height: 44px;
      display: flex; flex-direction: column; align-items: center;
    }
    .dest-pin-core {
      width: 34px; height: 34px;
      background: linear-gradient(135deg, #E53935 0%, #B71C1C 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: -2px 4px 12px rgba(183, 28, 28, 0.45);
      display: flex; align-items: center; justify-content: center;
    }
    .dest-icon-inner {
      transform: rotate(45deg);
      font-size: 15px; line-height: 1;
    }

    /* Floating Quick Controls */
    .map-controls-topright {
      position: absolute; top: 12px; right: 12px;
      z-index: 1000; display: flex; flex-direction: column; gap: 8px;
    }
    .map-fab-btn {
      width: 38px; height: 38px;
      background: #FFFFFF; border: 1px solid #CBD5E1;
      border-radius: 10px; box-shadow: 0 3px 10px rgba(0,0,0,0.18);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 800; color: #1E293B;
      cursor: pointer; transition: background 0.15s;
    }
    .map-fab-btn:active {
      background: #E2E8F0;
    }

    /* Leaflet popup card */
    .leaflet-popup-content-wrapper {
      background: #FFFFFF; border-radius: 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.18);
      padding: 0; overflow: hidden;
    }
    .leaflet-popup-content { margin: 0; font-size: 12px; color: #1E293B; }
    .shop-popup-box { padding: 10px 12px; min-width: 160px; }
    .shop-popup-title { font-weight: 800; font-size: 13px; color: #0F172A; margin-bottom: 2px; }
    .shop-popup-addr { font-size: 11px; color: #64748B; line-height: 1.3; }
    .shop-popup-nav-btn {
      display: block; margin-top: 8px; padding: 6px 10px;
      background: #1565C0; color: #FFF; text-align: center;
      border-radius: 6px; font-weight: 700; font-size: 11px;
      cursor: pointer; text-decoration: none;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
</head>
<body>
  <div id="map"></div>

  <!-- In-Map Quick Zoom & Recenter Controls -->
  <div class="map-controls-topright">
    <div class="map-fab-btn" onclick="zoomIn()" title="Zoom In">+</div>
    <div class="map-fab-btn" onclick="zoomOut()" title="Zoom Out">−</div>
    <div class="map-fab-btn" onclick="fitRouteBounds()" title="Fit Route" style="font-size: 15px;">🗺️</div>
    <div class="map-fab-btn" onclick="recenterOnRider()" title="Recenter Rider" style="font-size: 15px;">🎯</div>
  </div>

  <script>
    const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    const TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO';

    let map = null;
    let riderMarker = null;
    let destMarker = null;
    let routeGlowLine = null;
    let routeCoreLine = null;
    let currentRiderPos = null;
    let currentDestPos = null;
    let destShopName = 'Delivery Drop Location';
    let destAddress = '';

    function initMap(rLat, rLng, dLat, dLng, coords, sName, sAddr) {
      if (map) return;

      currentRiderPos = [rLat, rLng];
      currentDestPos = [dLat, dLng];
      if (sName) destShopName = sName;
      if (sAddr) destAddress = sAddr;

      // Interactive map config: full touch gestures, pinch zoom, pan
      map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        touchZoom: true,
        doubleClickZoom: true,
        scrollWheelZoom: true,
        boxZoom: true,
        keyboard: false
      }).setView([rLat, rLng], 15);

      L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

      // Destination Marker
      updateDest(dLat, dLng, destShopName, destAddress);

      // Rider Marker
      createOrUpdateRider(rLat, rLng, 0);

      // Route Polyline
      if (coords && coords.length > 1) {
        updateRoute(coords);
      } else {
        updateRoute([[rLat, rLng], [dLat, dLng]]);
      }

      // Auto-fit initial bounds to show both rider and shop
      fitRouteBounds();

      setTimeout(function() {
        if (map) map.invalidateSize();
      }, 200);

      window.addEventListener('resize', function() {
        if (map) map.invalidateSize();
      });
    }

    function zoomIn() {
      if (map) map.zoomIn();
    }

    function zoomOut() {
      if (map) map.zoomOut();
    }

    function recenterOnRider() {
      if (map && currentRiderPos) {
        map.setView(currentRiderPos, 16, { animate: true, duration: 0.8 });
      }
    }

    function fitRouteBounds() {
      if (!map) return;
      if (currentRiderPos && currentDestPos) {
        map.fitBounds(L.latLngBounds([currentRiderPos, currentDestPos]), {
          padding: [40, 40],
          maxZoom: 16,
          animate: true
        });
      }
    }

    function smoothMove(marker, from, to, duration) {
      const start = performance.now();
      function tick(now) {
        const p = Math.min((now - start) / duration, 1);
        const ease = p * (2 - p); // ease-out quad
        const lat = from.lat + (to.lat - from.lat) * ease;
        const lng = from.lng + (to.lng - from.lng) * ease;
        marker.setLatLng([lat, lng]);
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    function escHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function triggerNavigate() {
      try {
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'NAVIGATE_PRESSED' }));
      } catch (e) {}
    }

    function updateDest(dLat, dLng, sName, sAddr) {
      if (!Number.isFinite(dLat) || !Number.isFinite(dLng) || (dLat === 0 && dLng === 0)) return;
      currentDestPos = [dLat, dLng];
      if (sName) destShopName = sName;
      if (sAddr) destAddress = sAddr;

      const destIcon = L.divIcon({
        className: '',
        iconSize: [38, 44],
        iconAnchor: [19, 44],
        html: '<div class="dest-pin-wrap"><div class="dest-pin-core"><span class="dest-icon-inner">🏪</span></div></div>'
      });

      const popupHtml =
        '<div class="shop-popup-box">' +
        '<div class="shop-popup-title">🏥 ' + escHtml(destShopName) + '</div>' +
        (destAddress ? '<div class="shop-popup-addr">📍 ' + escHtml(destAddress) + '</div>' : '') +
        '<div class="shop-popup-nav-btn" onclick="triggerNavigate()">🗺️ Open Live Navigation ↗</div>' +
        '</div>';

      if (!destMarker) {
        if (map) destMarker = L.marker([dLat, dLng], { icon: destIcon, zIndexOffset: 200 }).bindPopup(popupHtml).addTo(map);
      } else {
        if (map && !map.hasLayer(destMarker)) {
          destMarker.addTo(map);
        }
        destMarker.setIcon(destIcon);
        destMarker.setLatLng([dLat, dLng]);
        destMarker.setPopupContent(popupHtml);
      }
    }

    function createOrUpdateRider(lat, lng, heading) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const headingDeg = heading != null && heading >= 0 ? Math.round(heading) : 0;

      const riderIcon = L.divIcon({
        className: '',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
        html:
          '<div class="rider-pin-wrap">' +
          '<div class="rider-pulse"></div>' +
          '<div class="rider-core" style="transform: rotate(' + headingDeg + 'deg);">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<polygon points="12,2 4,22 12,17 20,22" fill="rgba(255,255,255,0.4)"/>' +
          '</svg>' +
          '</div></div>'
      });

      if (!riderMarker) {
        if (map) riderMarker = L.marker([lat, lng], { icon: riderIcon, zIndexOffset: 500 }).addTo(map);
      } else {
        if (map && !map.hasLayer(riderMarker)) {
          riderMarker.addTo(map);
        }
        const oldLatLng = riderMarker.getLatLng();
        riderMarker.setIcon(riderIcon);
        smoothMove(riderMarker, oldLatLng, { lat, lng }, 1500);
      }

      currentRiderPos = [lat, lng];
    }

    function updateRoute(coords) {
      if (routeGlowLine && map) { map.removeLayer(routeGlowLine); routeGlowLine = null; }
      if (routeCoreLine && map) { map.removeLayer(routeCoreLine); routeCoreLine = null; }

      if (coords && coords.length > 1 && map) {
        routeGlowLine = L.polyline(coords, {
          color: '#0D47A1',
          weight: 8,
          opacity: 0.35,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(map);

        routeCoreLine = L.polyline(coords, {
          color: '#1565C0',
          weight: 5,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(map);
      }
    }

    function handleMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'INIT') {
          initMap(msg.riderLat, msg.riderLng, msg.destLat, msg.destLng, msg.routeCoords, msg.destShopName, msg.destAddress);
        } else if (msg.type === 'UPDATE_RIDER_POS') {
          createOrUpdateRider(msg.lat, msg.lng, msg.heading);
        } else if (msg.type === 'UPDATE_DEST') {
          updateDest(msg.lat, msg.lng, msg.shopName, msg.address);
        } else if (msg.type === 'UPDATE_ROUTE') {
          updateRoute(msg.coords);
        }
      } catch (err) {}
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);
  </script>
</body>
</html>
`;

export const RiderMiniMap = forwardRef<RiderMiniMapRef, RiderMiniMapProps>(
  function RiderMiniMap(
    {
      riderLat,
      riderLng,
      destLat,
      destLng,
      destShopName,
      destAddress,
      routeCoords,
      onNavigatePress,
    },
    ref,
  ) {
    const webViewRef = useRef<WebView | null>(null);
    const isReady = useRef(false);

    const postMsg = useCallback((msg: Record<string, unknown>) => {
      if (!webViewRef.current || !isReady.current) return;
      webViewRef.current.postMessage(JSON.stringify(msg));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        updateRiderPosition: (lat: number, lng: number, heading?: number | null) => {
          postMsg({ type: 'UPDATE_RIDER_POS', lat, lng, heading });
        },
        updateRouteCoords: (coords: [number, number][]) => {
          postMsg({ type: 'UPDATE_ROUTE', coords });
        },
        updateDestination: (lat: number, lng: number, shopName?: string, address?: string) => {
          postMsg({ type: 'UPDATE_DEST', lat, lng, shopName, address });
        },
      }),
      [postMsg],
    );

    // Watch destLat & destLng prop changes
    useEffect(() => {
      if (isReady.current && Number.isFinite(destLat) && Number.isFinite(destLng) && (destLat !== 0 || destLng !== 0)) {
        postMsg({ type: 'UPDATE_DEST', lat: destLat, lng: destLng, shopName: destShopName, address: destAddress });
      }
    }, [destLat, destLng, destShopName, destAddress, postMsg]);

    const handleMessage = useCallback(
      (e: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(e.nativeEvent.data);
          if (msg.type === 'NAVIGATE_PRESSED') {
            onNavigatePress?.();
          }
        } catch {
          // ignore parsing error
        }
      },
      [onNavigatePress],
    );

    const handleLoadEnd = useCallback(() => {
      isReady.current = true;
      const initMsg = {
        type: 'INIT',
        riderLat,
        riderLng,
        destLat,
        destLng,
        destShopName: destShopName || 'Delivery Shop',
        destAddress: destAddress || '',
        routeCoords: routeCoords || [],
      };
      webViewRef.current?.postMessage(JSON.stringify(initMsg));
    }, [riderLat, riderLng, destLat, destLng, destShopName, destAddress, routeCoords]);

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          originWhitelist={['*']}
          source={{ html: RIDER_MINI_MAP_HTML }}
          style={styles.webview}
          onMessage={handleMessage}
          onLoadEnd={handleLoadEnd}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled={false}
          bounces={false}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    backgroundColor: '#E8EEF5',
  },
  webview: {
    flex: 1,
    backgroundColor: '#E8EEF5',
  },
});
