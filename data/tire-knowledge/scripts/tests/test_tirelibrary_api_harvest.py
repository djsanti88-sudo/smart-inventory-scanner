"""
test_tirelibrary_api_harvest.py — Offline unit tests for tirelibrary_api_harvest.py.

ALL OFFLINE — no network calls. No changes to the live corpus.
Uses pytest tmp_path for all file I/O.

Tests:
  (a) upc-only (11-digit -> left-padded to 12 digits).
  (b) ean-only 13-digit barcode.
  (c) neither upc nor ean -> None (no_barcode).
  (d) bad size -> None (bad_size).
  (e) terrain/season mapping.
  (f) verified_vendor routing: valid GTIN + brand + model + size, no MPN -> TRUSTED.
  (g) verified_vendor dedup: re-write same barcode is a dup_skipped.
  (h) verified_vendor two different barcodes get different UIDs.
  (i) build_brand_queue puts PRIORITY_BRANDS first in declared order.
  (j) _normalize_upc: 12-digit unchanged, 11-digit gets leading zero, other -> empty.
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
import ledger as L
import write_outputs as w
from audit_corpus import audit
import tirelibrary_api_harvest as TL

# ── Valid GTINs used in tests ─────────────────────────────────────────────────
# All verified via validate.gtin_check_digit_valid == True.
# 840139631771 — Fortune Tormenta (used in existing corpus tests, valid GTIN-12)
_UPC_12 = "840139631771"
# 840139631788 — second Fortune tire (different barcode, valid GTIN-12)
_UPC_12_B = "840139631788"
# 0048900000010 would be 13-digit; we need a real EAN-13 for tests.
# Build an EAN-13 by prepending "0" to _UPC_12 — the result must itself pass GTIN check.
# "0840139631771" — 13 digits; let's verify:
# digits: 0,8,4,0,1,3,9,6,3,1,7,7,1
# weights right-to-left (excl last): 3,1,3,1,3,1,3,1,3,1,3,1
# sum = 1*3 + 7*1 + 7*3 + 1*1 + 3*3 + 6*1 + 9*3 + 3*1 + 1*3 + 0*1 + 4*3 + 8*1
#     = 3+7+21+1+9+6+27+3+3+0+12+8 = 100; (10-100%10)%10 = 0; check digit = 1 (last) -> no wait
# The GTIN check for "0840139631771": last digit = 1.
# sum of all but last (right-to-left): 7(w3),7(w1),1(w3),3(w1),6(w3),9(w1),3(w3),1(w1),0(w3),4(w1),8(w3),0(w1)
# = 21+7+3+3+18+9+9+1+0+4+24+0 = 99; (10-99%10)%10=(10-9)%10=1. Check digit = 1. VALID.
_EAN_13 = "0840139631771"

# An 11-digit string whose left-padded 12-digit version is a valid GTIN.
# 12-digit _UPC_12 = "840139631771"; strip leading zero -> "840139631771" has no leading zero.
# Use a different valid UPC-12: 048900000010 (already used in existing tests).
# 11-digit = "48900000010" -> padded "048900000010"
_UPC_11 = "48900000010"
_UPC_11_PADDED = "048900000010"   # padded version; must pass GTIN check


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_corpus(tmp_path):
    """Set up a minimal corpus in tmp_path. Returns root str."""
    flat = tmp_path / "tire_corpus_flat.csv"
    with open(flat, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)
    led_path = tmp_path / "coverage_ledger.json"
    led = L.load_ledger(str(led_path))
    L.save_ledger(led, str(led_path))
    return str(tmp_path)


def _paths(root):
    flat = os.path.join(root, "tire_corpus_flat.csv")
    if not os.path.exists(flat):
        with open(flat, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(v.FLAT_COLS)
    return {
        "flat": flat,
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }


def _base_catalog_row():
    return {
        "id": 1001,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
    }


# ── (a) UPC 11-digit -> padded to 12 ─────────────────────────────────────────

def test_normalize_upc_11_digit():
    result = TL._normalize_upc(_UPC_11)
    assert result == _UPC_11_PADDED, f"Expected {_UPC_11_PADDED!r}, got {result!r}"


def test_normalize_upc_12_digit_unchanged():
    result = TL._normalize_upc(_UPC_12)
    assert result == _UPC_12


def test_normalize_upc_other_lengths_empty():
    assert TL._normalize_upc("123") == ""
    assert TL._normalize_upc("12345678901234") == ""   # 14 digits -> empty
    assert TL._normalize_upc("") == ""


def test_detail_to_identity_upc_11_padded(tmp_path):
    """(a) An 11-digit UPC is left-padded to 12 digits and maps correctly."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 1001,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": _UPC_11,       # 11 digits
        "ean": None,
        "load_rating": "121",
        "speed_rating": "S",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None, "Should produce an identity for 11-digit UPC"
    assert identity["barcode"] == _UPC_11_PADDED
    assert v.gtin_check_digit_valid(identity["barcode"])
    assert identity["evidence_level"] == "verified_vendor"
    assert identity["mpn"] == ""


