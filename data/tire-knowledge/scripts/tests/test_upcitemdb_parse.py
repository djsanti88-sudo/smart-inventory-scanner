"""
Tests for upcitemdb_parse.py — all offline, uses saved fixture only.
No network calls. No paid APIs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import upcitemdb_parse as p

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "upcitemdb_fortune.html")


def _load_fixture() -> str:
    with open(FIXTURE_PATH, encoding="utf-8") as f:
        return f.read()


# ── extract_rows ───────────────────────────────────────────────────────────────

def test_extract_rows_returns_at_least_20():
    html = _load_fixture()
    rows = p.extract_rows(html)
    assert len(rows) >= 20, f"Expected >= 20 rows, got {len(rows)}"


def test_extract_rows_are_tuples_of_upc_and_name():
    html = _load_fixture()
    rows = p.extract_rows(html)
    for upc, name in rows:
        assert upc.isdigit(), f"UPC not all digits: {upc!r}"
        assert len(upc) in (12, 13, 14), f"UPC wrong length: {upc!r}"
        assert name.strip(), f"Empty name for UPC {upc!r}"


def test_extract_rows_no_duplicate_upcs():
    html = _load_fixture()
    rows = p.extract_rows(html)
    upcs = [upc for upc, _ in rows]
    assert len(upcs) == len(set(upcs)), "Duplicate UPCs found"


def test_extract_rows_contains_known_upc():
    html = _load_fixture()
    rows = p.extract_rows(html)
    upcs = {upc for upc, _ in rows}
    assert "840139631771" in upcs, "Known UPC 840139631771 not found"
    assert "840063601130" in upcs, "Known UPC 840063601130 not found"


# ── parse_name — standard all_terrain row ────────────────────────────────────

def test_parse_name_all_terrain_row():
    name = "Fortune Tormenta A/T FSR308 All Terrain 245/70R17 110T Light Truck Tire"
    result = p.parse_name(name)
    assert result, "Expected non-empty dict"
    assert result["size_canonical"] == "245/70R17"
    assert result["size_compact"] == "2457017"
    assert result["load_index"] == "110"
    assert result["speed_rating"] == "T"
    assert result["tire_type"] == "all_terrain"


# ── parse_name — trailer row with dual load/speed ────────────────────────────

def test_parse_name_trailer_row():
    name = "Fortune ST01 ST235/85R16 125/121M E Trailer Tire"
    result = p.parse_name(name)
    assert result, "Expected non-empty dict"
    assert result["size_canonical"] == "ST235/85R16"
    assert result["load_index"] == "125/121"
    assert result["speed_rating"] == "M"


# ── parse_name — bike/non-tire name returns {} ────────────────────────────────

def test_parse_name_bike_tire_returns_empty():
    name = "Arisun Cutting Edge 20x2.1 BK"
    result = p.parse_name(name)
    assert result == {}, f"Expected empty dict for bike tire, got {result!r}"


def test_parse_name_non_tire_string_returns_empty():
    result = p.parse_name("Tire Pressure Gauge 0-60 PSI")
    assert result == {}, f"Expected empty dict, got {result!r}"


# ── parse_name — ZR tires parse correctly ─────────────────────────────────────

def test_parse_name_zr_tire():
    name = "Fortune Viento FSR702 All Season 235/40ZR18 95Y XL Passenger Tire"
    result = p.parse_name(name)
    assert result, f"Expected non-empty dict for ZR tire, got {result!r}"
    assert result["size_canonical"] == "235/40R18"
    assert result["size_compact"] == "2354018"
    assert result["season"] == "all_season"
    assert result["tire_type"] == "passenger"


# ── parse_name — floatation / LT-X format ────────────────────────────────────

def test_parse_name_floatation_lt_format():
    name = "Fortune Tormenta M/T FSR310 Mud Terrain LT37X13.50R20 127Q E Light Truck Tire"
    result = p.parse_name(name)
    assert result, f"Expected non-empty dict for floatation tire, got {result!r}"
    # normalize_size turns LT37X13.50R20 -> LT37/13.50R20
    assert result["size_canonical"] == "LT37/13.50R20"
    assert result["tire_type"] == "mud_terrain"
    assert result["load_index"] == "127"
    assert result["speed_rating"] == "Q"


# ── parse_name — highway terrain ─────────────────────────────────────────────

def test_parse_name_highway_terrain():
    name = "Fortune Tormenta H/T FSR305 Highway Terrain 235/75R16 112T XL Light Truck Tire"
    result = p.parse_name(name)
    assert result, "Expected non-empty dict"
    assert result["tire_type"] == "highway"
    assert result["size_canonical"] == "235/75R16"


# ── parse_name — MPN extraction ───────────────────────────────────────────────

def test_parse_name_mpn_extracted():
    name = "Fortune Tormenta A/T FSR308 All Terrain 245/70R17 110T Light Truck Tire"
    result = p.parse_name(name)
    assert result.get("mpn") == "FSR308", f"Expected FSR308, got {result.get('mpn')!r}"


def test_parse_name_st01_mpn():
    name = "Fortune ST01 ST235/85R16 125/121M E Trailer Tire"
    result = p.parse_name(name)
    assert result.get("mpn") == "ST01", f"Expected ST01, got {result.get('mpn')!r}"


# ── parse_page ────────────────────────────────────────────────────────────────

def test_parse_page_all_have_size_compact_and_barcode():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    assert len(rows) > 0, "Expected at least one parsed row"
    for row in rows:
        assert row["size_compact"], f"Empty size_compact in row: {row}"
        assert row["barcode"], f"Empty barcode in row: {row}"


def test_parse_page_brand_override():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    for row in rows:
        assert row["brand"] == "Fortune", f"Brand not overridden: {row['brand']!r}"


def test_parse_page_known_row_840139631771():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    matching = [r for r in rows if r["barcode"] == "840139631771"]
    assert len(matching) == 1, f"Expected exactly 1 row for UPC 840139631771, got {len(matching)}"
    row = matching[0]
    assert row["size_canonical"] == "245/70R17"
    assert row["load_index"] == "110"
    assert row["speed_rating"] == "T"
    assert row["tire_type"] == "all_terrain"


def test_parse_page_known_row_840063601130():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    matching = [r for r in rows if r["barcode"] == "840063601130"]
    assert len(matching) == 1, f"Expected exactly 1 row for UPC 840063601130, got {len(matching)}"
    row = matching[0]
    assert row["size_canonical"] == "ST235/85R16"
    assert row["load_index"] == "125/121"
    assert row["speed_rating"] == "M"


def test_parse_page_source_url_is_empty_string():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    for row in rows:
        assert row["source_url"] == "", f"source_url should be empty string"


def test_parse_page_required_keys_present():
    html = _load_fixture()
    rows = p.parse_page(html, "Fortune")
    required = {"brand", "model", "mpn", "barcode", "size_canonical",
                "size_compact", "load_index", "speed_rating", "tire_type",
                "season", "source_url"}
    for row in rows:
        missing = required - set(row.keys())
        assert not missing, f"Row missing keys {missing}: {row}"
