"""
test_upcitemdb_api_harvest.py — Offline tests for upcitemdb_api_harvest.

ALL OFFLINE — no network calls. _search_page() is monkeypatched throughout.

Tests:
  1. Tire items get written with evidence_level="verified_db" and correct barcode.
  2. Non-tire item (parse_name returns {}) is skipped.
  3. Item with missing barcode is skipped.
  4. Offset paging advances across multiple pages and stops at total.
  5. daily_request_cap is respected (cap=2 stops after 2 calls).
  6. api_progress.json is written and the offset is advanced correctly.
  7. Resume: a second harvest() call picks up from the saved offset.
  8. EAN->UPC barcode derivation (strip leading zero from 13-digit EAN).
  9. harvest() returns audit_ok=True with a clean temp corpus.
  10. PRIORITY_BRANDS starts with niche-first brands in the correct order.
"""

import csv
import json
import os
import sys
import tempfile

import pytest

# Make scripts/ importable
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import upcitemdb_api_harvest as AH

# ---------------------------------------------------------------------------
# Fake API data
# ---------------------------------------------------------------------------

# A valid UPC-12 with correct GTIN check digit.
# Fortune Tormenta A/T FSR308 245/70R17 110T — real barcode from spec example.
_FORTUNE_UPC = "840139631771"

# A second valid Fortune tire barcode for pagination tests.
# We derive a valid GTIN by using a known good value.
_FORTUNE_UPC_2 = "840139631788"

# 13-digit EAN (leading zero + 12-digit UPC) for EAN-strip test.
# Leading-zero EAN of _FORTUNE_UPC
_FORTUNE_EAN_13 = "0" + _FORTUNE_UPC  # -> "0840139631771"

# Non-tire item — generic product with no tire size in title.
_NON_TIRE_ITEM = {
    "upc": "012345678905",
    "ean": "0012345678905",
    "brand": "Acme",
    "title": "Acme Widget Super Deluxe 500 Pack",
}

# Fortune tire item (page 1)
_FORTUNE_ITEM_1 = {
    "upc": _FORTUNE_UPC,
    "ean": _FORTUNE_EAN_13,
    "brand": "Fortune",
    "title": "Fortune Tormenta A/T FSR308 All Terrain 245/70R17 110T Light Truck Tire",
}

# Fortune tire item (page 2) — different barcode
_FORTUNE_ITEM_2 = {
    "upc": _FORTUNE_UPC_2,
    "ean": "0" + _FORTUNE_UPC_2,
    "brand": "Fortune",
    "title": "Fortune Tormenta H/T FSR702 Highway 265/70R17 115T Light Truck Tire",
}

# Item with no UPC or EAN — should be skipped
_NO_BARCODE_ITEM = {
    "upc": "",
    "ean": "",
    "brand": "Fortune",
    "title": "Fortune Tormenta M/T FSR310 Mud Terrain 285/75R16 126Q Light Truck Tire",
}


def _make_page(items: list, total: int, offset: int) -> dict:
    """Build a fake API response dict."""
    return {
        "code": "OK",
        "total": total,
        "offset": offset,
        "items": items,
    }


# ---------------------------------------------------------------------------
# Temp corpus setup
# ---------------------------------------------------------------------------

