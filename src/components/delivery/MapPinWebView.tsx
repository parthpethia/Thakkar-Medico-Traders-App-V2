import React, { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

type Props = {
  lat: number;
  lng: number;
  onCenterChange: (lat: number, lng: number) => void;
};

export function MapPinWebView({ lat, lng, onCenterChange }: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
    .pin {
      position: fixed; left: 50%; top: 50%;
      transform: translate(-50%, -100%);
      font-size: 36px; z-index: 999; pointer-events: none;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body>
  <div id="map"></div>
  <div class="pin">📍</div>
  <script>
    let map;
    let debounce;

    function postCenter() {
      if (!map) return;
      const c = map.getCenter();
      window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat, lng: c.lng }));
    }

    function initLeaflet() {
      map = L.map('map', { zoomControl: false }).setView([${lat}, ${lng}], 17);
      L.tileLayer('https://{s.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19
      }).addTo(map);
      
      map.on('moveend', function() {
        clearTimeout(debounce);
        debounce = setTimeout(postCenter, 300);
      });
      postCenter();
    }

    initLeaflet();
  </script>
</body>
</html>`;

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const { lat: newLat, lng: newLng } = JSON.parse(e.nativeEvent.data);
        if (typeof newLat === 'number' && typeof newLng === 'number') {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => onCenterChange(newLat, newLng), 50);
        }
      } catch {
        /* ignore */
      }
    },
    [onCenterChange],
  );

  return (
    <WebView
      originWhitelist={['*']}
      source={{ html }}
      style={styles.webview}
      onMessage={onMessage}
      javaScriptEnabled
      domStorageEnabled
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, minHeight: 280, borderRadius: 12, overflow: 'hidden' },
});