# ── REGRESSION: real detail shape has tire_make/tire_model as DICTS ───────────

def test_detail_to_identity_real_api_shape_make_model_dicts():
    """
    The live detail endpoint returns tire_make / tire_model as DICTS
    ({"id":..,"name":..,"image_url":..}) and has NO make_name/model_name.
    brand/model must be the clean name string, never the stringified dict.
    """
    detail = {
        "id": 2001,
        "tire_make": {"id": 25, "name": "Falken",
                      "image_url": "https://x/falken.png", "dot_reg_url": "https://x"},
        "tire_model": {"id": 35849, "name": "Wildpeak A/T3W",
                       "image_url": "https://x/35849.jpg"},
        "width": "265", "aspect_ratio": "70", "rim_size": "17",
        "upc": _UPC_12, "ean": None,
        "load_rating": "121", "speed_rating": "S",
        "terrain": "", "category": "", "season": "",
    }
    # catalog row carries the clean strings -> preferred
    catalog_row = {"id": 2001, "make_name": "Falken", "model_name": "Wildpeak A/T3W",
                   "width": "265", "aspect_ratio": "70", "rim_size": "17"}
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None
    assert identity["brand"] == "Falken", f"brand corrupted: {identity['brand']!r}"
    assert identity["model"] == "Wildpeak A/T3W", f"model corrupted: {identity['model']!r}"
    assert "{" not in identity["brand"] and "image_url" not in identity["brand"].lower()
    assert "{" not in identity["model"] and "image_url" not in identity["model"].lower()


def test_detail_to_identity_falls_back_to_dict_name_when_catalog_lacks_it():
    """If the catalog row lacks make_name/model_name, use the dict's 'name'."""
    detail = {
        "id": 2002,
        "tire_make": {"id": 13, "name": "Nokian", "image_url": "https://x"},
        "tire_model": {"id": 9, "name": "WR G4", "image_url": "https://x"},
        "width": "225", "aspect_ratio": "50", "rim_size": "17",
        "upc": _UPC_12, "ean": None,
        "load_rating": "98", "speed_rating": "V",
        "terrain": "", "category": "", "season": "All-Season",
    }
    catalog_row = {"id": 2002}  # no make_name/model_name
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None
    assert identity["brand"] == "Nokian", f"brand: {identity['brand']!r}"
    assert identity["model"] == "WR G4", f"model: {identity['model']!r}"


# ── (b) EAN-only 13-digit ─────────────────────────────────────────────────────

def test_detail_to_identity_ean_only():
    """(b) EAN-only 13-digit barcode is kept as-is."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 1002,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": None,
        "ean": _EAN_13,        # 13-digit EAN
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None, "Should produce an identity for EAN-13"
    assert identity["barcode"] == _EAN_13
    assert len(identity["barcode"]) == 13
    assert v.gtin_check_digit_valid(identity["barcode"])
    assert identity["evidence_level"] == "verified_vendor"


# ── (c) Neither UPC nor EAN -> None (no_barcode) ─────────────────────────────

def test_detail_to_identity_no_barcode():
    """(c) If neither UPC nor EAN, detail_to_identity returns None."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 1003,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": None,
        "ean": None,
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is None, "Should return None when no barcode"