def _make_temp_root(tmp_dir: str) -> str:
    """Create the minimum files harvest() needs in tmp_dir."""
    flat_path = os.path.join(tmp_dir, "tire_corpus_flat.csv")
    with open(flat_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    ids_path = os.path.join(tmp_dir, "tire_identifiers.csv")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")

    sz_path = os.path.join(tmp_dir, "tire_size_aliases.csv")
    with open(sz_path, "w", encoding="utf-8") as f:
        pass

    return tmp_dir


# ---------------------------------------------------------------------------
# 1. Tire items get written with evidence_level="verified_db" and correct barcode
# ---------------------------------------------------------------------------

def test_tire_written_with_verified_db_and_correct_barcode(monkeypatch, tmp_path):
    """
    A valid tire item from the API must be written to flat CSV with
    evidence_level="verified_db" and the exact UPC barcode.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        if call_count[0] == 1:
            return _make_page([_FORTUNE_ITEM_1], total=1, offset=0)
        return _make_page([], total=1, offset=1)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    result = AH.harvest(root, daily_request_cap=10)

    assert result["trusted_added"] >= 1, (
        f"Expected at least 1 trusted row, got {result['trusted_added']}"
    )

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) >= 1
    row = rows[0]
    assert row["evidence_level"] == "verified_db", (
        f"evidence_level={row['evidence_level']!r}, expected 'verified_db'"
    )
    assert row["barcode"] == _FORTUNE_UPC, (
        f"barcode={row['barcode']!r}, expected {_FORTUNE_UPC!r}"
    )


# ---------------------------------------------------------------------------
# 2. Non-tire item is skipped
# ---------------------------------------------------------------------------

def test_non_tire_item_skipped(monkeypatch, tmp_path):
    """
    An item whose title parse_name() cannot parse (no tire size)
    must be skipped — it must not appear in the flat CSV.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        if call_count[0] == 1:
            # Mix: one non-tire + one real tire
            return _make_page([_NON_TIRE_ITEM, _FORTUNE_ITEM_1], total=2, offset=0)
        return _make_page([], total=2, offset=2)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    result = AH.harvest(root, daily_request_cap=10)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    barcodes = [r["barcode"] for r in rows]
    assert _NON_TIRE_ITEM["upc"] not in barcodes, (
        "Non-tire item barcode should NOT appear in flat CSV"
    )
    assert _FORTUNE_UPC in barcodes, (
        "Fortune tire barcode should appear in flat CSV"
    )


# ---------------------------------------------------------------------------
# 3. Item with missing barcode is skipped
# ---------------------------------------------------------------------------

def test_item_with_missing_barcode_skipped(monkeypatch, tmp_path):
    """
    An item with empty upc and ean fields must be silently skipped.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        if call_count[0] == 1:
            return _make_page([_NO_BARCODE_ITEM, _FORTUNE_ITEM_1], total=2, offset=0)
        return _make_page([], total=2, offset=2)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    result = AH.harvest(root, daily_request_cap=10)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    barcodes = [r["barcode"] for r in rows]
    assert "" not in barcodes, "Empty barcode must not appear in flat CSV"
    assert _FORTUNE_UPC in barcodes, "Valid Fortune barcode must be present"


# ---------------------------------------------------------------------------
# 4. Offset paging advances and stops at total
# ---------------------------------------------------------------------------

def test_offset_paging_advances_and_stops(monkeypatch, tmp_path):
    """
    When total=2 and each page returns 1 item, search_brand should make 2
    API calls and stop (offset reaches total).
    """
    root = _make_temp_root(str(tmp_path))

    calls = []

    def fake_search(query, offset):
        calls.append(offset)
        if offset == 0:
            return _make_page([_FORTUNE_ITEM_1], total=2, offset=0)
        if offset == 1:
            return _make_page([_FORTUNE_ITEM_2], total=2, offset=1)
        return _make_page([], total=2, offset=offset)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)

    items, reqs, total = AH.search_brand("fortune tire", start_offset=0, budget=10)

    # Should have called with offset=0 and offset=1, then stopped
    assert 0 in calls, "Must call with offset=0"
    assert 1 in calls, "Must call with offset=1"
    assert len(items) == 2, f"Expected 2 items, got {len(items)}"
    assert reqs == 2, f"Expected 2 requests, got {reqs}"
    assert total == 2


def test_paging_stops_on_empty_page(monkeypatch):
    """
    When the API returns an empty items list, paging must stop even
    if offset < total.
    """
    calls = []

    def fake_search(query, offset):
        calls.append(offset)
        if offset == 0:
            return _make_page([_FORTUNE_ITEM_1], total=100, offset=0)
        # Second call returns empty — should stop
        return _make_page([], total=100, offset=1)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)

    items, reqs, total = AH.search_brand("fortune tire", start_offset=0, budget=10)

    assert len(calls) == 2, f"Expected exactly 2 calls, got {len(calls)}"
    assert len(items) == 1, f"Expected 1 item from first page only"


# ---------------------------------------------------------------------------
# 5. daily_request_cap is respected
# ---------------------------------------------------------------------------

def test_daily_cap_respected_harvest(monkeypatch, tmp_path):
    """
    With daily_request_cap=2 and PRIORITY_BRANDS=['fortune', 'blackhawk'],
    harvest() must stop after 2 requests total regardless of available pages.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        return _make_page([_FORTUNE_ITEM_1], total=999, offset=offset)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune", "blackhawk"])

    result = AH.harvest(root, daily_request_cap=2)

    assert result["requests_used"] <= 2, (
        f"Expected at most 2 requests, got {result['requests_used']}"
    )
    assert call_count[0] <= 2, (
        f"_search_page called {call_count[0]} times, expected <= 2"
    )


def test_daily_cap_search_brand_stops_at_budget(monkeypatch):
    """
    search_brand with budget=2 must stop after 2 calls even when total is large.
    """
    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        return _make_page([_FORTUNE_ITEM_1], total=1000, offset=offset)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)

    items, reqs, total = AH.search_brand("fortune tire", start_offset=0, budget=2)

    assert reqs == 2, f"Expected 2 requests, got {reqs}"
    assert call_count[0] == 2, f"_search_page called {call_count[0]} times, expected 2"


# ---------------------------------------------------------------------------
# 6. api_progress.json round-trips (written and offset advanced)
# ---------------------------------------------------------------------------

