// replace (from the line `// --- City dropdown (searchable by built-in browser typing) ---`
// down through the entire `loadCities()` function body)
let cities = [];
const API_BASE = window.location.origin;

// --- City dropdowns (multiple selects in a row) ---
let activeSelect = null; // track which select is "current" for removal

const parseDT = (s) => {
  if (!s) return new Date(NaN);
  // "YYYY/MM/DD HH:MM" or "YYYY-MM-DD HH:MM" -> "YYYY-MM-DDTHH:MM"
  const iso = s.replace(/\//g, "-").replace(" ", "T");
  return new Date(iso);
};

// add
const fmt = (s) => (typeof s === "string" ? s.replace("T", " ") : s);

async function loadCities() {
  try {
    const res = await fetch(`${API_BASE}/cities`);
    if (!res.ok) throw new Error(`GET /cities ${res.status}`);
    const data = await res.json();
    cities = Array.isArray(data.cities) ? data.cities : [];
    if (cities.length === 0) throw new Error("No cities returned");
  } catch (err) {
    console.error("Failed to load cities:", err);
    cities = ["Taipei", "Los Angeles", "Atlanta"]; // fallback
    const out = document.getElementById("out");
    const warn = document.createElement("div");
    warn.style.color = "orangered";
    warn.textContent = "Warning: /cities failed, using fallback list (TPE/LAX/ATL).";
    out.prepend(warn);
  }

  // Create the first select
  ensureAtLeastOneSelect();
}

function buildCitySelect() {
  const sel = document.createElement("select");
  sel.className = "";
  sel.style.minWidth = "180px";

  // Placeholder
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "[Select City Name]";
  ph.disabled = false; // allow deselecting to placeholder via user choice
  ph.selected = true;
  sel.appendChild(ph);

  // Options
  const frag = document.createDocumentFragment();
  cities.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    frag.appendChild(opt);
  });
  sel.appendChild(frag);

  // Track focus for "remove city"
  sel.addEventListener("focus", () => { activeSelect = sel; });
  sel.addEventListener("click", () => { activeSelect = sel; });

  return sel;
}

function ensureAtLeastOneSelect() {
  const list = document.getElementById("cityList");
  if (!list.querySelector("select")) {
    list.appendChild(buildCitySelect());
  }
}

// init on DOM ready
document.addEventListener("DOMContentLoaded", loadCities);

// Add / Remove handlers
document.getElementById("addCity").onclick = () => {
  const list = document.getElementById("cityList");
  list.appendChild(buildCitySelect());
};

document.getElementById("removeCity").onclick = () => {
  const list = document.getElementById("cityList");
  const selects = Array.from(list.querySelectorAll("select"));
  if (selects.length <= 1) return; // keep at least one
  const target = activeSelect && list.contains(activeSelect) ? activeSelect : selects[selects.length - 1];
  list.removeChild(target);
  activeSelect = null;
};


// ensure it runs
document.addEventListener("DOMContentLoaded", loadCities);


// time inputs
function fillRange(id, n) {
  const s = document.getElementById(id);
  for (let i=0;i<n;i++){ const o=document.createElement("option"); o.value=i; o.textContent=String(i).padStart(2,"0"); s.appendChild(o); }
}
fillRange("hour", 24); fillRange("minute", 60);
fillRange("endHour", 24); fillRange("endMinute", 60);

// defaults = today/now
const now = new Date();
document.getElementById("dateInput").valueAsDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
document.getElementById("hour").value = now.getHours();
document.getElementById("minute").value = now.getMinutes();

let hasEnd = false;
const rangeToggle = document.getElementById("rangeToggle");
const endWrap = document.getElementById("endWrap");
rangeToggle.addEventListener("change", (e) => {
  hasEnd = e.target.checked;
  endWrap.style.display = hasEnd ? "inline-block" : "none";
  if (hasEnd) {
    // sync end = start on enable
    document.getElementById("endDate").value = document.getElementById("dateInput").value;
  }
});
// keep end date in sync if user changes start date while range is ON
document.getElementById("dateInput").addEventListener("change", () => {
  if (hasEnd) {
    document.getElementById("endDate").value = document.getElementById("dateInput").value;
  }
});

