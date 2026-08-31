# backend/logic/scheduler.py
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
import pytz, json, re
from pathlib import Path

# --- Data loading & aliases ---
DB_PATH = Path(__file__).resolve().parents[1] / "city_db.json"
with open(DB_PATH, "r", encoding="utf-8") as f:
    CITY_DB = json.load(f)

# Preload tz objects
CITY_TZ = { row["city"]: pytz.timezone(row["timezone"]) for row in CITY_DB }

# simple alias map (expand as you like)
ALIASES = {
    "la": "Los Angeles", "lax": "Los Angeles",
    "atl": "Atlanta",
    "tpe": "Taipei", "taipei": "Taipei",
    "nyc": "New York", "sf": "San Francisco",
}

def resolve_city(name: str) -> str:
    s = name.strip()
    # alias hit
    key = s.lower()
    if key in ALIASES:
        return ALIASES[key]
    # exact city
    if s in CITY_TZ:
        return s
    # case-insensitive city match
    for city in CITY_TZ:
        if city.lower() == key:
            return city
    raise ValueError(f"Unknown city: {name}")

# --- Helpers ---
def to_equation_label(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M")

def parse_local(origin_city: str, date_str: str, hour: int, minute: int) -> datetime:
    """
    Interpret the chosen date/hour/minute as LOCAL time in origin_city.
    Returns tz-aware datetime in origin tz.
    """
    tz = CITY_TZ[resolve_city(origin_city)]
    naive = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=hour, minute=minute)
    return tz.localize(naive)

