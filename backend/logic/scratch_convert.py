# backend/logic/convert.py
from datetime import datetime, timedelta
import pytz, json
from pathlib import Path

# Load city DB using relative path from backend folder
DB_PATH = Path(__file__).resolve().parents[1] / "city_db.json"
with open(DB_PATH, "r", encoding="utf-8") as f:
    cities = json.load(f)
CITY_TZ = {c["city"]: pytz.timezone(c["timezone"]) for c in cities}

# Helper to find timezone from city name
def get_timezone(city_name):
    try:
        return CITY_TZ[city_name]
    except Exception as e:
        raise ValueError(f"City '{city_name}' not found in database.")

def to_utc_minutes(city, local_time_str):
    tz = get_timezone(city)
    naive = datetime.strptime(local_time_str, "%Y-%m-%d %H:%M")
    local_dt = tz.localize(naive)
    utc_dt = local_dt.astimezone(pytz.UTC)
    return utc_dt.hour * 60 + utc_dt.minute

def from_utc_minutes(city, minutes, ref_date):
    tz = get_timezone(city)
    utc_dt = datetime(ref_date.year, ref_date.month, ref_date.day, tzinfo=pytz.UTC) + timedelta(minutes=minutes)
    local_dt = utc_dt.astimezone(tz)
    return local_dt.strftime("%Y-%m-%d %H:%M")

def find_overlap(cities, start_str, end_str):
    # Pick reference date from first start_str
    ref_date = datetime.strptime(start_str, "%Y-%m-%d %H:%M")

    # Convert each range to UTC minutes
    ranges = []
    for city in cities:
        start_m = to_utc_minutes(city, start_str)
        end_m = to_utc_minutes(city, end_str)
        ranges.append((start_m, end_m))

    # Handle wrap-around (e.g., 17:00-03:00)
    expanded = []
    for start, end in ranges:
        if end < start:
            expanded.append(list(range(start, 1440)) + list(range(0, end)))
        else:
            expanded.append(list(range(start, end)))

    # Intersect all ranges
    overlap = set(expanded[0])
    for r in expanded[1:]:
        overlap &= set(r)

    if not overlap:
        return None

    min_m, max_m = min(overlap), max(overlap)

    # Convert back to each city’s local time
    results = {}
    for city in cities:
        results[city] = {
            "start": from_utc_minutes(city, min_m, ref_date),
            "end": from_utc_minutes(city, max_m, ref_date)
        }
    return results

# Forward time conversion
def convert_all(origin_city, origin_time_str):
    origin_tz = CITY_TZ[origin_city]
    naive_dt = datetime.strptime(origin_time_str, "%Y-%m-%d %H:%M")
    origin_dt = origin_tz.localize(naive_dt)
    utc_dt = origin_dt.astimezone(pytz.UTC)  # one UTC anchor
    
    results = {
        city: utc_dt.astimezone(tz).strftime("%Y-%m-%d %H:%M")
        for city, tz in CITY_TZ.items()
    }
    return results

def convert_time(origin_city, target_city, origin_time_str):
    origin_tz = CITY_TZ[origin_city]
    target_tz = CITY_TZ[target_city]
    naive_dt = datetime.strptime(origin_time_str, "%Y-%m-%d %H:%M")
    origin_dt = origin_tz.localize(naive_dt)
    return origin_dt.astimezone(target_tz)  # <-- return datetime, not string

def convert_range(origin_city, target_city, start_time_str, end_time_str):
    start_time = convert_time(origin_city, target_city, start_time_str)
    end_time = convert_time(origin_city, target_city, end_time_str)
    return start_time, end_time

def convert_range_multiple(origin_city, target_cities, start_time_str, end_time_str):
    results = []
    total_cities = [origin_city] + [c for c in target_cities if c != origin_city]

    # Per‑city converted window relative to ORIGIN range (nice for the first table)
    for city in target_cities:
        start_local = convert_time(origin_city, city, start_time_str)
        end_local   = convert_time(origin_city, city, end_time_str)
        results.append({
            "city": city,
            "start": start_local.strftime("%Y-%m-%d %H:%M"),
            "end":   end_local.strftime("%Y-%m-%d %H:%M")
        })

    # Overlap of the SAME local window in each city (your “8:00–20:00 local everywhere” case)
    overlap_dict = find_overlap(total_cities, start_time_str, end_time_str)
    if overlap_dict is None:
        overlap_list = None
    else:
        # turn dict -> list for easier printing/JSON
        overlap_list = [{"city": k, "start": v["start"], "end": v["end"]} for k, v in overlap_dict.items()]

    return {
        "ranges": results,
        "overlap": overlap_list
    }

def print_date(date):
    if isinstance(date, datetime):
        print(date.strftime("%Y-%m-%d %H:%M"))
    elif isinstance(date,dict):
        for section in date:
            print(f"{section}:")
            if date[section] is not None:
                for row in date[section]:
                    print(row)
            else:
                print("None")
    elif isinstance(date,tuple):
        for d in date:
            print(d.strftime("%Y-%m-%d %H:%M"))

# Example usage:
target_cities = ["Taipei", "Los Angeles", "Atlanta"]
output = convert_range_multiple("Taipei", target_cities, "2025-08-15 08:00", "2025-08-15 20:00")
res = convert_range("Taipei", "Los Angeles", "2025-08-15 08:00", "2025-08-15 20:00")
print_date(output)
print_date(res)
#print(len(convert_all("Taipei","2025-08-15 08:00")))

# Example usage
#if __name__ == "__main__":
#    print(convert_range("Taipei", "Los Angeles", "2025-08-15 08:00", "2025-08-15 20:00"))