// replace the start of your click handler up to payload creation
document.getElementById("run").onclick = async () => {
  const out = document.getElementById("out");
  out.textContent = "";

  // collect city selections
  const list = document.getElementById("cityList");
  const selections = Array.from(list.querySelectorAll("select"))
    .map(s => s.value.trim())
    .filter(v => v !== "");

  // dedupe while preserving order
  const seen = new Set();
  const chosen = selections.filter(v => (seen.has(v) ? false : (seen.add(v), true)));

  if (chosen.length === 0) { out.textContent = "Pick at least one city."; return; }

  const d = document.getElementById("dateInput").value;
  const h = Number(document.getElementById("hour").value);
  const m = Number(document.getElementById("minute").value);

  const payload = { cities: chosen, date: d, hour: h, minute: m, step_minutes: 30 };
  if (hasEnd) {
    payload.end_date = document.getElementById("endDate").value;
    payload.end_hour = Number(document.getElementById("endHour").value);
    payload.end_minute = Number(document.getElementById("endMinute").value);
  }

  try {
    const r = await fetch(`${API_BASE}/compute`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    renderResult(data);
  } catch (e) {
    out.textContent = "Error contacting API.";
  }
};

function renderVerticalTimeTable(data) {
  const out = document.getElementById("out");

  const rows = data.per_city;                 // objects: {city,start,end}
  const cityNames = rows.map(r => r.city);    // ["Taipei","Los Angeles",...]
  const slotMap = new Map();                  // "HH:MM" -> { City: "partial"/"full" }
  const step = (data.step_minutes || 30);

  // mark per-city windows as "partial"
  rows.forEach(({ city, start, end }) => {
    let s = parseDT(start);
    let e = parseDT(end);
    while (s < e) {
      const key = s.toTimeString().slice(0, 5); // "HH:MM"
      if (!slotMap.has(key)) slotMap.set(key, {});
      slotMap.get(key)[city] = "partial";
      s = new Date(s.getTime() + step * 60000);
    }
  });

  // promote true-overlap slots to "full"
  if (data.overlap) {
    data.overlap.forEach(seg => {
      seg.local.forEach(({ city, start, end }) => {
        let s = parseDT(start);
        let e = parseDT(end);
        while (s < e) {
          const key = s.toTimeString().slice(0, 5);
          if (!slotMap.has(key)) slotMap.set(key, {});
          slotMap.get(key)[city] = "full";
          s = new Date(s.getTime() + step * 60000);
        }
      });
    });
  }

  // build table
  const tbl = document.createElement("table");
  tbl.style.borderCollapse = "collapse";
  tbl.style.marginTop = "16px";
  tbl.style.fontSize = "14px";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Time", ...cityNames].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.padding = "4px 8px";
    th.style.borderBottom = "1px solid #ccc";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  Array.from(slotMap.keys()).sort().forEach(t => {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = t;
    tdTime.style.padding = "4px 8px";
    tdTime.style.borderBottom = "1px solid #eee";
    tr.appendChild(tdTime);

    cityNames.forEach(city => {
      const td = document.createElement("td");
      const status = (slotMap.get(t) || {})[city] || "";
      td.style.width = "64px";
      td.style.height = "20px";
      td.style.borderBottom = "1px solid #eee";
      td.style.background = status === "full" ? "#8fd18f"   // green
                        : status === "partial" ? "#ffd7d7" // red-ish
                        : "";
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  out.appendChild(tbl);
}



function renderResult(data) {
  const out = document.getElementById("out");
  out.innerHTML = "";

  if (data.error) { out.textContent = data.error; return; }

  // Equation string(s) for point conversions
  if (data.type === "ALL_AT_POINT") {
    const parts = [];
    parts.push(`${data.origin.city} ${fmt(data.origin.time)}`);
    // Only include the selected cities, but spec A says "everyone"—for MVP we display the chosen ones first
    data.results.forEach(r => {
      if (true) { // show all; you can filter
        const shift = r.dayShift === 0 ? "" : (r.dayShift > 0 ? " (+1)" : " (-1)");
        parts.push(`${r.city} ${fmt(r.time)}${shift}`);
      }
    });
    const p = document.createElement("div");
    p.className = "eq";
    p.textContent = parts.join("  =  ");
    out.appendChild(p);
    return;
  }

  if (data.type === "PAIR_AT_POINT" || data.type === "N_AT_POINT") {
    const eq = data.equation;
    const p = document.createElement("div"); p.className="eq";
    p.textContent = eq.map(e => `${e.city} ${fmt(e.time)}${e.dayShift? (e.dayShift>0?" (+1)":" (-1)"):""}`).join("  =  ");
    out.appendChild(p);
    return;
  }

  if (data.type === "PAIR_RANGE") {
    const eq = data.equation;
    const p = document.createElement("div"); p.className="eq";
    p.textContent =
        `${eq[0].city} [${fmt(eq[0].start)} – ${fmt(eq[0].end)}]  =  ` +
        `${eq[1].city} [${fmt(eq[1].start)} – ${fmt(eq[1].end)}]`;
    out.appendChild(p);
    // Bars later if you want (range is just two rows)
    return;
  }

  // replace
  if (data.type === "N_SAME_LOCAL") {
    const out = document.getElementById("out");

    // quick textual summary (kept)
    const wrap = document.createElement("div");
    data.per_city.forEach(row => {
        const line = document.createElement("div"); line.className = "eq";
        line.textContent = `${row.city} [${fmt(row.start)} – ${fmt(row.end)}]`;
        wrap.appendChild(line);
    });
    out.appendChild(wrap);

    // list overlap segments (optional)
    if (!data.overlap) {
        const no = document.createElement("div");
        no.textContent = "No overlap";
        out.appendChild(no);
    } else {
        data.overlap.forEach(seg => {
        const p = document.createElement("div"); p.className="eq";
        p.textContent = seg.local.map(l => `${l.city} [${fmt(l.start)} – ${fmt(l.end)}]`).join("  =  ");

        out.appendChild(p);
        });
    }
    // <<< draw the When2Meet-style grid >>>
    renderVerticalTimeTable(data);
    return;
  }
  out.textContent = "Unhandled response.";
}
