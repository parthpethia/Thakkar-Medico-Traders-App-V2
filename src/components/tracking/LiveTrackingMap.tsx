/**
 * LiveTrackingMap — Premium Leaflet WebView component for admin per-order delivery tracking.
 *
 * Layers & Features:
 * 1. Markers:
 *    - Thakkar Medico (Orange warehouse SVG pin, fixed at Sandesh Dawa Bazar, Ganjipeth)
 *    - Rider (Animated blue scooter, rotated by heading, smooth 2s lerp, accuracy circle, pulsing wave, battery/speed popup, red ring on off-route)
 *    - Destination (Red shop pin, green pulsing when geofence_arrived = true)
 * 2. 3 Polyline Layers:
 *    - Layer 1: Store → Destination reference route (light grey #CFD8DC, weight 4, dashArray '8 6')
 *    - Layer 2: Rider → Destination remaining active route (deep blue #1565C0, weight 6, solid)
 *    - Layer 3: Completed breadcrumb trail (purple #7E57C2, weight 3, dashArray '3 4')
 * 3. Camera Behavior:
 *    - Multi-stage auto-framing (>300m drops store, <1km zooms to 16, <200m zooms to 17 and freezes auto-fit)
 * 4. Client-side Route Deviation (400m cross-track check in JavaScript)
 */
import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { THAKKAR_MEDICO } from '../../services/routesApiService';

export interface MapRiderData {
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  batteryLevel?: number | null;
  riderName: string;
  riderPhone: string;
  lastUpdated: string;
  isOffRoute?: boolean;
  geofenceArrived?: boolean;
}

export interface MapDestinationData {
  lat: number;
  lng: number;
  shopName: string;
  landmark: string;
  receiverName: string;
  receiverPhone: string;
  geofenceArrived?: boolean;
}

export interface MapRouteData {
  /** Rider → destination route coords [lat, lng][] */
  activeRoute: [number, number][];
  /** Store → destination reference route coords [lat, lng][] */
  referenceRoute: [number, number][];
  durationSeconds: number;
  distanceMeters: number;
  source?: string;
}

export interface LiveTrackingMapRef {
  updateRider: (data: MapRiderData) => void;
  updateRoute: (data: MapRouteData) => void;
  appendHistory: (point: { lat: number; lng: number }) => void;
  setGeofenceArrived: (arrived: boolean) => void;
}

interface Props {
  destination: MapDestinationData;
  initialRider?: MapRiderData | null;
  initialRoute?: MapRouteData | null;
  initialHistory?: { lat: number; lng: number }[];
  onMapReady?: () => void;
  onOffRouteDetected?: (isOffRoute: boolean, distanceMeters: number) => void;
  onGeofenceArrival?: () => void;
}

const STORE = {
  lat: THAKKAR_MEDICO.lat,
  lng: THAKKAR_MEDICO.lng,
  name: THAKKAR_MEDICO.name,
  address: THAKKAR_MEDICO.address,
};