def test_api_progress_written_and_offset_advanced(monkeypatch, tmp_path):
    """
    After harvest(), api_progress.json must exist and contain the
    advanced offset for the brand that was processed.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        if call_count[0] == 1:
            return _make_page([_FORTUNE_ITEM_1], total=1, offset=0)
        return _make_page([], total=1, offset=1)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    AH.harvest(root, daily_request_cap=10)

    progress_path = os.path.join(root, "api_progress.json")
    assert os.path.exists(progress_path), "api_progress.json must be written"

    with open(progress_path, encoding="utf-8") as f:
        progress = json.load(f)

    assert "fortune" in progress, "fortune must have an entry in api_progress.json"
    # Offset must have advanced beyond 0
    assert progress["fortune"] >= 1, (
        f"fortune offset should be >= 1, got {progress['fortune']}"
    )


# ---------------------------------------------------------------------------
# 7. Resume: second harvest() picks up from saved offset
# ---------------------------------------------------------------------------

def test_resume_from_saved_offset(monkeypatch, tmp_path):
    """
    If api_progress.json already has fortune offset=1 (meaning offset=0 was
    already fetched), the second harvest() must start at offset=1, not offset=0.
    """
    root = _make_temp_root(str(tmp_path))

    # Pre-seed progress: fortune already fetched up to offset 1
    AH.save_progress(root, {"fortune": 1})

    call_offsets = []

    def fake_search(query, offset):
        call_offsets.append(offset)
        # Return the second page item
        return _make_page([_FORTUNE_ITEM_2], total=2, offset=offset)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    AH.harvest(root, daily_request_cap=5)

    # All calls must start from offset >= 1 (never re-fetch offset 0)
    assert all(o >= 1 for o in call_offsets), (
        f"harvest() must resume from offset 1+, got offsets: {call_offsets}"
    )
    assert 0 not in call_offsets, (
        "Offset 0 must NOT be re-fetched when progress says offset=1"
    )


# ---------------------------------------------------------------------------
# 8. EAN -> UPC barcode derivation
# ---------------------------------------------------------------------------

def test_barcode_from_item_upc_preferred():
    """When upc is a valid 12-digit string, it is returned as-is."""
    item = {"upc": _FORTUNE_UPC, "ean": _FORTUNE_EAN_13, "brand": "Fortune", "title": ""}
    assert AH._barcode_from_item(item) == _FORTUNE_UPC


def test_barcode_from_item_ean_stripped():
    """When upc is absent, a 13-digit EAN with leading '0' yields a 12-digit UPC."""
    item = {"upc": "", "ean": _FORTUNE_EAN_13, "brand": "Fortune", "title": ""}
    result = AH._barcode_from_item(item)
    assert result == _FORTUNE_UPC, (
        f"EAN strip should give {_FORTUNE_UPC!r}, got {result!r}"
    )


def test_barcode_from_item_missing_returns_empty():
    """No upc or ean -> returns empty string."""
    item = {"upc": "", "ean": "", "brand": "Fortune", "title": ""}
    assert AH._barcode_from_item(item) == ""


# ---------------------------------------------------------------------------
# 9. harvest() returns audit_ok=True with a clean corpus
# ---------------------------------------------------------------------------

def test_harvest_audit_ok(monkeypatch, tmp_path):
    """
    A complete harvest into a temp root must pass the corpus audit.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def fake_search(query, offset):
        call_count[0] += 1
        if call_count[0] == 1:
            return _make_page([_FORTUNE_ITEM_1], total=1, offset=0)
        return _make_page([], total=1, offset=1)

    monkeypatch.setattr(AH, "_search_page", fake_search)
    monkeypatch.setattr(AH, "_SLEEP_S", 0.0)
    monkeypatch.setattr(AH, "PRIORITY_BRANDS", ["fortune"])

    result = AH.harvest(root, daily_request_cap=10)

    assert result["audit_ok"] is True, (
        f"audit_ok is False. Errors: {result['_audit_errors']}"
    )


# ---------------------------------------------------------------------------
# 10. PRIORITY_BRANDS starts with niche-first brands
# ---------------------------------------------------------------------------

def test_priority_brands_niche_first_order():
    """
    PRIORITY_BRANDS must begin with the niche/budget brands in the specified order.
    """
    expected_first = [
        "fortune",
        "blackhawk",
        "milestar",
        "delinte",
        "federal",
        "nexen",
        "nokian",
        "toyo",
        "falken",
        "dunlop",
        "ironman",
        "hercules",
        "kumho",
    ]
    actual_first = AH.PRIORITY_BRANDS[:len(expected_first)]
    assert actual_first == expected_first, (
        f"PRIORITY_BRANDS first {len(expected_first)} entries wrong.\n"
        f"Expected: {expected_first}\n"
        f"Got:      {actual_first}"
    )


def test_priority_brands_no_duplicates():
    """PRIORITY_BRANDS must have no duplicate slugs."""
    seen = set()
    for b in AH.PRIORITY_BRANDS:
        assert b not in seen, f"Duplicate brand slug in PRIORITY_BRANDS: {b!r}"
        seen.add(b)


def test_priority_brands_all_brand_slugs_present():
    """Every slug from BRAND_SLUGS must appear in PRIORITY_BRANDS."""
    from upcitemdb_harvest import BRAND_SLUGS
    priority_set = set(AH.PRIORITY_BRANDS)
    for slug in BRAND_SLUGS:
        assert slug in priority_set, (
            f"BRAND_SLUGS slug {slug!r} is missing from PRIORITY_BRANDS"
        )