def utc_offset_label(dt: datetime) -> str:
    # e.g. UTC-07:00
    off = dt.utcoffset() or timedelta(0)
    total = int(off.total_seconds() // 60)
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    hh, mm = divmod(total, 60)
    return f"UTC{sign}{hh:02d}:{mm:02d}"

def day_shift(from_dt: datetime, to_dt: datetime) -> int:
    """Return -1, 0, +1 if target date is previous/same/next local day relative to origin."""
    a = from_dt.date()
    b = to_dt.date()
    if b > a: return +1
    if b < a: return -1
    return 0

def in_work_hours(local_dt: datetime, start_h=9, start_m=0, end_h=17, end_m=0) -> bool:
    mins = local_dt.hour*60 + local_dt.minute
    s = start_h*60 + start_m
    e = end_h*60 + end_m
    return s <= mins <= e

# --- Core conversions ---
def convert_all(origin_city: str, origin_dt: datetime) -> Dict[str, Any]:
    """One origin city & time -> all cities (equation-style output pieces)."""
    utc_anchor = origin_dt.astimezone(pytz.UTC)
    rows = []
    for city, tz in CITY_TZ.items():
        local = utc_anchor.astimezone(tz)
        rows.append({
            "city": city,
            "time": to_equation_label(local),
            "utcOffset": utc_offset_label(local),
            "dayShift": day_shift(origin_dt, local),      # -1/0/+1
            "isWorkHour": in_work_hours(local, 9, 0, 17, 0)
        })
    # sort by local time (your spec)
    rows.sort(key=lambda r: r["time"])
    return {
        "type": "ALL_AT_POINT",
        "origin": {"city": resolve_city(origin_city), "time": to_equation_label(origin_dt)},
        "results": rows
    }

def convert_one(origin_city: str, target_city: str, origin_dt: datetime) -> Dict[str, Any]:
    tz = CITY_TZ[resolve_city(target_city)]
    utc_anchor = origin_dt.astimezone(pytz.UTC)
    target_dt = utc_anchor.astimezone(tz)
    return {
        "type": "PAIR_AT_POINT",
        "equation": [
            {"city": resolve_city(origin_city), "time": to_equation_label(origin_dt)},
            {"city": resolve_city(target_city), "time": to_equation_label(target_dt),
             "utcOffset": utc_offset_label(target_dt), "dayShift": day_shift(origin_dt, target_dt)}
        ]
    }

def convert_range(origin_city: str, target_city: str, start_dt: datetime, end_dt: datetime) -> Dict[str, Any]:
    """A: [start–end] ⇒ B: [start–end] (equation range)."""
    if end_dt < start_dt:
        end_dt = end_dt + timedelta(days=1)

    utc_s = start_dt.astimezone(pytz.UTC)
    utc_e = end_dt.astimezone(pytz.UTC)

    tz = CITY_TZ[resolve_city(target_city)]
    b_s = utc_s.astimezone(tz)
    b_e = utc_e.astimezone(tz)

    return {
        "type": "PAIR_RANGE",
        "equation": [
            {"city": resolve_city(origin_city),
             "start": to_equation_label(start_dt), "end": to_equation_label(end_dt)},
            {"city": resolve_city(target_city),
             "start": to_equation_label(b_s), "end": to_equation_label(b_e),
             "utcOffsetStart": utc_offset_label(b_s),
             "utcOffsetEnd":   utc_offset_label(b_e),
             "startDayShift":  day_shift(start_dt, b_s),
             "endDayShift":    day_shift(end_dt, b_e)}
        ]
    }

# Same-local-window overlap (e.g., everyone wants 08:00–20:00 local)
def overlap_same_local(cities: List[str], start_dt_local: datetime, end_dt_local: datetime, step_minutes: int = 30) -> Dict[str, Any]:
    if end_dt_local < start_dt_local:
        end_dt_local = end_dt_local + timedelta(days=1)

    def window_utc(tz, day_offset: int):
        s = tz.localize((start_dt_local + timedelta(days=day_offset)).replace(tzinfo=None))
        e = tz.localize((end_dt_local + timedelta(days=day_offset)).replace(tzinfo=None))
        return s.astimezone(pytz.UTC), e.astimezone(pytz.UTC)

    # "Everyone wants the same wall-clock window every day" is a recurring
    # daily pattern, not a one-off date -- so the true overlap can fall on
    # adjacent calendar dates for cities far apart in offset. E.g. Los
    # Angeles and Taipei are 15h apart: LA's "today" 08:00-20:00 lines up
    # with Taipei's "tomorrow" 08:00-20:00, not Taipei's "today" (which ends
    # hours before LA's even starts). Anchor to the first city's window on
    # the literal date given, then for every other city check its window on
    # the day before/of/after that date (in ITS OWN local calendar) and keep
    # whichever instantiation actually overlaps -- +/-1 day comfortably
    # covers the full spread of real-world UTC offsets (about -12 to +14).
    tz0 = CITY_TZ[resolve_city(cities[0])]
    utc_min, utc_max = window_utc(tz0, 0)

    for c in cities[1:]:
        tz = CITY_TZ[resolve_city(c)]
        best = None
        for day_offset in (-1, 0, 1):
            s_utc, e_utc = window_utc(tz, day_offset)
            lo, hi = max(utc_min, s_utc), min(utc_max, e_utc)
            if hi > lo and (best is None or (hi - lo) > (best[1] - best[0])):
                best = (lo, hi)
        if best is None:
            return {"type": "N_SAME_LOCAL", "per_city": _per_city_same_local(cities, start_dt_local, end_dt_local), "overlap": None}
        utc_min, utc_max = best

    if utc_max <= utc_min:
        return {"type": "N_SAME_LOCAL", "per_city": _per_city_same_local(cities, start_dt_local, end_dt_local), "overlap": None}

    # Map the block back to local per city, for When2Meet-style bar rendering
    rendered = [{
        "utcStart": utc_min.strftime("%Y-%m-%dT%H:%M"),
        "utcEnd":   utc_max.strftime("%Y-%m-%dT%H:%M"),
        "local": [
            {
                "city": resolve_city(c),
                "start": utc_min.astimezone(CITY_TZ[resolve_city(c)]).strftime("%Y-%m-%dT%H:%M"),
                "end":   utc_max.astimezone(CITY_TZ[resolve_city(c)]).strftime("%Y-%m-%dT%H:%M"),
            }
            for c in cities
        ]
    }]

    return {
        "type": "N_SAME_LOCAL",
        "per_city": _per_city_same_local(cities, start_dt_local, end_dt_local),
        "overlap": rendered
    }

def _per_city_same_local(cities: List[str], s_local: datetime, e_local: datetime):
    rows = []
    for c in cities:
        tz = CITY_TZ[resolve_city(c)]
        s = tz.localize(s_local.replace(tzinfo=None))
        e = tz.localize(e_local.replace(tzinfo=None))
        rows.append({"city": resolve_city(c),
                     "start": to_equation_label(s),
                     "end":   to_equation_label(e)})
    return rows
