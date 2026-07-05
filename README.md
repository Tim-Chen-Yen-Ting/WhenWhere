# WhenWhere

DST‑safe, timezone‑aware meeting planner for cross‑continent coordination.

## Features
- One‑to‑many time conversion across all supported cities
- Point or range conversion between two cities
- Multi‑city overlapping “same local window” computation, with a When2Meet‑style
  color‑coded grid (partial vs. full overlap) in the frontend
- Full DST correctness via IANA timezones (`pytz`)
- City alias resolution (e.g. `nyc` → New York, `la`/`lax` → Los Angeles, `sf` → San Francisco,
  `atl` → Atlanta, `tpe` → Taipei) and case‑insensitive city matching
- Per‑city work‑hour flag (9am–5pm local) included in results
- Large built‑in city database (`backend/city_db.json`) with country and lat/lon metadata

## Run Locally

### Backend (FastAPI)
```bash
python -m venv venv
source venv/bin/activate  # windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.app:app --reload
```

### Frontend
Serve the `frontend` directory over HTTP (opening `frontend/index.html` directly as a
`file://` URL can break the API calls):
```bash
cd frontend
python -m http.server 3000
```
Then open `http://127.0.0.1:3000`. Frontend expects the API at `http://127.0.0.1:8000`.

---

## API

### GET /
Health check. Returns `{"message": "WhenWhere backend running"}`.

### GET /cities
Returns a list of supported city names.

### POST /compute
Body fields: `cities`, `date`, `hour`, `minute`, and optionally `end_date`, `end_hour`,
`end_minute`, `step_minutes` (default 30). City names may be aliases (see Features).
The combination of fields determines which computation mode is used:
- 1 city, no end → `ALL_AT_POINT`
- 2 cities, no end → `PAIR_AT_POINT`
- 2 cities + end → `PAIR_RANGE`
- ≥2 cities, no end → `ALL_AT_POINT` (for the first city)
- ≥2 cities + end → `N_SAME_LOCAL`

---

## Roadmap
- City fuzzy search (beyond the current fixed alias list)
- Shareable URL presets
- Docker support

## License
MIT — see [LICENSE](LICENSE).
