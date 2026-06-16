import React, { useCallback, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { getGoogleMapsApiKey } from '../../services/googleMapsApi';

type Props = {
  lat: number;
  lng: number;
  onCenterChange: (lat: number, lng: number) => void;
};

export function MapPinWebView({ lat, lng, onCenterChange }: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiKey = getGoogleMapsApiKey();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
    .pin {
      position: fixed; left: 50%; top: 50%;
      transform: translate(-50%, -100%);
      font-size: 36px; z-index: 999; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="pin">📍</div>
  <script>
    let map;
    let debounce;
    function postCenter() {
      const c = map.getCenter();
      window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat(), lng: c.lng() }));
    }
    function initMap() {
      map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: ${lat}, lng: ${lng} },
        zoom: 17,
        disableDefaultUI: false,
        gestureHandling: 'greedy',
      });
      map.addListener('dragend', function() {
        clearTimeout(debounce);
        debounce = setTimeout(postCenter, 300);
      });
      map.addListener('idle', function() {
        clearTimeout(debounce);
        debounce = setTimeout(postCenter, 300);
      });
    }
  </script>
  <script async defer src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap"></script>
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

  if (!apiKey) {
    return (
      <View style={styles.fallback}>
        <ActivityIndicator color="#4C51C9" />
      </View>
    );
  }

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
  fallback: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eee',
    borderRadius: 12,
  },
});
