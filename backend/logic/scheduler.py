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

    # 1) Build each city's local endpoints on the chosen wall times
    #    We only need the local clock hours/minutes; dates can differ by zone when mapped to UTC
    local_pairs = []
    for c in cities:
        tz = CITY_TZ[resolve_city(c)]
        # reconstruct wall times on the same calendar date as start_dt_local in that city
        s_local = tz.localize(start_dt_local.replace(tzinfo=None))
        e_local = tz.localize(end_dt_local.replace(tzinfo=None))
        local_pairs.append((c, s_local, e_local))

    # 2) Linear scan on UTC to find intersection
    #    Use finest window limits across cities
    utc_min = max(s.astimezone(pytz.UTC) for _, s, _ in local_pairs)
    utc_max = min(e.astimezone(pytz.UTC) for _, _, e in local_pairs)
    # if naive wrap-around was intended (e.g. 17:00->03:00), adjust by day until s<=e for each city already handled above

    step = timedelta(minutes=step_minutes)
    cursor = utc_min
    blocks = []
    in_block = False
    b_start = None

    def all_inside(utc_dt: datetime) -> bool:
        for _, s_loc, e_loc in local_pairs:
            s_utc = s_loc.astimezone(pytz.UTC)
            e_utc = e_loc.astimezone(pytz.UTC)
            if e_utc < s_utc:
                e_utc += timedelta(days=1)
            if not (s_utc <= utc_dt < e_utc):
                return False
        return True

    # Expand search window a bit (use full envelope to be safe)
    envelope_start = min(s.astimezone(pytz.UTC) for _, s, _ in local_pairs)
    envelope_end   = max(e.astimezone(pytz.UTC) for _, _, e in local_pairs)
    cursor = envelope_start

    while cursor < envelope_end:
        ok = all_inside(cursor)
        if ok and not in_block:
            in_block = True
            b_start = cursor
        if (not ok or cursor + step >= envelope_end) and in_block:
            b_end = envelope_end if (cursor + step >= envelope_end and ok) else cursor
            if b_end > b_start:
                blocks.append((b_start, b_end))
            in_block = False
            b_start = None
        cursor += step

    if not blocks:
        return {"type": "N_SAME_LOCAL", "per_city": _per_city_same_local(cities, start_dt_local, end_dt_local), "overlap": None}

    # Map each block back to local per city, for When2Meet-style bar rendering
    rendered = []
    for s_utc, e_utc in blocks:
        segment = {
            "utcStart": s_utc.strftime("%Y-%m-%dT%H:%M"),
            "utcEnd":   e_utc.strftime("%Y-%m-%dT%H:%M"),
            "local": []
        }
        for c in cities:
            tz = CITY_TZ[resolve_city(c)]
            segment["local"].append({
                "city": resolve_city(c),
                "start": s_utc.astimezone(tz).strftime("%Y-%m-%dT%H:%M"),
                "end":   e_utc.astimezone(tz).strftime("%Y-%m-%dT%H:%M")
            })
        rendered.append(segment)

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
