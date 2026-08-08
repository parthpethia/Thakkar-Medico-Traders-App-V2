/**
 * RiderMiniMap — Lightweight Leaflet WebView for the Delivery Person screen.
 *
 * Features:
 * - Rider's current position (blue pulsing pin with heading arrow)
 * - Destination marker (red shop pin)
 * - Active OSRM Route polyline (blue, weight 5)
 * - Thakkar Medico store NOT shown (rider already left warehouse)
 * - Non-interactive context view (no drag/zoom controls)
 * - Auto-centers on rider position with smooth panning
 * - Tap on map emits MAP_TAPPED to launch external turn-by-turn navigation
 */
import React, { useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { View, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

export interface RiderMiniMapRef {
  updateRiderPosition: (lat: number, lng: number, heading?: number | null) => void;
  updateRouteCoords: (coords: [number, number][]) => void;
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
      background: #E8EEF5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }

    /* Rider Marker: Animated Blue Pulse */
    .rider-pin-wrap {
      position: relative; width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
    }
    .rider-pulse {
      position: absolute; width: 100%; height: 100%;
      border-radius: 50%;
      background: rgba(21, 101, 192, 0.4);
      animation: pulse-ring 2s infinite ease-out;
      pointer-events: none;
    }
    .rider-core {
      position: relative; z-index: 2;
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #1E88E5 0%, #0D47A1 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(13, 71, 161, 0.5);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.4s ease;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.6); opacity: 1; }
      100% { transform: scale(2.2); opacity: 0; }
    }

    /* Destination Marker: Red Shop Pin */
    .dest-pin-wrap {
      position: relative; width: 38px; height: 44px;
      display: flex; flex-direction: column; align-items: center;
      cursor: pointer;
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

    /* Navigation Tap Hint Badge */
    .nav-tap-hint {
      position: absolute; bottom: 12px; right: 12px;
      background: rgba(21, 101, 192, 0.92);
      color: #FFFFFF; font-size: 11px; font-weight: 700;
      padding: 6px 12px; border-radius: 20px;
      box-shadow: 0 3px 10px rgba(0,0,0,0.25);
      z-index: 1000; pointer-events: none;
      display: flex; align-items: center; gap: 4px;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
</head>
<body>
  <div id="map"></div>
  <div class="nav-tap-hint">🗺️ Tap map to open Google Maps</div>

  <script>
    const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    const TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO';

    let map = null;
    let riderMarker = null;
    let destMarker = null;
    let routeLine = null;
    let currentRiderPos = null;
    let currentDestPos = null;

    function initMap(rLat, rLng, dLat, dLng, coords) {
      if (map) return;

      currentRiderPos = [rLat, rLng];
      currentDestPos = [dLat, dLng];

      // Non-interactive map config: rider is driving
      map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        touchZoom: false,
        doubleClickZoom: false,
        scrollWheelZoom: false,
        boxZoom: false,
        keyboard: false
      }).setView([rLat, rLng], 15);

      L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

      // Destination Marker
      const destIcon = L.divIcon({
        className: '',
        iconSize: [38, 44],
        iconAnchor: [19, 44],
        html: '<div class="dest-pin-wrap"><div class="dest-pin-core"><span class="dest-icon-inner">🏪</span></div></div>'
      });
      destMarker = L.marker([dLat, dLng], { icon: destIcon, zIndexOffset: 200 }).addTo(map);

      // Rider Marker
      createOrUpdateRider(rLat, rLng, 0);

      // Route Polyline
      if (coords && coords.length > 1) {
        updateRoute(coords);
      } else {
        // Fallback straight line
        updateRoute([[rLat, rLng], [dLat, dLng]]);
      }

      // Tap on map anywhere triggers navigation in React Native
      map.on('click', function() {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MAP_TAPPED' }));
        }
      });

      document.body.addEventListener('click', function() {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MAP_TAPPED' }));
        }
      });
    }

    function createOrUpdateRider(lat, lng, heading) {
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
        riderMarker = L.marker([lat, lng], { icon: riderIcon, zIndexOffset: 500 }).addTo(map);
      } else {
        riderMarker.setIcon(riderIcon);
        riderMarker.setLatLng([lat, lng]);
      }

      currentRiderPos = [lat, lng];
      if (map) {
        map.panTo([lat, lng], { animate: true, duration: 1.2 });
      }
    }

    function updateRoute(coords) {
      if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
      }
      if (coords && coords.length > 1) {
        routeLine = L.polyline(coords, {
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
          initMap(msg.riderLat, msg.riderLng, msg.destLat, msg.destLng, msg.routeCoords);
        } else if (msg.type === 'UPDATE_RIDER_POS') {
          createOrUpdateRider(msg.lat, msg.lng, msg.heading);
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
      }),
      [postMsg],
    );

    const handleMessage = useCallback(
      (e: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(e.nativeEvent.data);
          if (msg.type === 'MAP_TAPPED') {
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
      <TouchableWithoutFeedback onPress={onNavigatePress}>
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
      </TouchableWithoutFeedback>
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
