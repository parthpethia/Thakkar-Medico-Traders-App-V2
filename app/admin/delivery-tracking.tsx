import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { getGoogleMapsApiKey } from '../../src/services/googleMapsApi';
import { resolveOrderCoords } from '../../src/utils/orderDeliveryCoords';
import { calculateETA, formatETA } from '../../src/utils/etaCalculator';

type DriverRow = {
  profile_id: string;
  lat: number;
  lng: number;
  recorded_at: string;
  name: string;
  phone: string | null;
  activeOrdersCount: number;
  speed?: number | null;
  heading?: number | null;
  eta_next_stop_s?: number | null;
};

// Store default location: Thakkar Medico Warehouse, Nagpur
const STORE_COORDS = {
  lat: 21.15016745169625,
  lng: 79.09914048349087,
  name: 'Thakkar Medico Warehouse',
  address: 'Sandesh Dawa Bazar, Ganjipeth, Nagpur - 440018, Maharashtra',
};

const MAP_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0F172A; }
    
    /* Store pin styling */
    .store-pin-container {
      width: 38px; height: 38px;
      display: flex; align-items: center; justify-content: center;
    }
    .store-pin {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #FF9800 0%, #E65100 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(230, 81, 0, 0.45);
      display: flex; align-items: center; justify-content: center;
      font-size: 17px;
    }

    /* Rider pin styling with pulse wave animation */
    .rider-container {
      position: relative;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .rider-pulse {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      z-index: 1;
      animation: wave 2s infinite ease-out;
      pointer-events: none;
    }
    .rider-pulse.online { background: rgba(16, 185, 129, 0.4); }
    .rider-pulse.stale { background: rgba(245, 158, 11, 0.4); }
    .rider-pulse.offline { background: rgba(156, 163, 175, 0.4); }

    .rider-pin {
      position: relative;
      z-index: 2;
      width: 36px;
      height: 36px;
      border: 2.5px solid white;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.35s ease;
    }
    .rider-pin.online { background: linear-gradient(135deg, #10B981 0%, #059669 100%); }
    .rider-pin.stale { background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); }
    .rider-pin.offline { background: linear-gradient(135deg, #9CA3AF 0%, #6B7280 100%); }

    @keyframes wave {
      0% { transform: scale(0.6); opacity: 1; }
      100% { transform: scale(2.2); opacity: 0; }
    }

    /* Retailer pin styling (teardrop pin) */
    .retailer-pin-container {
      position: relative;
      width: 32px;
      height: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .retailer-pin {
      width: 30px;
      height: 30px;
      background: linear-gradient(135deg, #10B981 0%, #047857 100%);
      border: 2px solid white;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: -2px 3px 8px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .retailer-pin.priority-urgent {
      background: linear-gradient(135deg, #EF4444 0%, #B91C1C 100%);
    }
    .retailer-pin-text {
      color: white;
      font-weight: 800;
      font-size: 13px;
      transform: rotate(45deg);
      text-align: center;
      line-height: 26px;
    }

    /* Custom Leaflet Popup Styling */
    .leaflet-popup-content-wrapper {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 6px 22px rgba(0,0,0,0.18);
      border: 1px solid rgba(0,0,0,0.05);
      padding: 0;
      overflow: hidden;
    }
    .leaflet-popup-content {
      margin: 0;
      font-size: 12px;
      color: #1E293B;
    }
    .popup-card {
      padding: 12px 14px;
      min-width: 170px;
    }
    .popup-title {
      font-weight: 800;
      color: #0F172A;
      font-size: 13px;
      margin-bottom: 3px;
    }
    .popup-subtitle {
      font-size: 11px;
      color: #64748B;
      margin-bottom: 4px;
      line-height: 1.3;
    }
    .popup-status {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      background: #F1F5F9;
      color: #475569;
      margin-top: 4px;
    }
    .popup-status.dispatched, .popup-status.in_transit {
      background: rgba(21, 101, 192, 0.12);
      color: #1565C0;
    }
    .popup-status.accepted, .popup-status.assigned {
      background: rgba(245, 158, 11, 0.15);
      color: #D97706;
    }
    .popup-status.picked_up, .popup-status.delivered {
      background: rgba(16, 185, 129, 0.15);
      color: #059669;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
</head>
<body>
  <div id="map"></div>
  <script>
    let map = null;
    let storeMarker = null;
    let riderMarker = null;
    let riderMarkersMap = {};
    let retailerMarkers = [];
    let routePolylines = [];
    let historyPolylines = [];
    let currentData = null;

    const tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    const tileAttr = '&copy; OpenStreetMap &copy; CARTO';

    function initLeafletMap(lat, lng) {
      if (map) return;
      map = L.map('map', { zoomControl: false, attributionControl: false }).setView([lat, lng], 13);
      L.tileLayer(tileUrl, { attribution: tileAttr, maxZoom: 19 }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);

      setTimeout(function() {
        if (map) map.invalidateSize();
      }, 200);
    }

    function animateMarker(marker, startLatLng, endLatLng, duration) {
      const start = performance.now();
      function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const ease = progress * (2 - progress); // Ease out quadratic
        const lat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * ease;
        const lng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * ease;
        marker.setLatLng([lat, lng]);
        if (progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    function drawRouteLines(points) {
      if (routePolylines.length > 0) {
        routePolylines.forEach(pl => map.removeLayer(pl));
      }
      routePolylines = [];

      const glowLine = L.polyline(points, {
        color: '#0D47A1',
        weight: 8,
        opacity: 0.3,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);
      routePolylines.push(glowLine);

      const mainLine = L.polyline(points, {
        color: '#1565C0',
        weight: 4.5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);
      routePolylines.push(mainLine);
    }

    function drawRiderRouteLeaflet(data) {
      const storeCoords = [data.store.lat, data.store.lng];
      const riderCoords = [data.rider.lat, data.rider.lng];
      
      initLeafletMap(riderCoords[0], riderCoords[1]);

      for (let id in riderMarkersMap) {
        map.removeLayer(riderMarkersMap[id]);
      }
      riderMarkersMap = {};

      if (!storeMarker) {
        const storeIcon = L.divIcon({
          className: '',
          html: '<div class="store-pin-container"><div class="store-pin">🏪</div></div>',
          iconSize: [38, 38],
          iconAnchor: [19, 19]
        });
        storeMarker = L.marker(storeCoords, { icon: storeIcon, zIndexOffset: 100 })
          .bindPopup('<div class="popup-card"><div class="popup-title">' + (data.store.name || 'Thakkar Medico Warehouse') + '</div><div class="popup-subtitle">Sandesh Dawa Bazar, Ganjipeth, Nagpur</div><span class="popup-status">Origin Hub</span></div>')
          .addTo(map);
      } else {
        storeMarker.setLatLng(storeCoords);
      }

      let age = data.rider.recorded_at ? (Date.now() - new Date(data.rider.recorded_at).getTime()) / 60000 : 0;
      let stateClass = age < 2 ? 'online' : (age < 5 ? 'stale' : 'offline');
      let speedText = data.rider.speed ? Math.round(data.rider.speed * 3.6) + ' km/h' : 'Stationary';
      let etaText = data.rider.eta ? '<div style="margin-top: 4px; font-weight: 700; color: #1565C0;">ETA Next Stop: ' + Math.round(data.rider.eta / 60) + ' min</div>' : '';
      let headingDeg = data.rider.heading != null && data.rider.heading >= 0 ? Math.round(data.rider.heading) : 0;

      const riderIcon = L.divIcon({
        className: '',
        html:
          '<div class="rider-container">' +
          '<div class="rider-pulse ' + stateClass + '"></div>' +
          '<div class="rider-pin ' + stateClass + '" style="transform: rotate(' + headingDeg + 'deg);">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
          '<polygon points="12,2 4,22 12,17 20,22" fill="rgba(255,255,255,0.4)"/>' +
          '</svg>' +
          '</div></div>',
        iconSize: [44, 44],
        iconAnchor: [22, 22]
      });

      const riderPopupHtml =
        '<div class="popup-card">' +
        '<div class="popup-title">🛵 ' + (data.rider.name || 'Delivery Partner') + '</div>' +
        '<div class="popup-subtitle">Speed: ' + speedText + '</div>' +
        etaText +
        '<span class="popup-status ' + stateClass + '">' + (stateClass === 'online' ? '● Online (Live)' : stateClass === 'stale' ? '⚠ Stale (2m+)' : '○ Offline') + '</span>' +
        '</div>';

      if (!riderMarker) {
        riderMarker = L.marker(riderCoords, { icon: riderIcon, zIndexOffset: 500 })
          .bindPopup(riderPopupHtml)
          .addTo(map);
      } else {
        const oldPos = riderMarker.getLatLng();
        riderMarker.setIcon(riderIcon);
        riderMarker.setPopupContent(riderPopupHtml);
        animateMarker(riderMarker, oldPos, L.latLng(riderCoords), 2000);
      }

      // Draw historical breadcrumbs polyline
      if (historyPolylines.length > 0) {
        historyPolylines.forEach(pl => map.removeLayer(pl));
      }
      historyPolylines = [];

      if (data.history && data.history.length > 0) {
        const histPoints = data.history.map(pt => [pt.lat, pt.lng]);
        const histLine = L.polyline(histPoints, {
          color: '#7E57C2',
          weight: 3,
          opacity: 0.65,
          dashArray: '4, 8',
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(map);
        historyPolylines.push(histLine);
      }

      retailerMarkers.forEach(m => map.removeLayer(m));
      retailerMarkers = [];

      const boundsPoints = [storeCoords, riderCoords];

      data.retailers.forEach((r, idx) => {
        const retCoords = [r.lat, r.lng];
        boundsPoints.push(retCoords);
        
        const isUrgent = r.priority === 1;
        const retIcon = L.divIcon({
          className: '',
          html: '<div class="retailer-pin-container"><div class="retailer-pin' + (isUrgent ? ' priority-urgent' : '') + '"><div class="retailer-pin-text">' + (idx + 1) + '</div></div></div>',
          iconSize: [32, 40],
          iconAnchor: [16, 40]
        });

        const m = L.marker(retCoords, { icon: retIcon, zIndexOffset: 250 })
          .bindPopup(
            '<div class="popup-card">' +
            '<div class="popup-title">Stop #' + (idx + 1) + ': ' + (r.retailerName || 'Retailer Shop') + '</div>' +
            '<div class="popup-subtitle">Order #' + (r.orderNumber || r.orderId?.slice(0,8)) + '</div>' +
            (r.address ? '<div class="popup-subtitle">📍 ' + r.address + '</div>' : '') +
            '<span class="popup-status ' + (r.status || 'in_transit') + '">' + (r.status || 'In Transit') + '</span>' +
            '</div>'
          )
          .addTo(map);
        retailerMarkers.push(m);
      });

      if (routePolylines.length > 0) {
        routePolylines.forEach(pl => map.removeLayer(pl));
        routePolylines = [];
      }

      // Calculate street routing sequence via OSRM API
      const coordsSeq = [];
      const hasAccepted = data.retailers.some(r => r.status === 'accepted' || r.status === 'assigned');
      
      if (hasAccepted) {
        // If rider is heading to the store first, route: Rider -> Store -> Retailers
        coordsSeq.push([data.rider.lng, data.rider.lat]);
        coordsSeq.push([data.store.lng, data.store.lat]);
        data.retailers.forEach(r => {
          if (r.lng && r.lat) coordsSeq.push([r.lng, r.lat]);
        });
      } else {
        // If rider is already delivering, route: Rider -> Retailers
        coordsSeq.push([data.rider.lng, data.rider.lat]);
        data.retailers.forEach(r => {
          if (r.lng && r.lat) coordsSeq.push([r.lng, r.lat]);
        });
      }

      if (coordsSeq.length > 1) {
        const coordsString = coordsSeq.map(c => c[0] + ',' + c[1]).join(';');
        const url1 = 'https://router.project-osrm.org/route/v1/driving/' + coordsString + '?overview=full&geometries=geojson';
        const url2 = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/' + coordsString + '?overview=full&geometries=geojson';
        
        fetch(url1)
          .then(res => res.json())
          .then(json => {
            if (json.code === 'Ok' && json.routes && json.routes[0]) {
              const routeCoords = json.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
              drawRouteLines(routeCoords);
            } else {
              throw new Error('mirror 1 failed');
            }
          })
          .catch(() => {
            fetch(url2)
              .then(res => res.json())
              .then(json => {
                if (json.code === 'Ok' && json.routes && json.routes[0]) {
                  const routeCoords = json.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                  drawRouteLines(routeCoords);
                } else {
                  drawRouteLines(coordsSeq.map(c => [c[1], c[0]]));
                }
              })
              .catch(() => {
                drawRouteLines(coordsSeq.map(c => [c[1], c[0]]));
              });
          });
      }

      map.fitBounds(L.latLngBounds(boundsPoints), { padding: [50, 50] });
    }

    function drawAllDriversLeaflet(data) {
      initLeafletMap(data.store.lat, data.store.lng);

      if (storeMarker) { map.removeLayer(storeMarker); storeMarker = null; }
      if (riderMarker) { map.removeLayer(riderMarker); riderMarker = null; }
      retailerMarkers.forEach(m => map.removeLayer(m));
      retailerMarkers = [];
      if (routePolylines.length > 0) {
        routePolylines.forEach(pl => map.removeLayer(pl));
        routePolylines = [];
      }

      // Remove markers of drivers that are no longer online
      const activeIds = data.drivers.map(d => d.profile_id);
      for (let id in riderMarkersMap) {
        if (!activeIds.includes(id)) {
          map.removeLayer(riderMarkersMap[id]);
          delete riderMarkersMap[id];
        }
      }

      const storeIcon = L.divIcon({
        className: '',
        html: '<div class="store-pin-container"><div class="store-pin">🏪</div></div>',
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      });
      storeMarker = L.marker([data.store.lat, data.store.lng], { icon: storeIcon, zIndexOffset: 100 })
        .bindPopup('<div class="popup-card"><div class="popup-title">' + (data.store.name || 'Thakkar Medico Warehouse') + '</div><div class="popup-subtitle">Sandesh Dawa Bazar, Ganjipeth, Nagpur</div><span class="popup-status">Origin Hub</span></div>')
        .addTo(map);

      const boundsPoints = [[data.store.lat, data.store.lng]];

      data.drivers.forEach(d => {
        const riderCoords = [d.lat, d.lng];
        boundsPoints.push(riderCoords);

        let m = riderMarkersMap[d.profile_id];
        let age = d.recorded_at ? (Date.now() - new Date(d.recorded_at).getTime()) / 60000 : 0;
        let stateClass = age < 2 ? 'online' : (age < 5 ? 'stale' : 'offline');
        let speedText = d.speed ? Math.round(d.speed * 3.6) + ' km/h' : 'Stationary';
        let headingDeg = d.heading != null && d.heading >= 0 ? Math.round(d.heading) : 0;

        const riderIcon = L.divIcon({
          className: '',
          html:
            '<div class="rider-container">' +
            '<div class="rider-pulse ' + stateClass + '"></div>' +
            '<div class="rider-pin ' + stateClass + '" style="transform: rotate(' + headingDeg + 'deg);">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
            '<polygon points="12,2 4,22 12,17 20,22" fill="rgba(255,255,255,0.4)"/>' +
            '</svg>' +
            '</div></div>',
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        });

        const popupHtml =
          '<div class="popup-card">' +
          '<div class="popup-title">🛵 ' + (d.name || 'Driver') + '</div>' +
          '<div class="popup-subtitle">Speed: ' + speedText + '</div>' +
          (d.phone ? '<div class="popup-subtitle">📞 ' + d.phone + '</div>' : '') +
          '<span class="popup-status ' + stateClass + '">' + (stateClass === 'online' ? '● Online' : stateClass === 'stale' ? '⚠ Stale' : '○ Offline') + '</span>' +
          '</div>';

        if (!m) {
          m = L.marker(riderCoords, { icon: riderIcon, zIndexOffset: 300 })
            .bindPopup(popupHtml)
            .addTo(map);

          m.on('click', function() {
            try {
              window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'DRIVER_SELECTED', driverId: d.profile_id }));
            } catch (e) {}
          });

          riderMarkersMap[d.profile_id] = m;
        } else {
          const oldPos = m.getLatLng();
          m.setIcon(riderIcon);
          m.setPopupContent(popupHtml);
          animateMarker(m, oldPos, L.latLng(riderCoords), 1500);
        }
      });

      if (boundsPoints.length > 1) {
        map.fitBounds(L.latLngBounds(boundsPoints), { padding: [50, 50] });
      }
    }

    function updateMap(data) {
      currentData = data;
      
      if (!map) {
        if (data.drivers) {
          initLeafletMap(data.store.lat, data.store.lng);
        } else {
          initLeafletMap(data.rider.lat, data.rider.lng);
        }
      }

      if (data.drivers) {
        drawAllDriversLeaflet(data);
      } else {
        drawRiderRouteLeaflet(data);
      }
    }

    function formatTimeHtml(iso) {
      let date = new Date(iso);
      let m = (Date.now() - date.getTime()) / 60000;
      if (m < 1) return 'Just now';
      if (m < 60) return Math.floor(m) + 'm ago';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function handleWindowMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'UPDATE_DATA') {
          updateMap(msg.data);
        } else if (msg.type === 'SHOW_ALL_DRIVERS') {
          updateMap(msg.data);
        }
      } catch (err) {
        // ignore
      }
    }

    window.addEventListener('message', handleWindowMessage);
    document.addEventListener('message', handleWindowMessage);
  </script>
</body>
</html>
`;

export default function AdminDeliveryTracking() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [activeStops, setActiveStops] = useState<any[]>([]);
  const [loadingStops, setLoadingStops] = useState(false);
  const [historyCoords, setHistoryCoords] = useState<{ lat: number; lng: number }[]>([]);
  const webViewRef = useRef<WebView | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: locations, error } = await supabase
        .from('driver_locations')
        .select('profile_id, lat, lng, recorded_at, speed, heading, eta_next_stop_s')
        .order('recorded_at', { ascending: false });

      if (error) throw error;

      const latestMap: Record<string, typeof locations[0]> = {};
      (locations || []).forEach((l) => {
        if (
          !latestMap[l.profile_id] ||
          new Date(l.recorded_at) > new Date(latestMap[l.profile_id].recorded_at)
        ) {
          latestMap[l.profile_id] = l;
        }
      });
      const uniqueLocations = Object.values(latestMap);
      const ids = uniqueLocations.map((l) => l.profile_id);

      const nameMap: Record<
        string,
        { name: string; phone: string | null; activeOrdersCount: number }
      > = {};

      if (ids.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name, business_name, phone')
          .in('id', ids);

        const { data: ordersData } = await supabase
          .from('orders')
          .select('assigned_to')
          .in('status', ['approved', 'packed', 'dispatched', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'in_transit', 'arriving_soon', 'processing']);

        const orderCounts: Record<string, number> = {};
        (ordersData || []).forEach((o) => {
          if (o.assigned_to) {
            orderCounts[o.assigned_to] = (orderCounts[o.assigned_to] || 0) + 1;
          }
        });

        (profiles || []).forEach((p: any) => {
          nameMap[p.id] = {
            name: p.name || p.business_name || 'Driver',
            phone: p.phone,
            activeOrdersCount: orderCounts[p.id] || 0,
          };
        });
      }

      setDrivers(
        uniqueLocations.map((l) => ({
          ...l,
          name: nameMap[l.profile_id]?.name || 'Driver',
          phone: nameMap[l.profile_id]?.phone ?? null,
          activeOrdersCount: nameMap[l.profile_id]?.activeOrdersCount || 0,
          speed: l.speed ?? null,
          heading: l.heading ?? null,
          eta_next_stop_s: l.eta_next_stop_s ?? null,
        }))
      );
    } catch (err: unknown) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  // Real-time incremental updates (no DB reload for positional updates)
  useRealtimeOrders({
    table: 'driver_locations',
    event: 'INSERT',
    onInsert: (payload) => {
      setDrivers(prev => {
        const idx = prev.findIndex(d => d.profile_id === payload.new.profile_id);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            lat: payload.new.lat,
            lng: payload.new.lng,
            recorded_at: payload.new.recorded_at,
            speed: payload.new.speed,
            heading: payload.new.heading,
            eta_next_stop_s: payload.new.eta_next_stop_s,
          };
          return updated;
        }
        void load();
        return prev;
      });
    },
  });

  useRealtimeOrders({
    table: 'driver_locations',
    event: 'UPDATE',
    onUpdate: (payload) => {
      setDrivers(prev => {
        const idx = prev.findIndex(d => d.profile_id === payload.new.profile_id);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            lat: payload.new.lat,
            lng: payload.new.lng,
            recorded_at: payload.new.recorded_at,
            speed: payload.new.speed,
            heading: payload.new.heading,
            eta_next_stop_s: payload.new.eta_next_stop_s,
          };
          return updated;
        }
        return prev;
      });
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const selectedDriver = drivers.find((d) => d.profile_id === selectedDriverId);

  // Fetch active order stops & historical coordinates when driver is selected
  useEffect(() => {
    if (!selectedDriverId) {
      setActiveStops([]);
      setHistoryCoords([]);
      return;
    }

    let cancelled = false;

    const fetchStopsAndHistory = async () => {
      setLoadingStops(true);
      try {
        // Fetch active stops with priority, SLA, proofs, and collections in one query
        const { data: activeOrders, error } = await supabase
          .from('orders')
          .select(`
            id, order_number, status, user_id, user_name, delivery_address, delivery_snapshot, delivery_address_id,
            sla_deadline, priority,
            delivery_proofs (photo_url, receiver_name, receiver_phone, gps_lat, gps_lng, delivered_at_gps),
            delivery_collections (method, amount, reference_no, bank_name, status)
          `)
          .eq('assigned_to', selectedDriverId)
          .in('status', ['approved', 'packed', 'dispatched', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'in_transit', 'arriving_soon', 'processing']);

        if (error) throw error;
        if (cancelled) return;

        const resolvedStops = await Promise.all(
          (activeOrders || []).map(async (o) => {
            const coords = await resolveOrderCoords(supabase, o);
            return {
              orderId: o.id,
              orderNumber: o.order_number,
              retailerName: o.user_name || 'Retailer',
              address: o.delivery_address || (coords ? coords.address : 'No address'),
              lat: coords ? coords.lat : 0,
              lng: coords ? coords.lng : 0,
              status: o.status,
              priority: o.priority ?? 3,
              slaDeadline: o.sla_deadline ?? null,
              proof: o.delivery_proofs?.[0] || null,
              collections: o.delivery_collections || [],
            };
          })
        );

        if (cancelled) return;
        setActiveStops(resolvedStops.filter((s) => s.lat !== 0 && s.lng !== 0));

        // Fetch location history (last 2 hours)
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: historyData } = await supabase
          .from('driver_location_history')
          .select('lat, lng')
          .eq('profile_id', selectedDriverId)
          .gte('recorded_at', twoHoursAgo)
          .order('recorded_at', { ascending: true });

        if (cancelled) return;
        setHistoryCoords(historyData || []);
      } catch (err) {
        console.error('Failed to load active stops/history:', err);
      } finally {
        if (!cancelled) setLoadingStops(false);
      }
    };

    void fetchStopsAndHistory();

    return () => {
      cancelled = true;
    };
  }, [selectedDriverId]);

  // Send update messages to WebView map
  useEffect(() => {
    if (!webViewRef.current) return;

    if (selectedDriverId && selectedDriver) {
      const calculatedEta = activeStops.length > 0 && activeStops[0].lat && activeStops[0].lng
        ? calculateETA(selectedDriver.lat, selectedDriver.lng, activeStops[0].lat, activeStops[0].lng, selectedDriver.speed)
        : null;

      const message = {
        type: 'UPDATE_DATA',
        data: {
          rider: {
            lat: selectedDriver.lat,
            lng: selectedDriver.lng,
            name: selectedDriver.name,
            recorded_at: selectedDriver.recorded_at,
            speed: selectedDriver.speed,
            heading: selectedDriver.heading,
            eta: calculatedEta ?? selectedDriver.eta_next_stop_s,
          },
          store: STORE_COORDS,
          retailers: activeStops,
          history: historyCoords,
          apiKey: getGoogleMapsApiKey(),
        },
      };
      webViewRef.current.postMessage(JSON.stringify(message));
    } else {
      const message = {
        type: 'SHOW_ALL_DRIVERS',
        data: {
          drivers: drivers.map((d) => ({
            profile_id: d.profile_id,
            lat: d.lat,
            lng: d.lng,
            name: d.name,
            recorded_at: d.recorded_at,
            speed: d.speed,
            heading: d.heading,
          })),
          store: STORE_COORDS,
          apiKey: getGoogleMapsApiKey(),
        },
      };
      webViewRef.current.postMessage(JSON.stringify(message));
    }
  }, [
    selectedDriverId,
    selectedDriver?.lat,
    selectedDriver?.lng,
    activeStops,
    drivers,
    historyCoords,
  ]);

  const handleWebViewMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'DRIVER_SELECTED' && msg.driverId) {
        setSelectedDriverId(msg.driverId);
      }
    } catch {
      // ignore
    }
  };

  const callDriver = (phone: string | null) => {
    if (!phone) {
      Alert.alert('Phone error', 'No phone number stored for this rider.');
      return;
    }
    Linking.openURL(`tel:${phone}`).catch(() => {
      Alert.alert('Error', 'Failed to launch dialer.');
    });
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Live Tracking',
          headerRight: () => (
            <TouchableOpacity onPress={onRefresh} style={{ marginRight: 8 }}>
              <Ionicons name="refresh" size={22} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* Active Drivers slider at the top */}
          <View style={styles.sliderContainer}>
            <Text style={styles.sectionTitle}>
              Online Riders ({drivers.length})
            </Text>
            {drivers.length === 0 ? (
              <Text style={styles.noDrivers}>No online drivers tracked.</Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sliderContent}
              >
                <TouchableOpacity
                  style={[
                    styles.driverCard,
                    !selectedDriverId && styles.driverCardActive,
                  ]}
                  onPress={() => setSelectedDriverId(null)}
                >
                  <Ionicons
                    name="people-circle"
                    size={24}
                    color={!selectedDriverId ? colors.onPrimary : colors.primary}
                  />
                  <Text
                    style={[
                      styles.driverName,
                      !selectedDriverId && styles.driverNameActive,
                    ]}
                  >
                    Show All
                  </Text>
                  <Text
                    style={[
                      styles.driverOrdersCount,
                      { color: !selectedDriverId ? colors.onPrimary : colors.textSecondary },
                    ]}
                  >
                    {drivers.reduce((acc, curr) => acc + curr.activeOrdersCount, 0)} orders
                  </Text>
                </TouchableOpacity>

                {drivers.map((d) => {
                  const isActive = selectedDriverId === d.profile_id;
                  return (
                    <TouchableOpacity
                      key={d.profile_id}
                      style={[
                        styles.driverCard,
                        isActive && styles.driverCardActive,
                      ]}
                      onPress={() => setSelectedDriverId(d.profile_id)}
                    >
                      <Ionicons
                        name="bicycle-outline"
                        size={22}
                        color={isActive ? colors.onPrimary : colors.primary}
                      />
                      <Text
                        style={[
                          styles.driverName,
                          isActive && styles.driverNameActive,
                        ]}
                        numberOfLines={1}
                      >
                        {d.name}
                      </Text>
                      <View style={styles.badge}>
                        <Text
                          style={[
                            styles.badgeText,
                            { color: isActive ? colors.onPrimary : colors.primary },
                          ]}
                        >
                          {d.activeOrdersCount} deliveries
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>

          {/* Interactive Map WebView */}
          <View style={styles.mapContainer}>
            <WebView
              ref={webViewRef}
              originWhitelist={['*']}
              source={{ html: MAP_HTML }}
              style={{ flex: 1 }}
              onMessage={handleWebViewMessage}
              javaScriptEnabled
              domStorageEnabled
              onLoadEnd={() => {
                // Trigger initial map paint once webview loads
                if (selectedDriverId && selectedDriver) {
                  webViewRef.current?.postMessage(
                    JSON.stringify({
                      type: 'UPDATE_DATA',
                      data: {
                        rider: {
                          lat: selectedDriver.lat,
                          lng: selectedDriver.lng,
                          name: selectedDriver.name,
                          recorded_at: selectedDriver.recorded_at,
                        },
                        store: STORE_COORDS,
                        retailers: activeStops,
                        apiKey: getGoogleMapsApiKey(),
                      },
                    })
                  );
                } else {
                  webViewRef.current?.postMessage(
                    JSON.stringify({
                      type: 'SHOW_ALL_DRIVERS',
                      data: {
                        drivers: drivers.map((d) => ({
                          profile_id: d.profile_id,
                          lat: d.lat,
                          lng: d.lng,
                          name: d.name,
                          recorded_at: d.recorded_at,
                        })),
                        store: STORE_COORDS,
                        apiKey: getGoogleMapsApiKey(),
                      },
                    })
                  );
                }
              }}
            />
          </View>

          {/* Selected Rider Details Panel at the Bottom */}
          {selectedDriver && (
            <View style={styles.detailPanel}>
              <View style={styles.panelHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.panelDriverName}>{selectedDriver.name}</Text>
                  <Text style={styles.panelUpdatedText}>
                    Last seen{' '}
                    {formatDistanceToNow(new Date(selectedDriver.recorded_at), {
                      addSuffix: true,
                    })}
                  </Text>
                  {(() => {
                    const etaSecs = activeStops.length > 0 && activeStops[0].lat && activeStops[0].lng
                      ? calculateETA(selectedDriver.lat, selectedDriver.lng, activeStops[0].lat, activeStops[0].lng, selectedDriver.speed)
                      : selectedDriver.eta_next_stop_s;
                    return etaSecs !== null && etaSecs !== undefined ? (
                      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 4 }}>
                        ⏱️ ETA to Next Store: {formatETA(etaSecs)}
                      </Text>
                    ) : null;
                  })()}
                </View>
                <View style={styles.panelActions}>
                  <TouchableOpacity
                    style={styles.actionCircleBtn}
                    onPress={() => callDriver(selectedDriver.phone)}
                  >
                    <Ionicons name="call" size={20} color={colors.onPrimary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionCircleBtn, { backgroundColor: colors.error }]}
                    onPress={() => setSelectedDriverId(null)}
                  >
                    <Ionicons name="close" size={20} color={colors.onPrimary} />
                  </TouchableOpacity>
                </View>
              </View>

              {loadingStops ? (
                <ActivityIndicator
                  size="small"
                  color={colors.primary}
                  style={{ marginVertical: 20 }}
                />
              ) : activeStops.length === 0 ? (
                <Text style={styles.noActiveStops}>
                  This rider has no active delivery orders in progress.
                </Text>
              ) : (
                <View style={{ maxHeight: 220 }}>
                  <Text style={styles.stopsHeader}>
                    Delivery Stops Queue ({activeStops.length})
                  </Text>
                  <ScrollView nestedScrollEnabled>
                    {activeStops.map((stop, index) => {
                      const isUrgent = stop.priority === 1;
                      const isHigh = stop.priority === 2;
                      const slaColor =
                        stop.status === 'dispatched' ? colors.success : (isUrgent ? colors.error : (isHigh ? colors.warning : colors.textSecondary));
                      
                      // Format SLA countdown if deadline exists
                      let slaText = '';
                      if (stop.slaDeadline) {
                        const diff = new Date(stop.slaDeadline).getTime() - Date.now();
                        if (diff <= 0) {
                          slaText = 'SLA Overdue';
                        } else {
                          const leftMins = Math.ceil(diff / 60000);
                          slaText = leftMins < 60 ? `${leftMins}m left` : `${Math.floor(leftMins/60)}h ${leftMins%60}m left`;
                        }
                      }

                      return (
                        <View key={stop.orderId} style={styles.stopRowExpanded}>
                          <View style={styles.stopNumCircle}>
                            <Text style={styles.stopNumText}>{index + 1}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={styles.stopRetailer}>
                                {stop.retailerName} · #{stop.orderNumber}
                              </Text>
                              {isUrgent && (
                                <View style={[styles.priorityBadge, { backgroundColor: colors.error }]}>
                                  <Text style={styles.priorityText}>URGENT</Text>
                                </View>
                              )}
                              {isHigh && (
                                <View style={[styles.priorityBadge, { backgroundColor: colors.warning }]}>
                                  <Text style={styles.priorityText}>HIGH</Text>
                                </View>
                              )}
                            </View>
                            <Text style={styles.stopAddress} numberOfLines={1}>
                              {stop.address}
                            </Text>
                            
                            {/* SLA countdown and details */}
                            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4, alignItems: 'center' }}>
                              {slaText ? (
                                <Text style={{ fontSize: 11, fontWeight: '700', color: slaColor }}>
                                  ⏱️ {slaText}
                                </Text>
                              ) : null}
                              
                              {/* Display recorded collections */}
                              {stop.collections && stop.collections.length > 0 && (
                                <Text style={{ fontSize: 11, color: colors.success, fontWeight: '600' }}>
                                  Collected: ₹{stop.collections.reduce((sum: number, c: any) => sum + Number(c.amount), 0)} ({stop.collections[0].method.toUpperCase()})
                                </Text>
                              )}
                            </View>
                          </View>

                          {/* Show proof thumbnail if photo uploaded */}
                          {stop.proof?.photo_url ? (
                            <TouchableOpacity 
                              onPress={() => Linking.openURL(stop.proof.photo_url)}
                              style={styles.podThumbnailContainer}
                            >
                              <Ionicons name="image" size={18} color={colors.primary} />
                              <Text style={{ fontSize: 9, fontWeight: '700', color: colors.primary }}>POD</Text>
                            </TouchableOpacity>
                          ) : null}

                          <Text
                            style={[
                              styles.stopStatus,
                              {
                                color:
                                  stop.status === 'dispatched'
                                    ? colors.success
                                    : colors.primary,
                              },
                            ]}
                          >
                            {stop.status}
                          </Text>
                        </View>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, padding: 40 },
    sliderContainer: {
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '800' as const,
      color: c.text,
      marginLeft: 16,
      marginBottom: 8,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    noDrivers: {
      fontSize: 13,
      color: c.textMuted,
      marginLeft: 16,
      marginVertical: 4,
    },
    sliderContent: {
      paddingHorizontal: 16,
      gap: 10,
    },
    driverCard: {
      backgroundColor: c.surfaceSecondary,
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: 8,
      minWidth: 120,
    },
    driverCardActive: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    driverName: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.text,
    },
    driverNameActive: {
      color: c.onPrimary,
    },
    driverOrdersCount: {
      fontSize: 11,
      fontWeight: '600' as const,
    },
    badge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: 'rgba(76, 81, 201, 0.08)',
    },
    badgeText: {
      fontSize: 10,
      fontWeight: '700' as const,
    },
    mapContainer: {
      flex: 1,
      overflow: 'hidden' as const,
    },
    detailPanel: {
      position: 'absolute' as const,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.1,
      shadowRadius: 10,
      elevation: 10,
    },
    panelHeader: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: 12,
      marginBottom: 12,
    },
    panelDriverName: {
      fontSize: 16,
      fontWeight: '800' as const,
      color: c.text,
    },
    panelUpdatedText: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    panelActions: {
      flexDirection: 'row' as const,
      gap: 8,
    },
    actionCircleBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: c.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    noActiveStops: {
      fontSize: 13,
      color: c.textMuted,
      textAlign: 'center' as const,
      marginVertical: 16,
    },
    stopsHeader: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: c.textSecondary,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    stopRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    stopRowExpanded: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    priorityBadge: {
      paddingHorizontal: 5,
      paddingVertical: 1.5,
      borderRadius: 4,
    },
    priorityText: {
      fontSize: 8,
      fontWeight: '900' as const,
      color: '#FFFFFF',
    },
    podThumbnailContainer: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderWidth: 1,
      borderColor: c.primary,
      borderRadius: 6,
      padding: 4,
      minWidth: 36,
      height: 36,
      backgroundColor: c.primaryMuted,
    },
    stopNumCircle: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.primaryMuted,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    stopNumText: {
      fontSize: 11,
      fontWeight: '800' as const,
      color: c.primary,
    },
    stopRetailer: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.text,
    },
    stopAddress: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
    stopStatus: {
      fontSize: 11,
      fontWeight: '700' as const,
      textTransform: 'capitalize' as const,
    },
  };
}