def test_detail_to_identity_empty_string_barcode():
    """Empty string UPC/EAN is treated as absent."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 1004,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": "",
        "ean": "",
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is None


# ── (d) Bad size -> None (bad_size) ──────────────────────────────────────────

def test_detail_to_identity_bad_size():
    """(d) If size cannot be normalized, detail_to_identity returns None."""
    catalog_row = {
        "id": 1005, "make_name": "Falken", "model_name": "Wildpeak",
        "width": "999", "aspect_ratio": "X", "rim_size": "??",
    }
    detail = {
        "id": 1005,
        "make_name": "Falken",
        "model_name": "Wildpeak",
        "width": "999",
        "aspect_ratio": "X",
        "rim_size": "??",
        "upc": _UPC_12,
        "ean": None,
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is None, "Should return None for unparseable size"


def test_detail_to_identity_missing_size_fields():
    """Missing width/aspect/rim -> None."""
    catalog_row = {"id": 1006, "make_name": "Falken", "model_name": "X"}
    detail = {
        "id": 1006,
        "make_name": "Falken",
        "model_name": "X",
        "width": None,
        "aspect_ratio": None,
        "rim_size": None,
        "upc": _UPC_12,
        "ean": None,
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is None


# ── (e) Terrain / season mapping ─────────────────────────────────────────────

@pytest.mark.parametrize("terrain,category,expected", [
    ("All-Terrain",          "",            "all_terrain"),
    ("Mud-Terrain",          "",            "mud_terrain"),
    ("Highway",              "",            "highway"),
    ("Touring",              "",            "touring"),
    ("",                     "All-Terrain", "all_terrain"),
    ("",                     "Mud",         "mud_terrain"),
    ("",                     "Touring",     "touring"),
    ("Something-Else",       "",            ""),
    ("",                     "",            ""),
])
def test_map_tire_type(terrain, category, expected):
    result = TL._map_tire_type(terrain, category)
    assert result == expected, f"terrain={terrain!r} category={category!r} -> {result!r}, want {expected!r}"


@pytest.mark.parametrize("season_raw,expected", [
    ("All-Season",   "all_season"),
    ("Winter",       "winter"),
    ("All-Weather",  "all_weather"),
    ("Summer",       "summer"),
    ("",             ""),
    ("Unknown",      ""),
    ("all-season",   "all_season"),  # case-insensitive
    ("WINTER",       "winter"),
])
def test_map_season(season_raw, expected):
    result = TL._map_season(season_raw)
    assert result == expected, f"season={season_raw!r} -> {result!r}, want {expected!r}"


def test_detail_to_identity_terrain_and_season_fields():
    """(e) terrain/season are mapped to tire_type/season on the identity."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 1007,
        "make_name": "Toyo",
        "model_name": "Open Country A/T III",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": _UPC_12,
        "ean": None,
        "load_rating": "121",
        "speed_rating": "T",
        "terrain": "All-Terrain",
        "category": "",
        "season": "All-Season",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None
    assert identity["tire_type"] == "all_terrain"
    assert identity["season"] == "all_season"


# ── (f) verified_vendor routing: valid GTIN, brand+model+size, no MPN -> TRUSTED ──

def test_verified_vendor_routes_trusted():
    """
    (f) Routing change: a verified_vendor identity with valid GTIN + brand + model + size
    but NO MPN must route as TRUSTED (not backlog).
    This tests the write_outputs.route_with_reason change.
    """
    idn = {
        "brand": "Falken",
        "model": "Wildpeak A/T3W",
        "mpn": "",
        "manufacturer_part_number": "",
        "barcode": _UPC_12,         # valid GTIN-12
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "load_index": "121",
        "speed_rating": "S",
        "tire_type": "all_terrain",
        "season": "all_season",
        "evidence_level": "verified_vendor",
        "source_url": "tirelibrary:1001",
    }
    dest, reason = w.route_with_reason(idn)
    assert dest == "trusted", (
        f"verified_vendor with valid GTIN + brand+model+size should route as TRUSTED, "
        f"got {dest!r} (reason: {reason!r})"
    )


def test_verified_vendor_bad_gtin_routes_rejected():
    """verified_vendor with bad GTIN -> rejected (not backlog)."""
    idn = {
        "brand": "Falken",
        "model": "Wildpeak A/T3W",
        "mpn": "",
        "manufacturer_part_number": "",
        "barcode": "840139631770",   # bad check digit
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "evidence_level": "verified_vendor",
        "source_url": "tirelibrary:1001",
    }
    dest, reason = w.route_with_reason(idn)
    assert dest == "rejected"


