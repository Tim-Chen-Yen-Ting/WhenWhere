# backend/logic/scheduler.py
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
import pytz, json, re, math
from pathlib import Path

# --- Data loading & aliases ---
DB_PATH = Path(__file__).resolve().parents[1] / "city_db.json"
with open(DB_PATH, "r", encoding="utf-8") as f:
    CITY_DB = json.load(f)

# Preload tz objects
CITY_TZ = { row["city"]: pytz.timezone(row["timezone"]) for row in CITY_DB }

# --- User-appended cities (separate file from the official city_db.json) ---
USER_DB_PATH = Path(__file__).resolve().parents[1] / "user_cities.json"

def _load_user_cities() -> List[Dict[str, Any]]:
    if USER_DB_PATH.exists():
        with open(USER_DB_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

USER_CITY_DB = _load_user_cities()
for row in USER_CITY_DB:
    CITY_TZ[row["city"]] = pytz.timezone(row["timezone"])

def _save_user_cities() -> None:
    with open(USER_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(USER_CITY_DB, f, indent=2, ensure_ascii=False)

def all_city_records() -> List[Dict[str, Any]]:
    """Official + user-appended cities, for endpoints that list the full set."""
    return CITY_DB + USER_CITY_DB

def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def _lon_gap(a: float, b: float) -> float:
    d = abs(a - b)
    return min(d, 360 - d)  # shortest way around, across the antimeridian

# Timezones are roughly 15deg-wide longitude bands, so cities within this
# band of the target's longitude are strongly preferred as neighbors --
# they're overwhelmingly likely to share (or be adjacent to) the actual
# timezone, regardless of how far away they are in latitude.
VERTICAL_BAND_DEG = 10.0

# Beyond this distance, a "nearest" city is no longer a trustworthy stand-in
# for the target's actual timezone -- political timezone quirks (Adelaide's
# UTC+9:30, Eucla's UTC+8:45 -- offsets that don't fit a clean multiple of
# 15deg longitude) are real but LOCAL, and importing one wholesale into a
# location hundreds of km away that likely doesn't share that quirk is worse
# than just using the standard longitude-based formula.
SAME_REGION_KM = 500.0

def _formula_timezone(lon: float) -> str:
    """Standard whole-hour UTC-offset-from-longitude estimate (offset =
    round(lon / 15)), as a fixed-offset Etc/GMT zone. Note IANA's Etc/GMT
    zones use an INVERTED sign vs. common convention (Etc/GMT-9 = UTC+9)."""
    offset_hours = max(-12, min(14, round(lon / 15)))
    if offset_hours == 0:
        return "Etc/GMT"
    sign = "-" if offset_hours > 0 else "+"
    return f"Etc/GMT{sign}{abs(offset_hours)}"

def approximate_timezone(lat: float, lon: float):
    """Timezone approximation for a city not in the official database.

    Base case: the standard longitude/15 formula. But that formula alone
    misses real political quirks -- entire regions can sit at a non-clean
    offset (Adelaide/Eucla's half- and quarter-hour zones, for instance) that
    no formula would predict. So: find the nearest official city, prioritizing
    matching by LONGITUDE (a "vertical" search, scanning latitude at a similar
    longitude) over latitude, since timezones are fundamentally
    longitude-determined bands. If that nearest city is close enough to
    plausibly be in the SAME REGION (within SAME_REGION_KM), trust its real,
    already-correct timezone instead of the formula. If the nearest official
    city is too far away to be a reliable regional reference (e.g. a remote
    area with no nearby city in a 338-city database), fall back to the clean
    formula rather than importing a distant city's specific, likely
    unrepresentative quirk.

    Only searches the OFFICIAL city_db.json (never previously-approximated
    user cities), so approximation error can't compound across additions.
    Returns (timezone_str, nearest_city_name, distance_km).
    """
    candidates = [row for row in CITY_DB if _lon_gap(row["lon"], lon) <= VERTICAL_BAND_DEG]
    if not candidates:
        candidates = CITY_DB

    nearest = min(candidates, key=lambda row: _haversine_km(lat, lon, row["lat"], row["lon"]))
    distance_km = round(_haversine_km(lat, lon, nearest["lat"], nearest["lon"]))

    if distance_km <= SAME_REGION_KM:
        return nearest["timezone"], nearest["city"], distance_km
    return _formula_timezone(lon), nearest["city"], distance_km

def register_user_city(name: str, lat: float, lon: float) -> Dict[str, Any]:
    """Approximate a new city's timezone, persist it to user_cities.json, and
    make it immediately resolvable (CITY_TZ) without a server restart."""
    try:
        resolve_city(name)
        exists = True
    except ValueError:
        exists = False
    if exists:
        raise ValueError(f"'{name}' already exists")

    timezone, nearest_city, distance_km = approximate_timezone(lat, lon)
    record = {"city": name, "timezone": timezone, "lat": lat, "lon": lon}

    USER_CITY_DB.append(record)
    CITY_TZ[name] = pytz.timezone(timezone)
    _save_user_cities()

    return {**record, "nearestOfficialCity": nearest_city, "distanceKm": distance_km}

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
