# backend/app.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from backend.logic.scheduler import (
    resolve_city, CITY_TZ, parse_local,
    convert_all, convert_one, convert_range, overlap_same_local
)

app = FastAPI(title="WhenWhere API")

@app.get("/cities")
def cities_list():
    return {"cities":sorted(CITY_TZ.keys())}

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

@app.get("/")
def root():
    return {"message": "WhenWhere backend running"}

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

    if len(cities) == 2 and has_end:
        end_date_str = req.end_date or req.date          # <-- respect end_date if set
        end_dt = parse_local(cities[0], end_date_str, req.end_hour, req.end_minute)
        return convert_range(cities[0], cities[1], start_dt, end_dt)

    if len(cities) >= 2 and not has_end:
        data = convert_all(cities[0], start_dt)
        # ...existing N_AT_POINT code...
        # (unchanged)

    if len(cities) >= 2 and has_end:
        end_date_str = req.end_date or req.date          # <-- NEW
        end_dt = parse_local(cities[0], end_date_str, req.end_hour, req.end_minute)
        return overlap_same_local(cities, start_dt, end_dt, step_minutes=req.step_minutes)

    return {"error": "Unhandled combination"}

