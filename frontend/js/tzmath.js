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

  function shiftDate(date, days) {
    const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  // Exact N-city "same local window" overlap -- the intersection of N intervals
  // is always a single contiguous interval or empty: max(starts), min(ends).
  // cities: [{city, timezone}], anchorDate: {year, month, day} (the calendar date
  // the start wall-time is on), startWall/endWall: {hour, minute}.
  //
  // "Everyone wants the same wall-clock window every day" is a recurring
  // daily pattern, not a one-off date -- so the true overlap can fall on
  // adjacent calendar dates for cities far apart in offset. E.g. Los Angeles
  // and Taipei are ~15h apart: LA's window on the given date lines up with
  // Taipei's window on the NEXT day (in Taipei's own local calendar), not
  // Taipei's window on the same date (which ends hours before LA's even
  // starts). Anchor to the first city's window on the literal date given,
  // then for every other city check its window on the day before/of/after
  // that date and keep whichever instantiation actually overlaps -- +/-1
  // day comfortably covers the full spread of real-world UTC offsets
  // (about -12 to +14). Mirrors overlap_same_local in scheduler.py.
  function overlapSameLocal(cities, anchorDate, startWall, endWall) {
    const startMinutes = startWall.hour * 60 + startWall.minute;
    const endMinutes = endWall.hour * 60 + endWall.minute;
    const overnightWrap = endMinutes < startMinutes ? 1 : 0;

    function windowUtc(timeZone, dayOffset) {
      const s = shiftDate(anchorDate, dayOffset);
      const e = shiftDate(anchorDate, dayOffset + overnightWrap);
      return {
        sUtc: zonedWallTimeToUtc(timeZone, s.year, s.month, s.day, startWall.hour, startWall.minute),
        eUtc: zonedWallTimeToUtc(timeZone, e.year, e.month, e.day, endWall.hour, endWall.minute),
      };
    }

    const localPairs = cities.map((c) => {
      const w = windowUtc(c.timezone, 0);
      return { city: c.city, timezone: c.timezone, sUtc: w.sUtc, eUtc: w.eUtc };
    });

    const perCity = localPairs.map((p) => ({
      city: p.city,
      start: partsAt(p.timezone, p.sUtc),
      end: partsAt(p.timezone, p.eUtc),
    }));

    let utcMin = localPairs[0].sUtc;
    let utcMax = localPairs[0].eUtc;

    for (let i = 1; i < cities.length; i++) {
      const c = cities[i];
      let best = null;
      for (const dayOffset of [-1, 0, 1]) {
        const w = windowUtc(c.timezone, dayOffset);
        const lo = Math.max(utcMin.getTime(), w.sUtc.getTime());
        const hi = Math.min(utcMax.getTime(), w.eUtc.getTime());
        if (hi > lo && (!best || hi - lo > best.hi - best.lo)) {
          best = { lo, hi };
        }
      }
      if (!best) {
        return { overlap: null, perCity };
      }
      utcMin = new Date(best.lo);
      utcMax = new Date(best.hi);
    }

    if (utcMax <= utcMin) {
      return { overlap: null, perCity };
    }

    const local = cities.map((c) => {
      const offStart = offsetMinutesAt(c.timezone, utcMin);
      const offEnd = offsetMinutesAt(c.timezone, utcMax);
      return {
        city: c.city,
        start: partsAt(c.timezone, utcMin),
        end: partsAt(c.timezone, utcMax),
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
  // for the map's live compatibility-preview coloring. Same adjacent-day
  // reasoning as overlapSameLocal above -- checks day -1/0/+1 too, not just
  // the literal anchor date, or a far-offset city would be marked
  // incompatible even when its actual (adjacent-day) window does overlap.
  function stillOverlaps(utcMin, utcMax, timeZone, anchorDate, startWall, endWall) {
    const startMinutes = startWall.hour * 60 + startWall.minute;
    const endMinutes = endWall.hour * 60 + endWall.minute;
    const overnightWrap = endMinutes < startMinutes ? 1 : 0;

    for (const dayOffset of [-1, 0, 1]) {
      const s = shiftDate(anchorDate, dayOffset);
      const e = shiftDate(anchorDate, dayOffset + overnightWrap);
      const sUtc = zonedWallTimeToUtc(timeZone, s.year, s.month, s.day, startWall.hour, startWall.minute);
      const eUtc = zonedWallTimeToUtc(timeZone, e.year, e.month, e.day, endWall.hour, endWall.minute);
      const lo = Math.max(sUtc.getTime(), utcMin.getTime());
      const hi = Math.min(eUtc.getTime(), utcMax.getTime());
      if (hi > lo) return true;
    }
    return false;
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
