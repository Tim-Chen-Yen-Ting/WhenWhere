// frontend/js/tzmath.js
// Client-side timezone math, mirroring backend/logic/scheduler.py exactly
// (same "max starts / min ends" exact interval intersection, no scanning).
// Pure functions, no dependencies -- uses the browser's native Intl API,
// which resolves arbitrary IANA zones (with DST) with no external data file.

(function (global) {
  "use strict";

  function partsAt(timeZone, utcDate) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
    const parts = {};
    for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
    return {
      year: +parts.year, month: +parts.month, day: +parts.day,
      hour: +parts.hour === 24 ? 0 : +parts.hour, minute: +parts.minute, second: +parts.second,
      weekday: parts.weekday,
    };
  }

  // Offset (minutes, positive = ahead of UTC) of `timeZone` at the instant `utcDate`.
  function offsetMinutesAt(timeZone, utcDate) {
    const p = partsAt(timeZone, utcDate);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - utcDate.getTime()) / 60000);
  }

  // Interpret (year, month, day, hour, minute) as a WALL-CLOCK time in `timeZone`
  // and return the corresponding UTC Date. Equivalent to pytz's tz.localize().
  function zonedWallTimeToUtc(timeZone, year, month, day, hour, minute) {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let instant = wallAsUtc;
    for (let i = 0; i < 3; i++) {
      const offset = offsetMinutesAt(timeZone, new Date(instant));
      const candidate = wallAsUtc - offset * 60000;
      if (candidate === instant) break;
      instant = candidate;
    }
    return new Date(instant);
  }

  function utcOffsetLabel(offsetMinutes) {
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `UTC${sign}${hh}:${mm}`;
  }

  // -1 / 0 / +1 if targetParts' calendar date is previous/same/next vs originParts'.
  function dayShift(originParts, targetParts) {
    const a = Date.UTC(originParts.year, originParts.month - 1, originParts.day);
    const b = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
    if (b > a) return 1;
    if (b < a) return -1;
    return 0;
  }

  function isWorkHour(parts, startH = 9, startM = 0, endH = 17, endM = 0) {
    const mins = parts.hour * 60 + parts.minute;
    return mins >= startH * 60 + startM && mins <= endH * 60 + endM;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function labelParts(p) { return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`; }

  // Exact N-city "same local window" overlap -- the intersection of N intervals
  // is always a single contiguous interval or empty: max(starts), min(ends).
  // cities: [{city, timezone}], anchorDate: {year, month, day} (the calendar date
  // the start wall-time is on), startWall/endWall: {hour, minute}.
  function overlapSameLocal(cities, anchorDate, startWall, endWall) {
    const startMinutes = startWall.hour * 60 + startWall.minute;
    const endMinutes = endWall.hour * 60 + endWall.minute;

    let endDate = anchorDate;
    if (endMinutes < startMinutes) {
      const next = new Date(Date.UTC(anchorDate.year, anchorDate.month - 1, anchorDate.day + 1));
      endDate = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    }

    const localPairs = cities.map((c) => ({
      city: c.city,
      timezone: c.timezone,
      sUtc: zonedWallTimeToUtc(c.timezone, anchorDate.year, anchorDate.month, anchorDate.day, startWall.hour, startWall.minute),
      eUtc: zonedWallTimeToUtc(c.timezone, endDate.year, endDate.month, endDate.day, endWall.hour, endWall.minute),
    }));

    const perCity = localPairs.map((p) => ({
      city: p.city,
      start: partsAt(p.timezone, p.sUtc),
      end: partsAt(p.timezone, p.eUtc),
    }));

    const utcMin = new Date(Math.max(...localPairs.map((p) => p.sUtc.getTime())));
    const utcMax = new Date(Math.min(...localPairs.map((p) => p.eUtc.getTime())));

    if (utcMax <= utcMin) {
      return { overlap: null, perCity };
    }

    const local = localPairs.map((p) => {
      const offStart = offsetMinutesAt(p.timezone, utcMin);
      const offEnd = offsetMinutesAt(p.timezone, utcMax);
      return {
        city: p.city,
        start: partsAt(p.timezone, utcMin),
        end: partsAt(p.timezone, utcMax),
        utcOffsetStart: utcOffsetLabel(offStart),
        utcOffsetEnd: utcOffsetLabel(offEnd),
      };
    });

    return {
      overlap: { utcStart: utcMin, utcEnd: utcMax, local },
      perCity,
    };
  }

  // Quick "would adding this city still leave a non-empty overlap" check,
  // for the map's live compatibility-preview coloring. Cheap: 1 extra
  // interval intersected against the already-computed [utcMin, utcMax].
  function stillOverlaps(utcMin, utcMax, timeZone, anchorDate, startWall, endWall) {
    const endMinutes = endWall.hour * 60 + endWall.minute;
    const startMinutes = startWall.hour * 60 + startWall.minute;
    let endDate = anchorDate;
    if (endMinutes < startMinutes) {
      const next = new Date(Date.UTC(anchorDate.year, anchorDate.month - 1, anchorDate.day + 1));
      endDate = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    }
    const sUtc = zonedWallTimeToUtc(timeZone, anchorDate.year, anchorDate.month, anchorDate.day, startWall.hour, startWall.minute);
    const eUtc = zonedWallTimeToUtc(timeZone, endDate.year, endDate.month, endDate.day, endWall.hour, endWall.minute);
    const lo = Math.max(sUtc.getTime(), utcMin.getTime());
    const hi = Math.min(eUtc.getTime(), utcMax.getTime());
    return hi > lo;
  }

  const tzmath = {
    partsAt,
    offsetMinutesAt,
    zonedWallTimeToUtc,
    utcOffsetLabel,
    dayShift,
    isWorkHour,
    labelParts,
    overlapSameLocal,
    stillOverlaps,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = tzmath;
  } else {
    global.tzmath = tzmath;
  }
})(typeof window !== "undefined" ? window : globalThis);