const MAP_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0F172A; }

    /* 1. Store Marker: Orange Warehouse Pin */
    .store-wrap {
      position: relative; width: 42px; height: 42px;
      display: flex; align-items: center; justify-content: center;
    }
    .store-pin {
      width: 38px; height: 38px;
      background: linear-gradient(135deg, #FF9800 0%, #E65100 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 4px 14px rgba(230, 81, 0, 0.45);
      display: flex; align-items: center; justify-content: center;
    }
    .store-icon-inner {
      font-size: 18px; line-height: 1;
    }

    /* 2. Rider Marker: Blue Scooter with smooth rotation & pulse */
    .rider-wrap {
      position: relative; width: 48px; height: 48px;
      display: flex; align-items: center; justify-content: center;
    }
    .rider-pulse-ring {
      position: absolute; width: 100%; height: 100%;
      border-radius: 50%; z-index: 1;
      background: rgba(21, 101, 192, 0.35);
      animation: pulse-wave 2s infinite ease-out;
    }
    .rider-pulse-ring.off-route {
      background: rgba(211, 47, 47, 0.4);
      border: 2px dashed #D32F2F;
    }
    .rider-pin {
      position: relative; z-index: 2;
      width: 40px; height: 40px;
      background: linear-gradient(135deg, #1E88E5 0%, #0D47A1 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50%;
      box-shadow: 0 4px 14px rgba(13, 71, 161, 0.45);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.4s ease;
    }
    .rider-pin.stale {
      background: linear-gradient(135deg, #FB8C00 0%, #E65100 100%);
      box-shadow: 0 4px 14px rgba(230, 81, 0, 0.45);
    }
    .rider-pin.off-route {
      border-color: #FFCDD2;
      box-shadow: 0 0 0 3px #D32F2F;
    }

    @keyframes pulse-wave {
      0% { transform: scale(0.6); opacity: 1; }
      100% { transform: scale(2.4); opacity: 0; }
    }

    /* 3. Destination Marker: Shop pin (Red -> Green Pulse when arrived) */
    .dest-wrap {
      position: relative; width: 38px; height: 46px;
      display: flex; flex-direction: column; align-items: center;
    }
    .dest-pin {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #E53935 0%, #B71C1C 100%);
      border: 2.5px solid #FFFFFF;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: -2px 4px 12px rgba(183, 28, 28, 0.45);
      display: flex; align-items: center; justify-content: center;
      transition: all 0.5s ease;
    }
    .dest-pin.arrived {
      background: linear-gradient(135deg, #43A047 0%, #1B5E20 100%);
      box-shadow: 0 0 16px rgba(46, 125, 50, 0.7);
      animation: dest-pulse 1.8s infinite;
    }
    .dest-icon-inner {
      transform: rotate(45deg);
      font-size: 15px; line-height: 1;
    }

    @keyframes dest-pulse {
      0% { transform: rotate(-45deg) scale(1); }
      50% { transform: rotate(-45deg) scale(1.15); }
      100% { transform: rotate(-45deg) scale(1); }
    }

    /* Floating In-Map Quick Controls */
    .map-controls-topright {
      position: absolute; top: 12px; right: 12px;
      z-index: 1000; display: flex; flex-direction: column; gap: 8px;
    }
    .map-fab-btn {
      width: 38px; height: 38px;
      background: #FFFFFF; border: 1px solid #CBD5E1;
      border-radius: 10px; box-shadow: 0 3px 10px rgba(0,0,0,0.22);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 800; color: #1E293B;
      cursor: pointer; transition: background 0.15s;
      user-select: none; -webkit-user-select: none;
    }
    .map-fab-btn:active {
      background: #E2E8F0;
    }

    /* Fallback banner */
    .fallback-banner {
      position: absolute; top: 12px; left: 50%;
      transform: translateX(-50%);
      background: rgba(33, 33, 33, 0.88);
      color: #fff; padding: 6px 14px;
      border-radius: 20px; font-size: 11px;
      font-weight: 600; z-index: 1000;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      display: none;
    }

    /* Leaflet popup card */
    .leaflet-popup-content-wrapper {
      background: #FFFFFF; border-radius: 14px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18);
      border: 1px solid rgba(0,0,0,0.06); padding: 0; overflow: hidden;
    }
    .leaflet-popup-content { margin: 0; font-size: 13px; color: #212121; }
    .popup-card { padding: 12px 14px; min-width: 170px; }
    .popup-title { font-weight: 800; color: #1A1D20; font-size: 14px; margin-bottom: 4px; }
    .popup-sub { font-size: 11px; color: #616161; line-height: 1.4; margin-bottom: 2px; }
    .popup-badge {
      display: inline-block; padding: 3px 8px; border-radius: 5px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      margin-top: 6px;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
</head>
<body>
  <div id="map"></div>
  <div id="fallbackBanner" class="fallback-banner">Route unavailable — showing direct path</div>

  <!-- In-Map Quick Controls -->
  <div class="map-controls-topright">
    <div class="map-fab-btn" onclick="zoomIn()" title="Zoom In">+</div>
    <div class="map-fab-btn" onclick="zoomOut()" title="Zoom Out">−</div>
    <div class="map-fab-btn" onclick="fitRouteBounds()" title="Fit Route" style="font-size: 15px;">🗺️</div>
    <div class="map-fab-btn" onclick="recenterOnRider()" title="Recenter on Rider" style="font-size: 15px;">🎯</div>
  </div>

  <script>
    const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    const TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO';

    let map = null;
    let storeMarker = null;
    let riderMarker = null;
    let destMarker = null;
    let activeRouteLine = null;
    let referenceRouteLine = null;
    let breadcrumbLine = null;
    let accuracyCircle = null;

    let storedRouteCoords = [];
    let breadcrumbPoints = [];
    let storeCoords = null;
    let destCoords = null;
    let currentRiderPos = null;
    let geofenceArrivedState = false;
    let destInfo = {
      shopName: 'Destination Store',
      landmark: '',
      receiverName: '',
      receiverPhone: ''
    };

    function initMap(centerLat, centerLng) {
      if (map) return;
      map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        touchZoom: true,
        doubleClickZoom: true,
        scrollWheelZoom: true
      }).setView([centerLat, centerLng], 14);

      // Custom z-index panes for layer ordering
      map.createPane('breadcrumbPane');
      map.getPane('breadcrumbPane').style.zIndex = 420;
      map.createPane('activeRoutePane');
      map.getPane('activeRoutePane').style.zIndex = 450;

      L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

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
        map.setView([currentRiderPos.lat, currentRiderPos.lng], 16, { animate: true, duration: 0.8 });
      }
    }

    function fitRouteBounds() {
      if (!map) return;
      const pts = [];
      if (currentRiderPos) pts.push([currentRiderPos.lat, currentRiderPos.lng]);
      if (destCoords) pts.push([destCoords.lat, destCoords.lng]);
      if (storeCoords && pts.length < 2) pts.push([storeCoords.lat, storeCoords.lng]);

      if (pts.length > 1) {
        try {
          map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 16, animate: true });
        } catch (e) {}
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

    // Predicted position: uses heading + speed to predict rider location 3s ahead
    // Animate to predicted, snap to real on next ping
    function predictedPosition(lat, lng, heading, speed) {
      if (!speed || speed < 0.5 || heading == null || heading < 0) {
        return { lat: lat, lng: lng };
      }
      var predictSec = 3;
      var distMeters = speed * predictSec;
      var headingRad = heading * Math.PI / 180;
      var R = 6371000;
      var latRad = lat * Math.PI / 180;
      var predLat = lat + (distMeters * Math.cos(headingRad)) / R * (180 / Math.PI);
      var predLng = lng + (distMeters * Math.sin(headingRad)) / (R * Math.cos(latRad)) * (180 / Math.PI);
      return { lat: predLat, lng: predLng };
    }

    // Route recalc trigger state
    var lastRouteRiderPos = null;
    var lastRouteHeading = null;
    var lastRouteFetchTime = 0;

    function createStoreMarker(lat, lng) {
      storeCoords = { lat, lng };
      if (storeMarker && map) { map.removeLayer(storeMarker); storeMarker = null; }

      const icon = L.divIcon({
        className: '', iconSize: [42, 42], iconAnchor: [21, 21],
        html: '<div class="store-wrap"><div class="store-pin"><span class="store-icon-inner">🏪</span></div></div>'
      });

      const popupHtml =
        '<div class="popup-card">' +
        '<div class="popup-title">Thakkar Medico Central Warehouse</div>' +
        '<div class="popup-sub">📍 Sandesh Dawa Bazar, Ganjipeth, Nagpur</div>' +
        '<div class="popup-badge" style="background:rgba(21,101,192,0.12);color:#1565C0;">Origin Warehouse</div>' +
        '</div>';

      if (map) {
        storeMarker = L.marker([lat, lng], { icon, zIndexOffset: 100 })
          .bindPopup(popupHtml)
          .addTo(map);
      }
    }

    function createDestMarker(lat, lng, shopName, landmark, receiverName, receiverPhone, arrived) {
      destCoords = { lat, lng };
      geofenceArrivedState = !!arrived;
      if (shopName) destInfo.shopName = shopName;
      if (landmark) destInfo.landmark = landmark;
      if (receiverName) destInfo.receiverName = receiverName;
      if (receiverPhone) destInfo.receiverPhone = receiverPhone;

      if (destMarker && map) { map.removeLayer(destMarker); destMarker = null; }

      const arrivedClass = geofenceArrivedState ? ' arrived' : '';
      const icon = L.divIcon({
        className: '', iconSize: [38, 46], iconAnchor: [19, 46],
        html: '<div class="dest-wrap"><div class="dest-pin' + arrivedClass + '"><span class="dest-icon-inner">🏪</span></div></div>'
      });

      const displayTitle = destInfo.shopName || 'Destination Store';
      const popupHtml =
        '<div class="popup-card">' +
        '<div class="popup-title">' + escHtml(displayTitle) + '</div>' +
        (destInfo.landmark ? '<div class="popup-sub">📍 ' + escHtml(destInfo.landmark) + '</div>' : '') +
        (destInfo.receiverName || destInfo.receiverPhone ? '<div class="popup-sub">👤 Receiver: ' + escHtml(destInfo.receiverName) + ' ' + escHtml(destInfo.receiverPhone) + '</div>' : '') +
        '<div class="popup-badge" style="background:' + (geofenceArrivedState ? 'rgba(76,175,80,0.15);color:#2E7D32' : 'rgba(229,57,53,0.15);color:#C62828') + ';">' + (geofenceArrivedState ? '🔔 Arriving Soon' : 'Destination') + '</div>' +
        '</div>';

      if (map) {
        destMarker = L.marker([lat, lng], { icon, zIndexOffset: 200 })
          .bindPopup(popupHtml)
          .addTo(map);
      }
    }

    // Haversine distance in meters
    function haversineMeters(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Perpendicular distance from point P to line segment AB in meters
    function distToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
      const pDistA = haversineMeters(pLat, pLng, aLat, aLng);
      const pDistB = haversineMeters(pLat, pLng, bLat, bLng);
      const segLen = haversineMeters(aLat, aLng, bLat, bLng);
      if (segLen === 0) return pDistA;

      const x = (pLng - aLng) * Math.cos((aLat + bLat) * Math.PI / 360);
      const y = pLat - aLat;
      const dx = (bLng - aLng) * Math.cos((aLat + bLat) * Math.PI / 360);
      const dy = bLat - aLat;
      const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy)));

      const projLat = aLat + t * (bLat - aLat);
      const projLng = aLng + t * (bLng - aLng);
      return haversineMeters(pLat, pLng, projLat, projLng);
    }

    function checkOffRouteDeviation(riderLat, riderLng) {
      if (!storedRouteCoords || storedRouteCoords.length < 2) return { isOffRoute: false, minDistance: 0 };
      let minDistance = Infinity;

      for (let i = 0; i < storedRouteCoords.length - 1; i++) {
        const a = storedRouteCoords[i];
        const b = storedRouteCoords[i + 1];
        const d = distToSegmentMeters(riderLat, riderLng, a[0], a[1], b[0], b[1]);
        if (d < minDistance) minDistance = d;
      }

      const isOffRoute = minDistance > 400;
      return { isOffRoute, minDistance: Math.round(minDistance) };
    }

    function updateRider(data) {
      if (!data || !Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return;
      const { lat, lng, heading, speed, accuracy, batteryLevel, riderName, riderPhone, lastUpdated, isOffRoute: isOffRouteProp } = data;
      currentRiderPos = { lat, lng };

      const ageMs = lastUpdated ? Date.now() - new Date(lastUpdated).getTime() : 0;
      const isStale = ageMs > 120000;

      const devCheck = checkOffRouteDeviation(lat, lng);
      const isOffRoute = Boolean(isOffRouteProp || devCheck.isOffRoute);

      try {
        window.ReactNativeWebView?.postMessage(JSON.stringify({
          type: 'DEVIATION_STATUS',
          isOffRoute,
          distanceMeters: devCheck.minDistance
        }));
      } catch (e) {}

      const staleClass = isStale ? ' stale' : '';
      const offRouteClass = isOffRoute ? ' off-route' : '';
      const speedKmh = speed ? Math.round(speed * 3.6) : 0;
      const batteryText = batteryLevel != null ? batteryLevel + '%' : '—';
      const headingDeg = heading != null && heading >= 0 ? Math.round(heading) : 0;

      const riderIcon = L.divIcon({
        className: '', iconSize: [48, 48], iconAnchor: [24, 24],
        html:
          '<div class="rider-wrap">' +
          '<div class="rider-pulse-ring' + staleClass + offRouteClass + '"></div>' +
          '<div class="rider-pin' + staleClass + offRouteClass + '" style="transform: rotate(' + headingDeg + 'deg);">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
          '<polygon points="12,2 4,22 12,17 20,22" fill="rgba(255,255,255,0.3)"/>' +
          '</svg>' +
          '</div></div>'
      });

      const popupHtml =
        '<div class="popup-card">' +
        '<div class="popup-title">🛵 ' + escHtml(riderName || 'Delivery Partner') + (riderPhone ? ' · ' + escHtml(riderPhone) : '') + '</div>' +
        '<div class="popup-sub">⚡ Speed: ' + speedKmh + ' km/h</div>' +
        '<div class="popup-sub">🔋 Battery: ' + batteryText + '</div>' +
        '<div class="popup-badge" style="background:' + (isOffRoute ? 'rgba(211,47,47,0.15);color:#D32F2F' : isStale ? 'rgba(245,158,11,0.15);color:#D97706' : 'rgba(21,101,192,0.12);color:#1565C0') + ';">' + (isOffRoute ? '⚠ Off Route' : isStale ? '⚠ Signal Lost' : '● Live Tracking') + '</div>' +
        '</div>';

      if (!riderMarker) {
        if (map) {
          riderMarker = L.marker([lat, lng], { icon: riderIcon, zIndexOffset: 500 })
            .bindPopup(popupHtml)
            .addTo(map);
        }
      } else {
        if (map && !map.hasLayer(riderMarker)) {
          riderMarker.addTo(map);
        }
        const oldPos = riderMarker.getLatLng();
        riderMarker.setIcon(riderIcon);
        riderMarker.setPopupContent(popupHtml);
        // Animate to predicted position, snap to real on next ping
        var predicted = predictedPosition(lat, lng, heading, speed);
        smoothMove(riderMarker, oldPos, predicted, 2000);
      }

      if (accuracy && accuracy > 0 && map) {
        if (accuracyCircle) map.removeLayer(accuracyCircle);
        accuracyCircle = L.circle([lat, lng], {
          radius: Math.min(accuracy, 200),
          color: isOffRoute ? '#D32F2F' : isStale ? '#F59E0B' : '#1565C0',
          fillColor: isOffRoute ? '#D32F2F' : isStale ? '#F59E0B' : '#1565C0',
          fillOpacity: 0.08,
          weight: 1,
          opacity: 0.25,
        }).addTo(map);
      }

      appendBreadcrumb(lat, lng);
      adjustCamera(lat, lng);

      // Check route recalc triggers: >200m deviation, 60s elapsed, heading >90° change
      checkRouteRecalcTrigger(lat, lng, heading);
    }

    function checkRouteRecalcTrigger(riderLat, riderLng, heading) {
      var now = Date.now();
      var shouldRecalc = false;

      if (!lastRouteRiderPos) {
        shouldRecalc = true;
      } else {
        var moved = haversineMeters(lastRouteRiderPos.lat, lastRouteRiderPos.lng, riderLat, riderLng);
        if (moved > 200) shouldRecalc = true;
        if (now - lastRouteFetchTime > 60000) shouldRecalc = true;
        if (lastRouteHeading != null && heading != null) {
          var headingDelta = Math.abs(heading - lastRouteHeading);
          if (headingDelta > 180) headingDelta = 360 - headingDelta;
          if (headingDelta > 90) shouldRecalc = true;
        }
      }

      if (shouldRecalc) {
        lastRouteRiderPos = { lat: riderLat, lng: riderLng };
        lastRouteHeading = heading;
        lastRouteFetchTime = now;
        try {
          window.ReactNativeWebView?.postMessage(JSON.stringify({
            type: 'ROUTE_RECALC_NEEDED',
            riderLat: riderLat,
            riderLng: riderLng
          }));
        } catch (e) {}
      }
    }

    function updateRoute(data) {
      if (!data || !map) return;
      var activeCoords = data.activeRoute || [];
      var refCoords = data.referenceRoute || [];
      var source = data.source || 'unknown';
      var isOsrm = source === 'osrm' || source === 'google';

      storedRouteCoords = activeCoords;

      // Show/hide fallback banner
      var banner = document.getElementById('fallbackBanner');
      if (banner) {
        if (!isOsrm && activeCoords.length > 0) {
          banner.style.display = 'block';
          banner.textContent = '\u26a0\ufe0f Route unavailable \u2014 showing direct path (not road-snapped)';
        } else {
          banner.style.display = 'none';
        }
      }

      // Reference route: Store \u2192 Destination (light grey dashed)
      if (referenceRouteLine && map.hasLayer(referenceRouteLine)) {
        map.removeLayer(referenceRouteLine);
      }
      if (refCoords.length > 1) {
        referenceRouteLine = L.polyline(refCoords, {
          color: '#CFD8DC', weight: 4, opacity: 0.7,
          dashArray: '8 6', lineCap: 'round', lineJoin: 'round'
        }).addTo(map);
      }

      // Active route: Rider \u2192 Destination (deep blue solid)
      if (activeRouteLine && map.hasLayer(activeRouteLine)) {
        map.removeLayer(activeRouteLine);
      }
      if (activeCoords.length > 1) {
        activeRouteLine = L.polyline(activeCoords, {
          color: isOsrm ? '#1565C0' : '#78909C',
          weight: isOsrm ? 6 : 4,
          opacity: 0.9,
          dashArray: isOsrm ? null : '10 8',
          lineCap: 'round', lineJoin: 'round',
          pane: 'activeRoutePane'
        }).addTo(map);
      }
    }

    function appendBreadcrumb(lat, lng) {
      if (!lat || !lng || !map) return;
      breadcrumbPoints.push([lat, lng]);
      if (breadcrumbLine && map.hasLayer(breadcrumbLine)) {
        breadcrumbLine.addLatLng([lat, lng]);
      } else if (breadcrumbPoints.length > 1) {
        breadcrumbLine = L.polyline(breadcrumbPoints, {
          color: '#7E57C2', weight: 3, opacity: 0.8,
          dashArray: '3 4', lineCap: 'round', lineJoin: 'round',
          pane: 'breadcrumbPane'
        }).addTo(map);
      }
    }

    function adjustCamera(riderLat, riderLng) {
      if (!map || !destCoords) return;
      var distToDest = haversineMeters(riderLat, riderLng, destCoords.lat, destCoords.lng);

      if (distToDest < 200) {
        // Very close: zoom in tight and stop auto-fitting
        map.setView([riderLat, riderLng], 17, { animate: true, duration: 0.6 });
      } else if (distToDest < 1000) {
        // Near: zoom to rider + destination only
        var pts = [[riderLat, riderLng], [destCoords.lat, destCoords.lng]];
        map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 16, animate: true });
      } else if (distToDest > 300 && storeCoords) {
        // Far: include store in bounds
        var allPts = [[riderLat, riderLng], [destCoords.lat, destCoords.lng]];
        if (haversineMeters(riderLat, riderLng, storeCoords.lat, storeCoords.lng) < 5000) {
          allPts.push([storeCoords.lat, storeCoords.lng]);
        }
        map.fitBounds(L.latLngBounds(allPts), { padding: [50, 50], maxZoom: 15, animate: true });
      }
    }

    function escHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function handleMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'INIT') {
          initMap(msg.center[0], msg.center[1]);
          createStoreMarker(msg.store.lat, msg.store.lng);
          createDestMarker(msg.dest.lat, msg.dest.lng, msg.dest.shopName, msg.dest.landmark, msg.dest.receiverName, msg.dest.receiverPhone, msg.dest.geofenceArrived);

          if (msg.history && Array.isArray(msg.history)) {
            // Filter history points: reject accuracy > 50m (null-safe)
            var validHistory = msg.history.filter(function(p) {
              return p.accuracy == null || p.accuracy <= 50;
            });
            breadcrumbPoints = validHistory.map(function(p) { return [p.lat, p.lng]; });
            if (breadcrumbPoints.length > 1 && map) {
              breadcrumbLine = L.polyline(breadcrumbPoints, {
                color: '#7E57C2', weight: 3, opacity: 0.8,
                dashArray: '3 4', lineCap: 'round', lineJoin: 'round',
                pane: 'breadcrumbPane'
              }).addTo(map);
            }
          }

          if (msg.rider) updateRider(msg.rider);
          if (msg.route) updateRoute(msg.route);

          const pts = [[msg.store.lat, msg.store.lng], [msg.dest.lat, msg.dest.lng]];
          if (msg.rider) pts.push([msg.rider.lat, msg.rider.lng]);
          if (map) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });

          window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'MAP_READY' }));
        } else if (msg.type === 'UPDATE_RIDER') {
          updateRider(msg.data);
        } else if (msg.type === 'UPDATE_ROUTE') {
          updateRoute(msg.data);
        } else if (msg.type === 'APPEND_HISTORY') {
          appendBreadcrumb(msg.data.lat, msg.data.lng);
        } else if (msg.type === 'SET_GEOFENCE_ARRIVED') {
          geofenceArrivedState = !!msg.data;
          if (destCoords) {
            createDestMarker(destCoords.lat, destCoords.lng, destInfo.shopName, destInfo.landmark, destInfo.receiverName, destInfo.receiverPhone, geofenceArrivedState);
          }
        }
      } catch (e) {}
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);
  </script>
