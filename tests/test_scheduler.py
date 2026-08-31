import json
from datetime import datetime

import pytest

from backend.logic.scheduler import (
    resolve_city,
    parse_local,
    utc_offset_label,
    day_shift,
    overlap_same_local,
    approximate_timezone,
)
import backend.logic.scheduler as scheduler_module


@pytest.fixture
def isolated_user_cities(tmp_path, monkeypatch):
    """Redirect user-city registration to a scratch file and a fresh copy of
    CITY_TZ, so tests can't pollute the real backend/user_cities.json or the
    real in-memory city registry (monkeypatch restores the originals after)."""
    monkeypatch.setattr(scheduler_module, "USER_DB_PATH", tmp_path / "user_cities.json")
    monkeypatch.setattr(scheduler_module, "USER_CITY_DB", [])
    monkeypatch.setattr(scheduler_module, "CITY_TZ", dict(scheduler_module.CITY_TZ))
    return scheduler_module


def test_resolve_city_aliases():
    assert resolve_city("sf") == "San Francisco"
    assert resolve_city("nyc") == "New York"
    assert resolve_city("lax") == "Los Angeles"


def test_resolve_city_case_insensitive():
    assert resolve_city("taipei") == "Taipei"
    assert resolve_city("TAIPEI") == "Taipei"


def test_resolve_city_unknown_raises():
    with pytest.raises(ValueError):
        resolve_city("Nowhereville")


def test_utc_offset_label_half_hour_zone():
    dt = parse_local("Kathmandu", "2026-08-30", 12, 0)
    assert utc_offset_label(dt) == "UTC+05:45"


def test_day_shift():
    a = parse_local("Taipei", "2026-08-30", 23, 0)
    same = parse_local("Taipei", "2026-08-30", 12, 0)
    next_day = parse_local("Taipei", "2026-08-31", 1, 0)
    prev_day = parse_local("Taipei", "2026-08-29", 1, 0)
    assert day_shift(a, same) == 0
    assert day_shift(a, next_day) == 1
    assert day_shift(a, prev_day) == -1


def test_overlap_same_local_exact_intersection():
    # New York is 3 hours ahead of San Francisco in August (both observe DST).
    # 09:00-18:00 local in both should overlap NY 12:00-18:00 == SF 09:00-15:00.
    r = overlap_same_local(
        ["New York", "San Francisco"],
        datetime(2026, 8, 30, 9, 0),
        datetime(2026, 8, 30, 18, 0),
    )
    assert r["overlap"] is not None
    assert len(r["overlap"]) == 1
    local = {row["city"]: row for row in r["overlap"][0]["local"]}
    assert local["New York"]["start"] == "2026-08-30T12:00"
    assert local["New York"]["end"] == "2026-08-30T18:00"
    assert local["San Francisco"]["start"] == "2026-08-30T09:00"
    assert local["San Francisco"]["end"] == "2026-08-30T15:00"


def test_overlap_same_local_no_overlap():
    # Taipei and Los Angeles are ~15 hours apart, so a 9-hour 09:00-18:00
    # local window for both never coincides on any day pairing.
    r = overlap_same_local(
        ["Taipei", "Los Angeles"],
        datetime(2026, 8, 30, 9, 0),
        datetime(2026, 8, 30, 18, 0),
    )
    assert r["overlap"] is None


def test_overlap_same_local_finds_adjacent_day_match():
    # Los Angeles and Taipei are ~15 hours apart, wider than a same-date
    # 08:00-20:00 (12h) window can bridge -- but the "same local window" is
    # a RECURRING daily pattern, not a one-off date, so LA's window on the
    # given date actually lines up with Taipei's window on the NEXT day
    # (in Taipei's own local calendar), not the same date. The overlap must
    # be found there, not missed just because it's not on the literal date.
    r = overlap_same_local(
        ["Los Angeles", "Taipei"],
        datetime(2026, 8, 30, 8, 0),
        datetime(2026, 8, 30, 20, 0),
    )
    assert r["overlap"] is not None
    local = {row["city"]: row for row in r["overlap"][0]["local"]}
    assert local["Los Angeles"]["start"] == "2026-08-30T17:00"
    assert local["Los Angeles"]["end"] == "2026-08-30T20:00"
    assert local["Taipei"]["start"] == "2026-08-31T08:00"
    assert local["Taipei"]["end"] == "2026-08-31T11:00"