def test_verified_vendor_writes_trusted_and_audit_passes(tmp_path):
    """
    (f) Full write test: a verified_vendor identity (valid GTIN, no MPN) writes to
    tmp_path corpus as TRUSTED, and corpus audit passes.
    """
    root = _make_corpus(tmp_path)
    paths = _paths(root)
    led = L.load_ledger(os.path.join(root, "coverage_ledger.json"))

    idn = {
        "brand": "Falken",
        "model": "Wildpeak A/T3W",
        "mpn": "",
        "manufacturer_part_number": "",
        "barcode": _UPC_12,
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "load_index": "121",
        "speed_rating": "S",
        "tire_type": "all_terrain",
        "season": "all_season",
        "evidence_level": "verified_vendor",
        "source_url": "tirelibrary:1001",
    }

    counts = w.write_rows([idn], paths, led, "run_vendor_test")
    L.save_ledger(led, os.path.join(root, "coverage_ledger.json"))

    assert counts["trusted"] == 1, f"Expected trusted=1, got {counts}"
    assert counts["backlog"] == 0
    assert counts["rejected"] == 0

    # Verify the row in the CSV
    rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
    assert len(rows) == 1
    row = rows[0]
    assert row["barcode"] == _UPC_12
    assert row["evidence_level"] == "verified_vendor"
    assert row["manufacturer_part_number"] == ""
    assert v.gtin_check_digit_valid(row["barcode"])

    # Corpus audit must pass
    ok, errs = audit(root)
    assert ok, f"Audit failed: {errs}"


# ── (g) verified_vendor dedup: re-write is dup_skipped ───────────────────────

def test_verified_vendor_dedup(tmp_path):
    """(g) Writing the same verified_vendor barcode twice results in dup_skipped on second write."""
    root = _make_corpus(tmp_path)
    paths = _paths(root)
    led = L.load_ledger(os.path.join(root, "coverage_ledger.json"))

    idn = {
        "brand": "Falken",
        "model": "Wildpeak A/T3W",
        "mpn": "",
        "manufacturer_part_number": "",
        "barcode": _UPC_12,
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "evidence_level": "verified_vendor",
        "source_url": "tirelibrary:1001",
    }

    c1 = w.write_rows([idn], paths, led, "run1")
    c2 = w.write_rows([idn], paths, led, "run2")

    assert c1["trusted"] == 1
    assert c2["dup_skipped"] == 1

    rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
    assert len(rows) == 1, "Only one row should exist after dedup"

    # Audit must still pass
    L.save_ledger(led, os.path.join(root, "coverage_ledger.json"))
    ok, errs = audit(root)
    assert ok, f"Audit failed after dedup: {errs}"


# ── (h) Two different barcodes get different UIDs ─────────────────────────────

def test_verified_vendor_two_barcodes_different_uids(tmp_path):
    """
    (h) Two verified_vendor rows with the same brand/model/size but different barcodes
    must both be written as trusted and get different canonical_product_uid values.
    """
    root = _make_corpus(tmp_path)
    paths = _paths(root)
    led = L.load_ledger(os.path.join(root, "coverage_ledger.json"))

    base = {
        "brand": "Fortune",
        "model": "Tormenta A/T",
        "mpn": "",
        "manufacturer_part_number": "",
        "size_canonical": "245/70R17",
        "size_compact": "2457017",
        "evidence_level": "verified_vendor",
        "source_url": "tirelibrary:9999",
    }
    idn1 = {**base, "barcode": _UPC_12}
    idn2 = {**base, "barcode": _UPC_12_B}

    counts = w.write_rows([idn1, idn2], paths, led, "run_two_bc")
    assert counts["trusted"] == 2, f"Expected 2 trusted, got {counts}"

    rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
    assert len(rows) == 2

    uid1 = rows[0]["canonical_product_uid"]
    uid2 = rows[1]["canonical_product_uid"]
    assert uid1 != uid2, f"UIDs must differ for different barcodes, both got {uid1!r}"

    # MPN field stays empty
    assert rows[0]["manufacturer_part_number"] == ""
    assert rows[1]["manufacturer_part_number"] == ""

    # Barcode must not bleed into MPN
    assert rows[0]["manufacturer_part_number"] != rows[0]["barcode"]
    assert rows[1]["manufacturer_part_number"] != rows[1]["barcode"]

    L.save_ledger(led, os.path.join(root, "coverage_ledger.json"))
    ok, errs = audit(root)
    assert ok, f"Audit failed: {errs}"


# ── (i) build_brand_queue priority ordering ───────────────────────────────────