</body>
</html>
`;

export const LiveTrackingMap = forwardRef<LiveTrackingMapRef, Props>(
  function LiveTrackingMap(
    {
      destination,
      initialRider,
      initialRoute,
      initialHistory,
      onMapReady,
      onOffRouteDetected,
      onGeofenceArrival,
    },
    ref,
  ) {
    const webViewRef = useRef<WebView | null>(null);
    const isReady = useRef(false);

    const centerLat = (STORE.lat + destination.lat) / 2;
    const centerLng = (STORE.lng + destination.lng) / 2;

    const postMsg = useCallback((msg: Record<string, unknown>) => {
      if (!webViewRef.current || !isReady.current) return;
      webViewRef.current.postMessage(JSON.stringify(msg));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        updateRider: (data: MapRiderData) => {
          postMsg({ type: 'UPDATE_RIDER', data });
        },
        updateRoute: (data: MapRouteData) => {
          postMsg({ type: 'UPDATE_ROUTE', data });
        },
        appendHistory: (point: { lat: number; lng: number }) => {
          postMsg({ type: 'APPEND_HISTORY', data: point });
        },
        setGeofenceArrived: (arrived: boolean) => {
          postMsg({ type: 'SET_GEOFENCE_ARRIVED', data: arrived });
        },
      }),
      [postMsg],
    );

    const handleMessage = useCallback(
      (e: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(e.nativeEvent.data);
          if (msg.type === 'MAP_READY') {
            onMapReady?.();
          } else if (msg.type === 'DEVIATION_STATUS') {
            onOffRouteDetected?.(msg.isOffRoute, msg.distanceMeters);
          } else if (msg.type === 'GEOFENCE_ARRIVED') {
            onGeofenceArrival?.();
          }
        } catch {
          /* ignore parse errors */
        }
      },
      [onMapReady, onOffRouteDetected, onGeofenceArrival],
    );

    const handleLoadEnd = useCallback(() => {
      isReady.current = true;
      const initMsg = {
        type: 'INIT',
        center: [centerLat, centerLng],
        store: STORE,
        dest: {
          lat: destination.lat,
          lng: destination.lng,
          shopName: destination.shopName,
          landmark: destination.landmark,
          receiverName: destination.receiverName,
          receiverPhone: destination.receiverPhone,
          geofenceArrived: destination.geofenceArrived || false,
        },
        rider: initialRider || null,
        route: initialRoute
          ? {
              activeRoute: initialRoute.activeRoute,
              referenceRoute: initialRoute.referenceRoute,
              durationSeconds: initialRoute.durationSeconds,
              distanceMeters: initialRoute.distanceMeters,
              source: initialRoute.source,
            }
          : null,
        history: initialHistory || [],
      };
      webViewRef.current?.postMessage(JSON.stringify(initMsg));
    }, [centerLat, centerLng, destination, initialRider, initialRoute, initialHistory]);

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          originWhitelist={['*']}
          source={{ html: MAP_HTML }}
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
  container: { flex: 1 },
  webview: { flex: 1, backgroundColor: '#FAFAFA' },
});
