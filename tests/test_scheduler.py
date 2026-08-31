from datetime import datetime

import pytest

from backend.logic.scheduler import (
    resolve_city,
    parse_local,
    utc_offset_label,
    day_shift,
    overlap_same_local,
)


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