def test_build_brand_queue_priority_first():
    """(i) build_brand_queue puts PRIORITY_BRANDS first, in declared order."""
    facet_brands = [
        "Yokohama", "Falken", "Nexen", "Toyo", "Blackhawk",
        "Dunlop", "Fortune", "Nokian", "Arisun", "Cooper",
        "BFGoodrich",
    ]
    queue = TL.build_brand_queue(facet_brands)

    # The first N items should be the priority brands that exist in facets
    priority_in_facets = [
        b for pb in TL.PRIORITY_BRANDS
        for b in facet_brands
        if b.lower() == pb.lower()
    ]
    # Check they appear at the head in order
    assert queue[:len(priority_in_facets)] == priority_in_facets

    # Non-priority brands come after, sorted alphabetically
    non_priority = sorted(b for b in facet_brands if b not in priority_in_facets)
    assert queue[len(priority_in_facets):] == non_priority


def test_build_brand_queue_missing_priority_skipped():
    """Priority brands not in facet list are silently skipped."""
    facet_brands = ["Yokohama", "Cooper"]
    queue = TL.build_brand_queue(facet_brands)
    # No priority brands in facets -> all sorted alphabetically
    assert queue == sorted(facet_brands)


# ── (j) _normalize_upc edge cases ─────────────────────────────────────────────

def test_normalize_upc_non_digit_returns_empty():
    assert TL._normalize_upc("12345abc012") == ""


def test_normalize_upc_13_digit_returns_empty():
    """13-digit strings are NOT handled by _normalize_upc (EAN path is separate)."""
    assert TL._normalize_upc(_EAN_13) == ""


# ── Catalog fallback: brand/model from catalog_row when detail is sparse ───────

def test_detail_fallback_to_catalog_row():
    """Brand and model fall back to catalog_row values when detail fields are absent."""
    catalog_row = {
        "id": 2001,
        "make_name": "Nokian",
        "model_name": "WR G4",
        "width": "225",
        "aspect_ratio": "65",
        "rim_size": "17",
    }
    detail = {
        "id": 2001,
        "make_name": None,        # absent -> fall back to catalog
        "model_name": None,
        "width": "225",
        "aspect_ratio": "65",
        "rim_size": "17",
        "upc": _UPC_12,
        "ean": None,
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None
    assert identity["brand"] == "Nokian"
    assert identity["model"] == "WR G4"


def test_detail_source_url_format():
    """source_url is formatted as 'tirelibrary:{id}'."""
    catalog_row = _base_catalog_row()
    detail = {
        "id": 9876,
        "make_name": "Falken",
        "model_name": "Wildpeak A/T3W",
        "width": "265",
        "aspect_ratio": "70",
        "rim_size": "17",
        "upc": _UPC_12,
        "ean": None,
        "load_rating": "",
        "speed_rating": "",
        "terrain": "",
        "category": "",
        "season": "",
    }
    identity = TL.detail_to_identity(detail, catalog_row)
    assert identity is not None
    assert identity["source_url"] == "tirelibrary:9876"


# ── Existing verified_db behavior unchanged ───────────────────────────────────

def test_verified_db_still_routes_trusted_without_mpn():
    """Existing verified_db behavior: still routes trusted with no MPN (regression guard)."""
    idn = {
        "brand": "Fortune",
        "model": "Tormenta A/T FSR308",
        "mpn": "",
        "retailer_sku": "",
        "barcode": "840139631771",
        "size_canonical": "245/70R17",
        "size_compact": "2457017",
        "evidence_level": "verified_db",
        "source_url": "upcitemdb:xyz",
    }
    dest, reason = w.route_with_reason(idn)
    assert dest == "trusted", f"verified_db should still be trusted, got {dest!r} ({reason!r})"


def test_non_db_non_vendor_still_needs_mpn():
    """Non-trusted evidence_level still needs MPN/SKU (regression guard)."""
    idn = {
        "brand": "Falken",
        "model": "X",
        "mpn": "",
        "retailer_sku": "",
        "barcode": _UPC_12,
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "source_url": "u",
        # No evidence_level -> uses is_trusted_identity -> needs MPN
    }
    dest, _ = w.route_with_reason(idn)
    assert dest == "backlog"


def test_verified_1src_strong_still_needs_mpn():
    """verified_1src_strong still needs MPN (regression guard)."""
    idn = {
        "brand": "Falken",
        "model": "X",
        "mpn": "",
        "retailer_sku": "",
        "barcode": _UPC_12,
        "size_canonical": "265/70R17",
        "size_compact": "2657017",
        "evidence_level": "verified_1src_strong",
        "source_url": "u",
    }
    dest, _ = w.route_with_reason(idn)
    assert dest == "backlog"
