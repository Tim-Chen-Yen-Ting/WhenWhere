# WhenWhere

DST‑safe, timezone‑aware meeting planner for cross‑continent coordination.

**Live demo:** https://whenwhere-65it.onrender.com/ (free tier — first load after
idle can take 30–50s to spin up)

## Features

- **Interactive world map** (Leaflet, no tile server/API key — country outlines are a
  static CDN-hosted TopoJSON rendered as a vector layer) with a live day/night terminator,
  click-to-add cities, and a search bar with alias- and multi-word-aware autocomplete
- **Point mode** — every selected city's clock updates live off a shared anchor instant;
  editing any one city's clock re-anchors the rest (reverse query)
- **Range mode** — exact, minute-precision N-city "same local window" overlap (e.g.
  "everyone's free 9–5 their own time, when does that actually line up") rendered as a
  When2Meet-style grid with time-aligned columns, plus a map preview that colors every
  other city by whether adding it would still leave a non-empty overlap. Correctly treats
  "same local window" as a *recurring daily pattern* — for cities far enough apart (e.g.
  Los Angeles/Taipei, ~15h), the real overlap can fall on adjacent calendar dates, not just
  the literal date typed in
- **Add a custom city** not in the official database — give it a name and coordinates and
  its timezone is approximated from the nearest known city (prioritizing longitude match,
  since timezones are fundamentally longitude-determined bands, with a distance cutoff so a
  city hundreds of km away doesn't get credited with a neighbor's local political quirks
  like Adelaide's UTC+9:30). Stored server-side in a separate `backend/user_cities.json`,
  independent of the official `city_db.json` (note: on the free-tier live demo, Render's
  filesystem is ephemeral, so cities added there won't survive a redeploy or a long idle
  spin-down — added cities persist reliably when self-hosted or run locally)
- Full DST correctness via IANA timezones — computed client-side (`frontend/js/tzmath.js`,
  using the native `Intl` API) as a tested mirror of the Python backend logic
  (`backend/logic/scheduler.py`), so most interactions need no round trip to the API at all
- City alias resolution (e.g. `nyc` → New York, `la`/`lax` → Los Angeles, `sf` → San
  Francisco, `atl` → Atlanta, `tpe` → Taipei) and case-insensitive matching
- 338-city built-in database (`backend/city_db.json`) with country and lat/lon metadata

## Run Locally

```bash
python -m venv .venv
source .venv/bin/activate  # windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.app:app --reload
```
Then open `http://127.0.0.1:8000/` — the FastAPI app serves the frontend directly, so no
separate static file server is needed.

Run the backend test suite with `pytest` (from the repo root, with the venv active).

---

## API

The frontend does almost all of its own timezone math client-side and only needs the
endpoints below. A legacy `POST /compute` endpoint (single/pair/range conversion via a
JSON body) still exists for compatibility but isn't used by the current UI.

### GET /city_data
Full per-city records (`city`, `timezone`, `lat`, `lon`) for every official and
user-appended city — fetched once by the frontend for map placement and local computation.

### GET /cities
Returns just the list of supported city names (official + user-appended).

### POST /user_cities
Body: `{"city": str, "lat": float, "lon": float}`. Approximates the city's timezone from
the nearest official city (see Features), persists it, and returns the new record. Returns
`{"error": "..."}` (not an HTTP error) if the name already exists or is empty.

---

## Roadmap
- Shareable URL presets for a computed overlap
- Docker support
- An accessible/text-mode view for low-bandwidth use

## License
MIT — see [LICENSE](LICENSE).
