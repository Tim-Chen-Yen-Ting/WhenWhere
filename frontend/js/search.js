// frontend/js/search.js
// City search / autocomplete bar. Mounts into #search-input + #search-results
// (both already in index.html). Fetches the city list once from GET /city_data
// and does all matching client-side -- no timezone math here, that all lives
// in tzmath.js and is untouched by this file.

(function (global) {
  "use strict";

  // Mirrors backend/logic/scheduler.py's ALIASES exactly, so search surfaces
  // the same shortcuts the API itself accepts.
  const ALIASES = {
    la: "Los Angeles",
    lax: "Los Angeles",
    atl: "Atlanta",
    tpe: "Taipei",
    taipei: "Taipei",
    nyc: "New York",
    sf: "San Francisco",
  };

  const MAX_RESULTS = 8;
  const BLUR_HIDE_DELAY_MS = 120;

  let inputEl = null;
  let resultsEl = null;
  let onSelectCb = null;

  let cities = [];
  let currentMatches = [];
  let highlightIndex = -1;

  function normalizeQuery(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  // Match if every whitespace-split word of the (also split) typed query is a
  // prefix of some word in the city name, case-insensitive, in any order --
  // so "new york" matches "New York" ("new"->"New", "york"->"York"), not just
  // single-word queries. Sorted alphabetically.
  // An exact alias-key hit (on the whole trimmed query) also surfaces its
  // target city, even if it wouldn't otherwise prefix-match. Capped at
  // MAX_RESULTS after merge+sort.
  function computeMatches(rawQuery) {
    const q = normalizeQuery(rawQuery);
    if (!q) return [];

    const queryWords = q.split(/\s+/).filter(Boolean);

    const seen = new Set();
    const results = [];

    for (const c of cities) {
      const cityWords = c.city.toLowerCase().split(/\s+/);
      const matches = queryWords.every((qw) => cityWords.some((cw) => cw.startsWith(qw)));
      if (matches) {
        if (!seen.has(c.city)) {
          seen.add(c.city);
          results.push(c);
        }
      }
    }

    const aliasTargetName = ALIASES[q];
    if (aliasTargetName && !seen.has(aliasTargetName)) {
      const aliasCity = cities.find((c) => c.city === aliasTargetName);
      if (aliasCity) {
        seen.add(aliasCity.city);
        results.push(aliasCity);
      }
    }

    results.sort((a, b) => a.city.localeCompare(b.city));
    return results.slice(0, MAX_RESULTS);
  }

  function renderResults() {
    resultsEl.innerHTML = "";

    if (!currentMatches.length) {
      resultsEl.hidden = true;
      inputEl.setAttribute("aria-expanded", "false");
      return;
    }

    const frag = document.createDocumentFragment();
    currentMatches.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "search-result" + (i === highlightIndex ? " is-highlighted" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === highlightIndex ? "true" : "false");
      row.dataset.index = String(i);

      const nameEl = document.createElement("span");
      nameEl.className = "search-result-city";
      nameEl.textContent = c.city;

      const tzEl = document.createElement("span");
      tzEl.className = "search-result-tz";
      tzEl.textContent = c.timezone;

      row.appendChild(nameEl);
      row.appendChild(tzEl);
      frag.appendChild(row);
    });
    resultsEl.appendChild(frag);

    resultsEl.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
  }

  function updateHighlightClasses() {
    const rows = resultsEl.children;
    for (let i = 0; i < rows.length; i++) {
      const isHi = i === highlightIndex;
      rows[i].classList.toggle("is-highlighted", isHi);
      rows[i].setAttribute("aria-selected", isHi ? "true" : "false");
    }
    if (highlightIndex >= 0 && rows[highlightIndex]) {
      rows[highlightIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function moveHighlight(delta) {
    if (!currentMatches.length) return;
    if (highlightIndex === -1) {
      highlightIndex = delta > 0 ? 0 : currentMatches.length - 1;
    } else {
      highlightIndex = (highlightIndex + delta + currentMatches.length) % currentMatches.length;
    }
    updateHighlightClasses();
  }

  function closeDropdown() {
    resultsEl.hidden = true;
    inputEl.setAttribute("aria-expanded", "false");
    highlightIndex = -1;
  }

  function selectCity(record) {
    if (!record) return;
    inputEl.value = "";
    currentMatches = [];
    highlightIndex = -1;
    resultsEl.innerHTML = "";
    resultsEl.hidden = true;
    inputEl.setAttribute("aria-expanded", "false");
    inputEl.focus();
    if (typeof onSelectCb === "function") onSelectCb(record);
  }

  function handleInput() {
    currentMatches = computeMatches(inputEl.value);
    highlightIndex = -1;
    renderResults();
  }

  function handleFocus() {
    if (inputEl.value.trim() && currentMatches.length) {
      renderResults();
    }
  }

  function handleBlur() {
    // Delay so a click/mousedown on a result row can still register before
    // the dropdown disappears out from under it.
    global.setTimeout(closeDropdown, BLUR_HIDE_DELAY_MS);
  }

  function handleKeydown(e) {
    switch (e.key) {
      case "ArrowDown":
        if (!currentMatches.length) return;
        e.preventDefault();
        moveHighlight(1);
        break;
      case "ArrowUp":
        if (!currentMatches.length) return;
        e.preventDefault();
        moveHighlight(-1);
        break;
      case "Enter": {
        if (resultsEl.hidden || !currentMatches.length) return;
        e.preventDefault();
        const idx = highlightIndex >= 0 ? highlightIndex : 0;
        selectCity(currentMatches[idx]);
        break;
      }
      case "Escape":
        if (!resultsEl.hidden) {
          e.preventDefault();
          closeDropdown();
        }
        break;
      default:
        break;
    }
  }

  function handleResultsMousedown(e) {
    // Results rows aren't focusable, so this normally isn't needed to keep
    // input focus -- but prevent default defensively so a click always lands.
    e.preventDefault();
  }

  function handleResultsClick(e) {
    const row = e.target.closest(".search-result");
    if (!row || !resultsEl.contains(row)) return;
    const idx = Number(row.dataset.index);
    if (Number.isNaN(idx) || !currentMatches[idx]) return;
    selectCity(currentMatches[idx]);
  }

  function wireEvents() {
    inputEl.setAttribute("role", "combobox");
    inputEl.setAttribute("aria-autocomplete", "list");
    inputEl.setAttribute("aria-expanded", "false");
    if (resultsEl.id) inputEl.setAttribute("aria-controls", resultsEl.id);
    resultsEl.setAttribute("role", "listbox");

    inputEl.addEventListener("input", handleInput);
    inputEl.addEventListener("keydown", handleKeydown);
    inputEl.addEventListener("focus", handleFocus);
    inputEl.addEventListener("blur", handleBlur);
    resultsEl.addEventListener("mousedown", handleResultsMousedown);
    resultsEl.addEventListener("click", handleResultsClick);
  }

  async function loadCities() {
    try {
      const res = await fetch("/city_data");
      const data = await res.json();
      cities = Array.isArray(data && data.cities) ? data.cities : [];
    } catch (err) {
      cities = [];
      if (global.console && console.error) {
        console.error("WWSearch: failed to load /city_data", err);
      }
    }
  }

  function init(inputElArg, resultsElArg, onSelect) {
    inputEl = inputElArg;
    resultsEl = resultsElArg;
    onSelectCb = onSelect;

    if (!inputEl || !resultsEl) {
      throw new Error("WWSearch.init requires an input element and a results element");
    }

    wireEvents();
    return loadCities();
  }

  global.WWSearch = { init };
})(typeof window !== "undefined" ? window : globalThis);
