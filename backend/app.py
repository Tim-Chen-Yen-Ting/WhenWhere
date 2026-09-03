# backend/app.py
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import List, Optional
from backend.logic.scheduler import (
    resolve_city, CITY_TZ, all_city_records, register_user_city, parse_local,
    convert_all, convert_one, overlap_same_local
)

app = FastAPI(title="WhenWhere API")

@app.get("/cities")
def cities_list():
    return {"cities":sorted(CITY_TZ.keys())}

@app.get("/city_data")
def city_data():
    """Full per-city records (name, timezone, lat/lon) for client-side map
    placement and client-side timezone math -- avoids a round trip per interaction.
    Includes both the official database and any user-appended cities."""
    return {"cities": [
        {"city": row["city"], "timezone": row["timezone"], "lat": row["lat"], "lon": row["lon"]}
        for row in all_city_records()
    ]}

class UserCityRequest(BaseModel):
    city: str
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)

@app.post("/user_cities")
def add_user_city(req: UserCityRequest):
    name = req.city.strip()
    if not name:
        return {"error": "City name is required"}
    try:
        record = register_user_city(name, req.lat, req.lon)
    except ValueError as e:
        return {"error": str(e)}
    return record

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

class ComputeRequest(BaseModel):
    cities: List[str]
    date: str
    hour: int
    minute: int
    end_date: Optional[str] = None          # <-- NEW
    end_hour: Optional[int] = Field(None, ge=0, le=23)
    end_minute: Optional[int] = Field(None, ge=0, le=59)
    step_minutes: int = 30

@app.post("/compute")
def compute(req: ComputeRequest):
    cities = [resolve_city(c) for c in req.cities]
    if len(cities) == 0:
        return {"error": "No cities provided"}

    start_dt = parse_local(cities[0], req.date, req.hour, req.minute)
    has_end = req.end_hour is not None and req.end_minute is not None

    if len(cities) == 1 and not has_end:
        return convert_all(cities[0], start_dt)

    if len(cities) == 2 and not has_end:
        return convert_one(cities[0], cities[1], start_dt)

    if len(cities) >= 2 and not has_end:
        return convert_all(cities[0], start_dt)

    if len(cities) >= 2 and has_end:
        # A same-local-window "range" request always means N-city overlap now
        # (see convert_range's removal) -- overlap_same_local already
        # generalizes correctly to N=2, so a 2-city range is just this with
        # cities of length 2, not a special case.
        end_date_str = req.end_date or req.date
        end_dt = parse_local(cities[0], end_date_str, req.end_hour, req.end_minute)
        return overlap_same_local(cities, start_dt, end_dt, step_minutes=req.step_minutes)

    return {"error": "Unhandled combination"}

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
