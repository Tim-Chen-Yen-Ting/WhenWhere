// frontend/js/clock.js
// Reusable "digital clock" display + editor widget. Instantiated once per
// working-set city (point mode) plus twice more for the range-mode start/end
// pickers, so this is a factory (WWClock.create), never a singleton.
//
// All timezone math is delegated to window.tzmath -- this file only ever
// reads/writes wall-clock numbers and hands them to tzmath.zonedWallTimeToUtc
// / tzmath.partsAt for conversion.

(function (global) {
  "use strict";

  const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function displayHour12(hour24) {
    const h = hour24 % 12;
    return h === 0 ? 12 : h;
  }

  function create(containerEl, options) {
    if (!containerEl) throw new Error("WWClock.create requires a container element");
    const opts = options || {};
    if (!opts.timezone) throw new Error("WWClock.create requires options.timezone");
    const tzmath = global.tzmath;
    if (!tzmath) throw new Error("WWClock.create requires window.tzmath to be loaded first");

    const state = {
      timezone: opts.timezone,
      format: opts.format === "12h" ? "12h" : "24h",
      editable: opts.editable !== false,
      onChange: typeof opts.onChange === "function" ? opts.onChange : function () {},
      dayShift: 0,
      utcInstant: opts.utcInstant instanceof Date ? opts.utcInstant : new Date(),
      parts: null,
    };
    state.parts = tzmath.partsAt(state.timezone, state.utcInstant);

    // ---- DOM construction ----

    const root = document.createElement("div");
    root.className = "ww-clock";

    const fmtBtn = document.createElement("button");
    fmtBtn.type = "button";
    fmtBtn.className = "ww-clock-fmt-toggle";
    fmtBtn.setAttribute("aria-label", "Toggle 12h/24h format");

    const badge = document.createElement("div");
    badge.className = "ww-clock-badge";
    badge.hidden = true;

    const timeRow = document.createElement("div");
    timeRow.className = "ww-clock-time";

    function makeSegment(field) {
      const seg = document.createElement("span");
      seg.className = "ww-clock-seg ww-clock-seg-" + field;
      seg.dataset.field = field;
      seg.tabIndex = 0;
      seg.setAttribute("role", "spinbutton");

      const text = document.createElement("span");
      text.className = "ww-clock-seg-text";

      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.autocomplete = "off";
      input.maxLength = 2;
      input.className = "ww-clock-seg-input";
      input.hidden = true;

      seg.appendChild(text);
      seg.appendChild(input);
      return { seg, text, input, field };
    }

    const hourSeg = makeSegment("hour");
    const minuteSeg = makeSegment("minute");

    const colon = document.createElement("span");
    colon.className = "ww-clock-colon";
    colon.textContent = ":";

    const ampm = document.createElement("span");
    ampm.className = "ww-clock-ampm";
    ampm.hidden = true;
    ampm.tabIndex = 0;

    timeRow.appendChild(hourSeg.seg);
    timeRow.appendChild(colon);
    timeRow.appendChild(minuteSeg.seg);
    timeRow.appendChild(ampm);

    const dateLine = document.createElement("div");
    dateLine.className = "ww-clock-date";

    const offsetLine = document.createElement("div");
    offsetLine.className = "ww-clock-offset";

    root.appendChild(fmtBtn);
    root.appendChild(badge);
    root.appendChild(timeRow);
    root.appendChild(dateLine);
    root.appendChild(offsetLine);

    containerEl.appendChild(root);

    // ---- render ----

    function render() {
      root.classList.toggle("is-readonly", !state.editable);
      const p = state.parts;

      if (state.format === "12h") {
        hourSeg.text.textContent = pad2(displayHour12(p.hour));
        ampm.hidden = false;
        ampm.textContent = p.hour >= 12 ? "PM" : "AM";
        hourSeg.seg.setAttribute("aria-valuemin", "1");
        hourSeg.seg.setAttribute("aria-valuemax", "12");
      } else {
        hourSeg.text.textContent = pad2(p.hour);
        ampm.hidden = true;
        hourSeg.seg.setAttribute("aria-valuemin", "0");
        hourSeg.seg.setAttribute("aria-valuemax", "23");
      }
      hourSeg.seg.setAttribute("aria-valuenow", String(p.hour));
      minuteSeg.text.textContent = pad2(p.minute);
      minuteSeg.seg.setAttribute("aria-valuemin", "0");
      minuteSeg.seg.setAttribute("aria-valuemax", "59");
      minuteSeg.seg.setAttribute("aria-valuenow", String(p.minute));

      dateLine.textContent = p.weekday + ", " + MONTH_ABBR[p.month - 1] + " " + p.day;

      const offMin = tzmath.offsetMinutesAt(state.timezone, state.utcInstant);
      offsetLine.textContent = tzmath.utcOffsetLabel(offMin);

      badge.hidden = state.dayShift === 0;
      badge.textContent = (state.dayShift > 0 ? "+" : "") + state.dayShift;

      fmtBtn.textContent = state.format === "24h" ? "24h" : "12h";
    }

    // ---- core mutation: everything funnels through setWallEpoch, which
    // re-derives the UTC instant via tzmath.zonedWallTimeToUtc and re-reads
    // canonical wall-clock parts via tzmath.partsAt (so DST edge cases are
    // always resolved by tzmath, never by ad-hoc arithmetic here). ----

    function currentEpoch() {
      const p = state.parts;
      // Arithmetic-only helper value (not a real UTC instant): lets JS's
      // Date normalize hour/minute overflow into day rollovers for us.
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    }

    function setWallEpoch(epochMs, fireChange) {
      const d = new Date(epochMs);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const h = d.getUTCHours();
      const mi = d.getUTCMinutes();
      const newUtc = tzmath.zonedWallTimeToUtc(state.timezone, y, mo, day, h, mi);
      state.utcInstant = newUtc;
      state.parts = tzmath.partsAt(state.timezone, newUtc);
      render();
      if (fireChange) state.onChange(newUtc);
    }

    function setWallFields(hour, minute, fireChange) {
      const p = state.parts;
      setWallEpoch(Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0), fireChange);
    }

    function increment(field, steps) {
      if (!steps) return;
      const stepMinutes = field === "hour" ? steps * 60 : steps;
      setWallEpoch(currentEpoch() + stepMinutes * 60000, true);
    }

    function toggleAmPm() {
      const p = state.parts;
      setWallFields((p.hour + 12) % 24, p.minute, true);
    }

    // ---- click/tap-to-edit ----

    let editingField = null;

    function segOf(field) {
      return field === "hour" ? hourSeg : minuteSeg;
    }

    function cancelEdit() {
      if (!editingField) return;
      const s = segOf(editingField);
      s.input.hidden = true;
      s.text.hidden = false;
      editingField = null;
    }

    function commitEdit(field, rawValue) {
      const s = segOf(field);
      const n = parseInt(rawValue, 10);
      editingField = null;
      s.input.hidden = true;
      s.text.hidden = false;
      if (Number.isNaN(n)) return; // leave time unchanged on empty/invalid input

      const p = state.parts;
      if (field === "minute") {
        const clamped = Math.min(59, Math.max(0, n));
        setWallFields(p.hour, clamped, true);
      } else if (state.format === "12h") {
        const clamped12 = Math.min(12, Math.max(1, n));
        const isPM = p.hour >= 12;
        let hour24;
        if (clamped12 === 12) hour24 = isPM ? 12 : 0;
        else hour24 = isPM ? clamped12 + 12 : clamped12;
        setWallFields(hour24, p.minute, true);
      } else {
        const clamped24 = Math.min(23, Math.max(0, n));
        setWallFields(clamped24, p.minute, true);
      }
    }

    function beginEdit(field) {
      if (!state.editable) return;
      if (editingField && editingField !== field) cancelEdit();
      editingField = field;
      const s = segOf(field);
      s.input.value = s.text.textContent.trim();
      s.text.hidden = true;
      s.input.hidden = false;
      s.input.focus();
      s.input.select();
    }

    // ---- listeners ----

    const listeners = [];
    function on(el, type, fn, listenerOpts) {
      el.addEventListener(type, fn, listenerOpts);
      listeners.push([el, type, fn, listenerOpts]);
    }

    [hourSeg, minuteSeg].forEach((s) => {
      const field = s.field;

      on(s.seg, "click", () => beginEdit(field));
      on(s.seg, "keydown", (e) => {
        if (!state.editable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          beginEdit(field);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          increment(field, 1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          increment(field, -1);
        }
      });

      on(s.seg, "wheel", (e) => {
        if (!state.editable) return;
        e.preventDefault();
        increment(field, e.deltaY < 0 ? 1 : -1);
      }, { passive: false });

      let touch = null;
      on(s.seg, "touchstart", (e) => {
        if (!state.editable || e.touches.length !== 1) return;
        touch = { startY: e.touches[0].clientY, steps: 0 };
      }, { passive: true });
      on(s.seg, "touchmove", (e) => {
        if (!touch) return;
        const dy = touch.startY - e.touches[0].clientY; // swipe up = increase
        const totalSteps = Math.trunc(dy / 20);
        const stepDelta = totalSteps - touch.steps;
        if (stepDelta !== 0) {
          increment(field, stepDelta);
          touch.steps = totalSteps;
        }
        e.preventDefault();
      }, { passive: false });
      const endTouch = () => { touch = null; };
      on(s.seg, "touchend", endTouch);
      on(s.seg, "touchcancel", endTouch);

      on(s.input, "click", (e) => e.stopPropagation());
      on(s.input, "input", () => {
        s.input.value = s.input.value.replace(/\D/g, "").slice(0, 2);
      });
      on(s.input, "keydown", (e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          commitEdit(field, s.input.value);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          cancelEdit();
        }
      });
      on(s.input, "blur", () => {
        if (editingField === field) commitEdit(field, s.input.value);
      });
    });

    on(ampm, "click", () => { if (state.editable) toggleAmPm(); });
    on(ampm, "keydown", (e) => {
      if (!state.editable) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleAmPm();
      }
    });

    on(fmtBtn, "click", () => {
      state.format = state.format === "24h" ? "12h" : "24h";
      render();
    });

    render();

    // ---- public instance ----

    const instance = {
      setUtcInstant(utcDate) {
        if (!(utcDate instanceof Date)) return;
        cancelEdit();
        state.utcInstant = utcDate;
        state.parts = tzmath.partsAt(state.timezone, utcDate);
        render();
      },
      setFormat(fmt) {
        state.format = fmt === "12h" ? "12h" : "24h";
        render();
      },
      setDayShift(n) {
        state.dayShift = n === 1 || n === -1 ? n : 0;
        render();
      },
      setTimezone(tz) {
        if (!tz) return;
        cancelEdit();
        state.timezone = tz;
        state.parts = tzmath.partsAt(tz, state.utcInstant);
        render();
      },
      destroy() {
        cancelEdit();
        for (const [el, type, fn, listenerOpts] of listeners) {
          el.removeEventListener(type, fn, listenerOpts);
        }
        listeners.length = 0;
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };

    return instance;
  }

  global.WWClock = { create };
})(typeof window !== "undefined" ? window : globalThis);
