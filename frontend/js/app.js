// frontend/js/app.js
// Integration/wiring layer. Owns all app-level state; the map/clock/search/grid
// modules are stateless-ish components driven through their public APIs.

(function () {
  "use strict";

  const state = {
    cityData: [],           // full [{city, timezone, lat, lon}] from /city_data
    cityByName: new Map(),  // city -> record
    workingSet: [],         // [{city, timezone, lat, lon, clock: instance|null}]
    mode: "point",          // "point" | "range"
    format: "24h",          // "24h" | "12h"
    anchorUtc: new Date(),  // point mode: the instant driving every displayed clock
    anchorCity: null,       // point mode: whose LOCAL calendar date dayShift badges are relative to
    range: {
      anchorDate: dateParts(new Date()),
      startWall: { hour: 9, minute: 0 },
      endWall: { hour: 17, minute: 0 },
    },
  };

  function dateParts(d) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  const els = {
    workingCities: document.getElementById("working-cities"),
    emptyHint: document.getElementById("empty-hint"),
    modePoint: document.getElementById("mode-point"),
    modeRange: document.getElementById("mode-range"),
    formatToggle: document.getElementById("format-toggle"),
    rangeWindow: document.getElementById("range-window"),
    rangeStartMount: document.getElementById("range-start-clock"),
    rangeEndMount: document.getElementById("range-end-clock"),
    gridRoot: document.getElementById("grid-root"),
    searchInput: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    mapRoot: document.getElementById("map-root"),
  };

  let rangeStartClock = null;
  let rangeEndClock = null;

  // ---- city set management ----

  function addCity(rec) {
    if (state.cityByName.has(rec.city) === false) return;
    if (state.workingSet.some((c) => c.city === rec.city)) return;
    state.workingSet.push({ city: rec.city, timezone: rec.timezone, lat: rec.lat, lon: rec.lon, clock: null });
    if (!state.anchorCity) state.anchorCity = rec.city; // first city added becomes the initial dayShift reference
    renderWorkingList();
    recompute();
  }

  function removeCity(cityName) {
    const idx = state.workingSet.findIndex((c) => c.city === cityName);
    if (idx === -1) return;
    const entry = state.workingSet[idx];
    if (entry.clock) entry.clock.destroy();
    state.workingSet.splice(idx, 1);
    if (state.anchorCity === cityName) {
      state.anchorCity = state.workingSet.length > 0 ? state.workingSet[0].city : null;
    }
    renderWorkingList();
    recompute();
  }

  // ---- rendering the working list ----

  function renderWorkingList() {
    els.workingCities.innerHTML = "";
    els.emptyHint.classList.toggle("is-hidden", state.workingSet.length > 0);

    for (const entry of state.workingSet) {
      const row = document.createElement("div");
      row.className = "city-row";
      row.dataset.city = entry.city;

      const head = document.createElement("div");
      head.className = "city-row-head";

      const name = document.createElement("span");
      name.className = "city-name";
      name.textContent = entry.city;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "city-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", `Remove ${entry.city}`);
      removeBtn.onclick = () => removeCity(entry.city);

      head.appendChild(name);
      head.appendChild(removeBtn);
      row.appendChild(head);

      if (state.mode === "point" && window.WWClock) {
        const mount = document.createElement("div");
        mount.className = "city-clock-mount";
        row.appendChild(mount);
        entry.clock = window.WWClock.create(mount, {
          timezone: entry.timezone,
          utcInstant: state.anchorUtc,
          format: state.format,
          onChange: (newUtcInstant) => {
            state.anchorUtc = newUtcInstant;
            state.anchorCity = entry.city; // editing a city's clock makes IT the dayShift reference
            recompute();
          },
        });
      } else {
        entry.clock = null;
      }

      els.workingCities.appendChild(row);
    }
  }

  // ---- point mode: every city displays its own local wall time at the same UTC instant ----

  function recomputePoint() {
    if (!window.tzmath) return;
    // dayShift badges are relative to the ANCHOR CITY's own local calendar
    // date, not UTC's -- otherwise the anchor city itself would show a
    // spurious badge whenever its local date and UTC's date happen to
    // differ (e.g. late evening in a western-hemisphere city).
    const anchorEntry = state.workingSet.find((e) => e.city === state.anchorCity) || state.workingSet[0];
    const anchorParts = anchorEntry
      ? window.tzmath.partsAt(anchorEntry.timezone, state.anchorUtc)
      : window.tzmath.partsAt("UTC", state.anchorUtc);
    for (const entry of state.workingSet) {
      if (!entry.clock) continue;
      entry.clock.setUtcInstant(state.anchorUtc);
      const parts = window.tzmath.partsAt(entry.timezone, state.anchorUtc);
      entry.clock.setDayShift(window.tzmath.dayShift(anchorParts, parts));
    }
    if (window.WWMap) {
      const states = {};
      for (const entry of state.workingSet) states[entry.city] = "selected";
      window.WWMap.setCityStates(states);
    }
  }

  // ---- range mode: exact N-city same-local-window overlap ----

  function recomputeRange() {
    if (!window.tzmath || !window.WWGrid) return;
    if (state.workingSet.length < 2) {
      window.WWGrid.clear(els.gridRoot);
      if (window.WWMap) {
        const sel = {};
        for (const entry of state.workingSet) sel[entry.city] = "selected";
        window.WWMap.setCityStates(sel);
      }
      return;
    }

    const cities = state.workingSet.map((c) => ({ city: c.city, timezone: c.timezone }));
    const result = window.tzmath.overlapSameLocal(cities, state.range.anchorDate, state.range.startWall, state.range.endWall);
    window.WWGrid.render(els.gridRoot, result, cities);

    if (window.WWMap) {
      const cityStates = {};
      for (const entry of state.workingSet) cityStates[entry.city] = "selected";
      if (result.overlap) {
        const { utcStart, utcEnd } = result.overlap;
        for (const rec of state.cityData) {
          if (cityStates[rec.city]) continue; // already "selected"
          const ok = window.tzmath.stillOverlaps(utcStart, utcEnd, rec.timezone, state.range.anchorDate, state.range.startWall, state.range.endWall);
          cityStates[rec.city] = ok ? "compatible" : "incompatible";
        }
      }
      window.WWMap.setCityStates(cityStates);
    }
  }

  function recompute() {
    if (state.mode === "point") recomputePoint();
    else recomputeRange();
  }

  // ---- mode + format toggles ----

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    els.modePoint.classList.toggle("is-active", mode === "point");
    els.modeRange.classList.toggle("is-active", mode === "range");
    els.rangeWindow.hidden = mode !== "range";
    els.gridRoot.hidden = mode !== "range";
    renderWorkingList(); // point mode mounts per-city clocks; range mode doesn't
    recompute();
  }

  function setFormat(fmt) {
    state.format = fmt;
    els.formatToggle.textContent = fmt === "24h" ? "24h" : "12h";
    for (const entry of state.workingSet) {
      if (entry.clock) entry.clock.setFormat(fmt);
    }
    if (rangeStartClock) rangeStartClock.setFormat(fmt);
    if (rangeEndClock) rangeEndClock.setFormat(fmt);
  }

  els.modePoint.addEventListener("click", () => setMode("point"));
  els.modeRange.addEventListener("click", () => setMode("range"));
  els.formatToggle.addEventListener("click", () => setFormat(state.format === "24h" ? "12h" : "24h"));

  // ---- range start/end clocks (wall-clock only, timezone-neutral: use UTC as the neutral zone) ----

  function initRangeClocks() {
    if (!window.WWClock || !window.tzmath) return;
    const startUtc = window.tzmath.zonedWallTimeToUtc("UTC", state.range.anchorDate.year, state.range.anchorDate.month, state.range.anchorDate.day, state.range.startWall.hour, state.range.startWall.minute);
    const endUtc = window.tzmath.zonedWallTimeToUtc("UTC", state.range.anchorDate.year, state.range.anchorDate.month, state.range.anchorDate.day, state.range.endWall.hour, state.range.endWall.minute);

    rangeStartClock = window.WWClock.create(els.rangeStartMount, {
      timezone: "UTC",
      utcInstant: startUtc,
      format: state.format,
      onChange: (newUtc) => {
        const p = window.tzmath.partsAt("UTC", newUtc);
        state.range.startWall = { hour: p.hour, minute: p.minute };
        recompute();
      },
    });
    rangeEndClock = window.WWClock.create(els.rangeEndMount, {
      timezone: "UTC",
      utcInstant: endUtc,
      format: state.format,
      onChange: (newUtc) => {
        const p = window.tzmath.partsAt("UTC", newUtc);
        state.range.endWall = { hour: p.hour, minute: p.minute };
        recompute();
      },
    });
  }

  // ---- boot ----

  async function boot() {
    const res = await fetch("/city_data");
    const data = await res.json();
    state.cityData = data.cities;
    for (const rec of state.cityData) state.cityByName.set(rec.city, rec);

    if (window.WWMap) {
      window.WWMap.init(els.mapRoot, state.cityData);
      window.WWMap.onCityClick((rec) => addCity(rec));
    }
    if (window.WWSearch) {
      window.WWSearch.init(els.searchInput, els.searchResults, (rec) => addCity(rec));
    }
    initRangeClocks();

    // Nice-to-have default: if the browser's own timezone matches a known city, start with it selected.
    try {
      const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const match = state.cityData.find((c) => c.timezone === deviceTz);
      if (match) addCity(match);
    } catch (e) {
      /* Intl.resolvedOptions is always available in modern browsers; ignore if not */
    }

    renderWorkingList();
    recompute();
  }

  boot();
})();