def test_overlap_same_local_preserves_minute_precision():
    # Kathmandu sits at UTC+5:45, so an exact intersection should land on
    # quarter-hour boundaries rather than snapping to a 30-minute grid.
    r = overlap_same_local(
        ["New York", "San Francisco", "Kathmandu"],
        datetime(2026, 8, 30, 6, 0),
        datetime(2026, 8, 30, 23, 0),
    )
    local = {row["city"]: row for row in r["overlap"][0]["local"]}
    assert local["Kathmandu"]["start"] == "2026-08-30T18:45"
    assert local["New York"]["end"] == "2026-08-30T13:15"


def test_overlap_same_local_is_single_contiguous_block():
    # The intersection of N intervals can never be more than one block.
    r = overlap_same_local(
        ["Taipei", "New York", "San Francisco", "Kathmandu"],
        datetime(2026, 8, 30, 0, 0),
        datetime(2026, 8, 31, 0, 0),
    )
    if r["overlap"] is not None:
        assert len(r["overlap"]) == 1


def test_approximate_timezone_matches_a_nearby_official_city():
    # Reykjavik itself should win as its own nearest neighbor, ~0km away.
    tz, nearest, dist = approximate_timezone(64.1466, -21.9426)
    assert tz == "Atlantic/Reykjavik"
    assert nearest == "Reykjavik"
    assert dist < 10


def test_approximate_timezone_prefers_longitude_band_over_raw_distance():
    # Near Alice Springs, Australia -- the nearest official city by raw
    # straight-line distance could easily be an equatorial Pacific island
    # whose longitude happens to line up closely (a real failure mode this
    # regression-tests for), rather than a farther-but-same-region match.
    # Whatever city it picks as "nearest" must be in the right hemisphere/
    # region (Australia), not on the other side of the globe.
    tz, nearest, dist = approximate_timezone(-23.7, 133.9)
    assert nearest in ("Eucla", "Adelaide", "Darwin", "Perth", "Alice Springs")


def test_approximate_timezone_falls_back_to_formula_when_nearest_city_is_far():
    # Alice Springs' nearest official city (Eucla) is ~1000km away and has an
    # unusual, very LOCAL UTC+8:45 offset (not a clean multiple of 15deg
    # longitude). That's too far to trust as a regional stand-in -- importing
    # it would be worse than the plain longitude-based formula.
    tz, nearest, dist = approximate_timezone(-23.7, 133.9)
    assert nearest == "Eucla"
    assert dist > scheduler_module.SAME_REGION_KM
    assert tz == "Etc/GMT-9"  # round(133.9 / 15) = 9, Etc/GMT sign is inverted


def test_approximate_timezone_inherits_nearby_regional_quirk():
    # A point genuinely close to Adelaide should inherit its real
    # UTC+9:30 offset (a political quirk no formula would predict), not a
    # "clean" formula-only estimate.
    tz, nearest, dist = approximate_timezone(-34.5, 139.0)
    assert nearest == "Adelaide"
    assert dist <= scheduler_module.SAME_REGION_KM
    assert tz == "Australia/Adelaide"


def test_register_user_city_persists_and_resolves(isolated_user_cities):
    record = isolated_user_cities.register_user_city("Test Adelaide Suburb", -34.5, 139.0)
    assert record["city"] == "Test Adelaide Suburb"
    assert record["timezone"] == "Australia/Adelaide"
    assert record["nearestOfficialCity"] == "Adelaide"
    assert "distanceKm" in record

    assert "Test Adelaide Suburb" in isolated_user_cities.CITY_TZ
    saved = json.loads(isolated_user_cities.USER_DB_PATH.read_text())
    assert saved == [{
        "city": "Test Adelaide Suburb",
        "timezone": "Australia/Adelaide",
        "lat": -34.5,
        "lon": 139.0,
    }]


def test_register_user_city_rejects_duplicates(isolated_user_cities):
    isolated_user_cities.register_user_city("Duplicate City", 0, 0)
    with pytest.raises(ValueError):
        isolated_user_cities.register_user_city("Duplicate City", 1, 1)
    # Case-insensitive collision with an OFFICIAL city should also be rejected.
    with pytest.raises(ValueError):
        isolated_user_cities.register_user_city("tokyo", 1, 1)


def test_registered_user_city_is_usable_in_overlap_same_local(isolated_user_cities):
    isolated_user_cities.register_user_city("Test Outback Town", -23.7, 133.9)
    r = overlap_same_local(
        ["Taipei", "Test Outback Town"],
        datetime(2026, 8, 30, 9, 0),
        datetime(2026, 8, 30, 18, 0),
    )
    assert r["per_city"][1]["city"] == "Test Outback Town"
