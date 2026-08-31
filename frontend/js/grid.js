// frontend/js/grid.js
// Renders the when2meet-style range-overlap grid into #grid-root.
//
// For every selected city we render a two-row block:
//   Row A (header): that city's own local-hour label for each of 24
//                    consecutive, shared UTC hour-boundaries.
//   Row B (status):  a cell per boundary, filled to show how much of that
//                    hour (for that city, at that instant) falls inside the
//                    exact overlap window computed by tzmath.overlapSameLocal.
//
// Column K means the exact same real-world UTC instant in every city's row
// (only the label text differs, per-city). Boundary cells that straddle the
// exact (minute-precision) overlap start/end are given a partial CSS fill so
// an 18:45 boundary reads as 75% into that hour's cell, not fully in/out.
//
// Public API: window.WWGrid = { render(containerEl, overlapResult, cities), clear(containerEl) }

(function (global) {
  "use strict";

  const HOURS = 24;
  const MS_PER_HOUR = 3600000;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function clear(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = "";
  }

  // Floor a UTC Date down to the start of its UTC hour.
  function floorToHour(utcDate) {
    return new Date(Date.UTC(
      utcDate.getUTCFullYear(),
      utcDate.getUTCMonth(),
      utcDate.getUTCDate(),
      utcDate.getUTCHours(), 0, 0, 0
    ));
  }

  // 25 consecutive UTC hour-boundaries (24 columns) starting at the floor
  // of `anchorInstant`. Since every per-city window is at most 24h wide,
  // and the overlap (when it exists) is a sub-interval of every per-city
  // window, this 24h span always fully contains the overlap window when
  // anchorInstant is the overlap's own start.
  function buildBoundaries(anchorInstant) {
    const start = floorToHour(anchorInstant);
    const boundaries = [];
    for (let i = 0; i <= HOURS; i++) {
      boundaries.push(new Date(start.getTime() + i * MS_PER_HOUR));
    }
    return boundaries;
  }

  // Resolve the shared UTC instant the 24h column window should be built
  // around: the overlap's start when one exists, otherwise the first
  // city's own desired-window start (perCity[0].start), converted back to
  // a UTC instant via tzmath.
  function resolveAnchorInstant(overlapResult, cities) {
    const overlap = overlapResult && overlapResult.overlap;
    if (overlap && overlap.utcStart) return overlap.utcStart;

    const perCity = (overlapResult && overlapResult.perCity) || [];
    const first = perCity[0];
    const firstCity = cities && cities[0];
    if (first && firstCity) {
      const s = first.start;
      return global.tzmath.zonedWallTimeToUtc(
        firstCity.timezone, s.year, s.month, s.day, s.hour, s.minute
      );
    }
    return new Date();
  }

  // How a single [cellStart, cellEnd) UTC hour cell relates to the overlap
  // window: fully outside, fully inside, or partially inside (with the
  // fraction of the cell, left-to-right, that is inside).
  function cellOverlapState(cellStart, cellEnd, overlap) {
    if (!overlap) return { state: "none" };
    const oStart = overlap.utcStart.getTime();
    const oEnd = overlap.utcEnd.getTime();
    const cs = cellStart.getTime();
    const ce = cellEnd.getTime();
    if (oEnd <= cs || oStart >= ce) return { state: "none" };
    if (oStart <= cs && oEnd >= ce) return { state: "full" };
    const lo = Math.max(oStart, cs);
    const hi = Math.min(oEnd, ce);
    return {
      state: "partial",
      fracStart: (lo - cs) / (ce - cs),
      fracEnd: (hi - cs) / (ce - cs),
    };
  }

  function statusCellStyle(info) {
    if (info.state === "full") return "background: var(--good);";
    if (info.state === "none") return "";
    // partial: hard-edged gradient, left-to-right = earlier-to-later within the hour.
    const a = Math.round(info.fracStart * 1000) / 10; // percent, 1dp
    const b = Math.round(info.fracEnd * 1000) / 10;
    return (
      "background: linear-gradient(to right, " +
      `var(--panel-border) 0%, var(--panel-border) ${a}%, ` +
      `var(--good) ${a}%, var(--good) ${b}%, ` +
      `var(--panel-border) ${b}%, var(--panel-border) 100%);`
    );
  }

  function fmtHM(parts) {
    return pad2(parts.hour) + ":" + pad2(parts.minute);
  }

  // Exact per-city readout of the overlap window (never rounded), so the
  // minute-precision result is always available as text even where the
  // visual partial-fill is hard to read at small cell sizes.
  function renderExactTimes(overlap) {
    const wrap = document.createElement("div");
    wrap.className = "ww-grid-exact";
    overlap.local.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "ww-grid-exact-row";

      const name = document.createElement("span");
      name.className = "ww-grid-exact-city";
      name.textContent = entry.city;

      const crossesDay = global.tzmath.dayShift(entry.start, entry.end) !== 0;
      const time = document.createElement("span");
      time.className = "ww-grid-exact-time";
      time.textContent =
        fmtHM(entry.start) + "–" + fmtHM(entry.end) + (crossesDay ? " (+1d)" : "") +
        " " + entry.utcOffsetStart;

      row.appendChild(name);
      row.appendChild(time);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderCityBlock(city, boundaries, overlap) {
    const block = document.createElement("div");
    block.className = "ww-grid-city";
    block.style.gridTemplateColumns = `var(--ww-label-w) repeat(${HOURS}, var(--ww-cell-w))`;

    const label = document.createElement("div");
    label.className = "ww-grid-label";
    label.textContent = city.city;
    label.title = city.city + " (" + city.timezone + ")";
    block.appendChild(label);

    for (let i = 0; i < HOURS; i++) {
      const cellStart = boundaries[i];
      const parts = global.tzmath.partsAt(city.timezone, cellStart);
      const header = document.createElement("div");
      header.className = "ww-grid-hour";
      header.textContent = fmtHM(parts);
      block.appendChild(header);
    }

    for (let i = 0; i < HOURS; i++) {
      const cellStart = boundaries[i];
      const cellEnd = boundaries[i + 1];
      const info = cellOverlapState(cellStart, cellEnd, overlap);
      const cell = document.createElement("div");
      cell.className = "ww-grid-status is-" + info.state;
      const style = statusCellStyle(info);
      if (style) cell.setAttribute("style", style);

      const startParts = global.tzmath.partsAt(city.timezone, cellStart);
      const endParts = global.tzmath.partsAt(city.timezone, cellEnd);
      cell.title = city.city + ": " + fmtHM(startParts) + "–" + fmtHM(endParts) +
        (info.state === "none" ? " (not in common window)" : " (in common window)");

      block.appendChild(cell);
    }

    return block;
  }

  function render(containerEl, overlapResult, cities) {
    clear(containerEl);
    if (!containerEl) return;
    if (!cities || cities.length === 0) return;
    if (!global.tzmath) return;

    const overlap = overlapResult && overlapResult.overlap ? overlapResult.overlap : null;
    const anchorInstant = resolveAnchorInstant(overlapResult, cities);
    const boundaries = buildBoundaries(anchorInstant);

    const root = document.createElement("div");
    root.className = "ww-grid";

    const status = document.createElement("div");
    if (overlap) {
      const minutes = Math.round((overlap.utcEnd.getTime() - overlap.utcStart.getTime()) / 60000);
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const durationLabel = (h > 0 ? h + "h " : "") + (m > 0 || h === 0 ? m + "m" : "");
      status.className = "ww-grid-status-msg is-good";
      status.textContent = "Common window found — " + durationLabel + " overlap for all " + cities.length + " cities.";
    } else {
      status.className = "ww-grid-status-msg is-bad";
      status.textContent = "No common window — these cities' selected local hours never overlap.";
    }
    root.appendChild(status);

    if (overlap) {
      root.appendChild(renderExactTimes(overlap));
    }

    const scroll = document.createElement("div");
    scroll.className = "ww-grid-scroll";
    cities.forEach((city) => {
      scroll.appendChild(renderCityBlock(city, boundaries, overlap));
    });
    root.appendChild(scroll);

    containerEl.appendChild(root);
  }

  const WWGrid = { render, clear };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WWGrid;
  } else {
    global.WWGrid = WWGrid;
  }
})(typeof window !== "undefined" ? window : globalThis);
