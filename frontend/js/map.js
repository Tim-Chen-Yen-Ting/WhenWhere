// frontend/js/map.js
// World map component built on Leaflet (loaded via CDN in index.html), using
// Leaflet's built-in EPSG4326 (plain equirectangular) CRS -- no tile server,
// no API key. Country outlines come from a static CDN-hosted TopoJSON
// (world-atlas), rendered once as a vector layer. Day/night terminator via
// the Leaflet.Terminator plugin. City dots are click/hover-interactive
// circle markers with state-based coloring.
// Public API: window.WWMap = { init, onCityClick, setCityStates }.

(function (global) {
  "use strict";

  const RADII = { neutral: 3, selected: 6, compatible: 4.5, incompatible: 3 };

  let map = null;
  let cityLayer = null;      // L.LayerGroup of circleMarkers
  let markersByCity = Object.create(null);
  let stateByCity = Object.create(null);
  let clickCallbacks = [];
  let terminatorLayer = null;
  let terminatorIntervalId = null;

  function token(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function colorForState(state) {
    switch (state) {
      case "selected": return token("--dot-selected", "#4fc3f7");
      case "compatible": return token("--good", "#4ade80");
      case "incompatible": return token("--bad", "#f87171");
      default: return token("--dot-default", "#cfd8ee");
    }
  }

  function applyMarkerState(cityName) {
    const marker = markersByCity[cityName];
    if (!marker) return;
    const state = stateByCity[cityName] || "neutral";
    const color = colorForState(state);
    marker.setStyle({
      radius: RADII[state] !== undefined ? RADII[state] : RADII.neutral,
      color: color,
      fillColor: color,
      fillOpacity: state === "incompatible" ? 0.35 : 0.85,
      weight: state === "selected" ? 2 : 1,
    });
    if (state === "selected") marker.bringToFront();
  }

  function buildCountryOutlines(map) {
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((r) => r.json())
      .then((worldData) => {
        if (typeof topojson === "undefined") return;
        const geo = topojson.feature(worldData, worldData.objects.countries);
        L.geoJSON(geo, {
          style: {
            color: token("--map-land-border", "#8c7f5c"),
            weight: 1,
            fillColor: token("--map-land", "#d9c68a"),
            fillOpacity: 1,
          },
          interactive: false,
          pane: "countries",
        }).addTo(map);
      })
      .catch((err) => console.error("WWMap: failed to load world outline", err));
  }

  function buildTerminator(map) {
    function refresh() {
      if (terminatorLayer) map.removeLayer(terminatorLayer);
      if (typeof L.terminator !== "function") return;
      terminatorLayer = L.terminator({
        fillColor: token("--night-overlay", "#03060e"),
        fillOpacity: 0.45,
        stroke: false,
        interactive: false,
        pane: "terminator",
      });
      terminatorLayer.addTo(map);
    }
    refresh();
    terminatorIntervalId = setInterval(refresh, 60000);
  }

  function buildCityMarkers(map, cities) {
    cityLayer = L.layerGroup().addTo(map);
    markersByCity = Object.create(null);

    for (const record of cities) {
      const marker = L.circleMarker([record.lat, record.lon], {
        radius: RADII.neutral,
        color: colorForState("neutral"),
        fillColor: colorForState("neutral"),
        fillOpacity: 0.85,
        weight: 1,
        pane: "cityMarkers",
      });
      marker.bindTooltip(record.city, { direction: "top", offset: [0, -4] });
      marker.on("click", () => {
        pulse(marker.getLatLng());
        for (const cb of clickCallbacks) {
          try { cb(record); } catch (err) { console.error("WWMap: onCityClick handler threw", err); }
        }
      });
      marker.addTo(cityLayer);
      markersByCity[record.city] = marker;
    }
    for (const name in markersByCity) applyMarkerState(name);
  }

  // Leaflet circleMarkers render as SVG <path> elements, so the CSS "r"
  // property (which only animates native <circle>/<ellipse>) can't drive an
  // expanding-ring effect here. Instead, spawn a short-lived separate marker
  // and animate it with CSS transform:scale() (transform-box:fill-box makes
  // that scale around the path's own center -- see map.css).
  function pulse(latlng) {
    if (!map) return;
    const ring = L.circleMarker(latlng, {
      radius: 8,
      fill: false,
      color: token("--accent", "#4fc3f7"),
      weight: 2,
      opacity: 0.85,
      interactive: false,
      className: "ww-pulse",
      pane: "cityMarkers",
    }).addTo(map);
    setTimeout(() => { if (map) map.removeLayer(ring); }, 650);
  }

  function ensureCities(cities, cb) {
    if (Array.isArray(cities) && cities.length) { cb(cities); return; }
    fetch("/city_data")
      .then((r) => r.json())
      .then((data) => cb((data && data.cities) || []))
      .catch((err) => console.error("WWMap: failed to load /city_data", err));
  }

  function teardown() {
    if (terminatorIntervalId !== null) { clearInterval(terminatorIntervalId); terminatorIntervalId = null; }
    if (map) { map.remove(); map = null; }
  }

  // ---- public API -----------------------------------------------------

  function init(containerEl, cities) {
    if (!containerEl) throw new Error("WWMap.init: containerEl is required");
    if (typeof L === "undefined") throw new Error("WWMap.init: Leaflet (L) is not loaded");
    teardown();

    map = L.map(containerEl, {
      crs: L.CRS.EPSG4326,
      center: [20, 0],
      zoom: 2,
      minZoom: 1,
      maxZoom: 7,
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0,
      worldCopyJump: false,
      zoomControl: true,
      attributionControl: false,
    });

    // Dedicated panes with explicit z-index, so paint order is guaranteed
    // regardless of which layer's async fetch (world outline vs city data)
    // happens to resolve first -- Leaflet's shared default overlayPane
    // stacks strictly by DOM-insertion order, which is a race otherwise.
    map.createPane("countries").style.zIndex = 200;
    map.createPane("terminator").style.zIndex = 350;
    map.createPane("cityMarkers").style.zIndex = 450;

    buildCountryOutlines(map);
    buildTerminator(map);
    ensureCities(cities, (list) => buildCityMarkers(map, list));
  }

  function onCityClick(callback) {
    if (typeof callback === "function") clickCallbacks.push(callback);
  }

  function setCityStates(newStateByCity) {
    stateByCity = newStateByCity || Object.create(null);
    for (const name in markersByCity) applyMarkerState(name);
  }

  global.WWMap = { init, onCityClick, setCityStates };
})(typeof window !== "undefined" ? window : globalThis);
