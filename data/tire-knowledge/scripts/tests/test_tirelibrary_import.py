"""
test_tirelibrary_import.py — Tests for tirelibrary_import.py.

All tests are offline. No network calls. No changes to the live corpus.
Uses pytest tmp_path for all file I/O.
"""

import csv
import io
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import validate as v
import tirelibrary_import as tl
import ledger as L


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_corpus(tmp_path):
    """
    Set up a minimal corpus directory in tmp_path:
    - tire_corpus_flat.csv with correct FLAT_COLS header
    - coverage_ledger.json (empty)
    Returns the tmp_path as root.
    """
    flat = tmp_path / "tire_corpus_flat.csv"
    with open(flat, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    ledger_path = tmp_path / "coverage_ledger.json"
    led = L.load_ledger(str(ledger_path))
    L.save_ledger(led, str(ledger_path))

    return str(tmp_path)


def _write_csv(tmp_path, rows, filename="tirelibrary_test.csv"):
    """Write a list-of-dict rows to a CSV file in tmp_path. First row is header."""
    path = tmp_path / filename
    if not rows:
        path.write_text("", encoding="utf-8")
        return str(path)
    header = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)
    return str(path)


# ── Fixture data ───────────────────────────────────────────────────────────────
# Valid GTIN barcodes verified by gtin_check_digit_valid:
#   048900000010, 048900000027, 048900000034, 048900000041 (all True)
#   840139631771 — Fortune tire (used in existing corpus tests)
#   EAN-13: 0840139631771 — strips leading 0 -> UPC 840139631771 (valid)

VALID_ROW_1 = {
    "Brand": "Falken",
    "Model": "Wildpeak A/T3W",
    "Size": "265/70R17",
    "UPC": "048900000010",
    "EAN": "",
    "MPC": "AT3W26570R17",
    "LoadIndex": "121",
    "SpeedRating": "S",
    "Type": "all_terrain",
}

VALID_ROW_2 = {
    "Brand": "Nitto",
    "Model": "Terra Grappler G2",
    "Size": "275/60R20",
    "UPC": "048900000027",
    "EAN": "",
    "MPC": "NITTO27560R20",
    "LoadIndex": "115",
    "SpeedRating": "T",
    "Type": "all_terrain",
}

VALID_ROW_3 = {
    "Brand": "Cooper",
    "Model": "Discoverer AT3 4S",
    "Size": "225/65R17",
    "UPC": "048900000034",
    "EAN": "",
    "MPC": "COOP22565R17",
    "LoadIndex": "102",
    "SpeedRating": "T",
    "Type": "",
}

# EAN-only row: EAN-13 starting with '0' so we can derive UPC-12
EAN_ONLY_ROW = {
    "Brand": "Fortune",
    "Model": "Tormenta A/T FSR308",
    "Size": "245/70R17",
    "UPC": "",                     # no UPC column value
    "EAN": "0840139631771",        # EAN-13; strip leading 0 -> 840139631771 (valid UPC-12)
    "MPC": "FSR308",
    "LoadIndex": "110",
    "SpeedRating": "T",
    "Type": "all_terrain",
}

# Junk row: invalid barcode AND no EAN -> should be skipped
JUNK_ROW = {
    "Brand": "Fake",
    "Model": "NoSize NoBarcode",
    "Size": "not-a-size",
    "UPC": "000000000000",         # all-same digit -> invalid GTIN
    "EAN": "",
    "MPC": "",
    "LoadIndex": "",
    "SpeedRating": "",
    "Type": "",
}

# All 5 test rows
ALL_ROWS = [VALID_ROW_1, VALID_ROW_2, VALID_ROW_3, EAN_ONLY_ROW, JUNK_ROW]


# ── detect_columns ─────────────────────────────────────────────────────────────

def test_detect_columns_finds_all_mapped_fields():
    header = ["Brand", "Model", "Size", "UPC", "EAN", "MPC", "LoadIndex", "SpeedRating", "Type"]
    colmap = tl.detect_columns(header)
    assert colmap["brand"] == "Brand"
    assert colmap["model"] == "Model"
    assert colmap["size"] == "Size"
    assert colmap["barcode"] == "UPC"
    assert colmap["ean"] == "EAN"
    assert colmap["mpn"] == "MPC"
    assert colmap["load_index"] == "LoadIndex"
    assert colmap["speed_rating"] == "SpeedRating"
    assert colmap["tire_type"] == "Type"


def test_detect_columns_case_insensitive():
    header = ["brand", "model", "size", "upc_a", "ean13", "mpn"]
    colmap = tl.detect_columns(header)
    assert colmap["brand"] == "brand"
    assert colmap["barcode"] == "upc_a"
    assert colmap["ean"] == "ean13"
    assert colmap["mpn"] == "mpn"


def test_detect_columns_raises_on_missing_required():
    header = ["Brand", "Model"]  # no size, no barcode/ean
    with pytest.raises(ValueError) as exc_info:
        tl.detect_columns(header)
    msg = str(exc_info.value)
    assert "missing required" in msg.lower() or "missing" in msg.lower()


def test_detect_columns_raises_on_no_barcode():
    header = ["Brand", "Model", "Size"]  # has size + brand + model but no barcode/ean
    with pytest.raises(ValueError):
        tl.detect_columns(header)


def test_detect_columns_accepts_ean_without_upc():
    header = ["Brand", "Model", "Size", "EAN"]
    colmap = tl.detect_columns(header)
    assert "ean" in colmap
    assert "barcode" not in colmap


def test_detect_columns_gtin12_alias():
    header = ["brand", "model", "size", "gtin12"]
    colmap = tl.detect_columns(header)
    assert colmap["barcode"] == "gtin12"


# ── row_to_identity ────────────────────────────────────────────────────────────

def test_row_to_identity_valid_row():
    header = list(VALID_ROW_1.keys())
    colmap = tl.detect_columns(header)
    identity = tl.row_to_identity(VALID_ROW_1, colmap)
    assert identity is not None
    assert identity["barcode"] == "048900000010"
    assert v.gtin_check_digit_valid(identity["barcode"])
    assert identity["brand"].lower() == "falken"
    assert identity["size_canonical"] == "265/70R17"
    assert identity["size_compact"] == "2657017"
    assert identity["evidence_level"] == "verified_vendor"
    assert identity["source_url"] == "tirelibrary"
    assert identity["mpn"] == "AT3W26570R17"
    assert identity["manufacturer_part_number"] == "AT3W26570R17"


def test_row_to_identity_ean_only_derives_upc():
    """EAN-13 starting with '0' should yield a 12-digit UPC."""
    header = list(EAN_ONLY_ROW.keys())
    colmap = tl.detect_columns(header)
    identity = tl.row_to_identity(EAN_ONLY_ROW, colmap)
    assert identity is not None
    assert identity["barcode"] == "840139631771"
    assert len(identity["barcode"]) == 12
    assert v.gtin_check_digit_valid(identity["barcode"])
    assert identity["size_canonical"] == "245/70R17"


def test_row_to_identity_junk_row_returns_none():
    """Row with invalid barcode and no size should be skipped."""
    header = list(JUNK_ROW.keys())
    colmap = tl.detect_columns(header)
    identity = tl.row_to_identity(JUNK_ROW, colmap)
    assert identity is None


def test_row_to_identity_no_barcode_returns_none():
    row = {**VALID_ROW_1, "UPC": "", "EAN": ""}
    header = list(row.keys())
    colmap = tl.detect_columns(header)
    identity = tl.row_to_identity(row, colmap)
    assert identity is None


def test_row_to_identity_no_valid_size_returns_none():
    row = {**VALID_ROW_1, "Size": "GARBAGE-NOT-A-SIZE"}
    header = list(row.keys())
    colmap = tl.detect_columns(header)
    identity = tl.row_to_identity(row, colmap)
    assert identity is None


# ── import_csv integration ──────────────────────────────────────────────────────

def test_import_csv_valid_rows_are_trusted(tmp_path):
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, ALL_ROWS)

    summary = tl.import_csv(csv_path, root)

    # 3 valid rows + 1 EAN-only = 4 parsed; 1 junk row skipped
    assert summary["total_rows"] == 5
    assert summary["parsed"] == 4, f"Expected 4 parsed, got {summary['parsed']}"
    # All 4 parsed should be trusted (all have MPN which is needed for verified_vendor routing)
    assert summary["trusted"] == 4, f"Expected 4 trusted, got {summary['trusted']}"
    assert summary["dup_skipped"] == 0
    assert summary["rejected"] == 0


def test_import_csv_trusted_rows_have_correct_evidence_level(tmp_path):
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, [VALID_ROW_1])

    tl.import_csv(csv_path, root)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    rows = list(csv.DictReader(open(flat_path, encoding="utf-8")))
    assert len(rows) == 1
    assert rows[0]["evidence_level"] == "verified_vendor"
    assert rows[0]["barcode"] == "048900000010"
    assert rows[0]["size_canonical"] == "265/70R17"


def test_import_csv_ean_only_row_derives_12digit_barcode(tmp_path):
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, [EAN_ONLY_ROW])

    summary = tl.import_csv(csv_path, root)
    assert summary["trusted"] == 1

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    rows = list(csv.DictReader(open(flat_path, encoding="utf-8")))
    assert len(rows) == 1
    bc = rows[0]["barcode"]
    assert len(bc) == 12, f"Expected 12-digit barcode, got {bc!r}"
    assert v.gtin_check_digit_valid(bc)


def test_import_csv_junk_row_skipped(tmp_path):
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, [JUNK_ROW])

    summary = tl.import_csv(csv_path, root)

    assert summary["total_rows"] == 1
    assert summary["parsed"] == 0  # no parseable identity
    assert summary["trusted"] == 0

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    rows = list(csv.DictReader(open(flat_path, encoding="utf-8")))
    assert len(rows) == 0, "No rows should be written for junk input"


def test_import_csv_dedup_on_second_import(tmp_path):
    """Re-importing the same CSV should not add duplicate rows."""
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, ALL_ROWS)

    summary1 = tl.import_csv(csv_path, root)
    trusted_first = summary1["trusted"]
    assert trusted_first == 4

    summary2 = tl.import_csv(csv_path, root)
    assert summary2["trusted"] == 0, "Second import should add 0 new rows"
    assert summary2["dup_skipped"] == trusted_first, (
        f"Expected {trusted_first} dup_skipped, got {summary2['dup_skipped']}"
    )

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    rows = list(csv.DictReader(open(flat_path, encoding="utf-8")))
    assert len(rows) == trusted_first, "Corpus should still have exactly the original rows"


def test_import_csv_audit_passes(tmp_path):
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, ALL_ROWS)

    summary = tl.import_csv(csv_path, root)

    assert summary.get("audit_ok"), (
        f"Audit failed with errors: {summary.get('_audit_errors', [])}"
    )


def test_import_csv_ledger_matches_corpus(tmp_path):
    """After import, ledger count must match CSV row count."""
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, ALL_ROWS)

    tl.import_csv(csv_path, root)

    ledger_path = os.path.join(root, "coverage_ledger.json")
    led = L.load_ledger(ledger_path)
    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    ok, msg = L.counts_match_csv(led, flat_path)
    assert ok, f"Ledger count mismatch: {msg}"


def test_import_csv_no_corpus_modification_of_live_data(tmp_path):
    """
    Verify tests use tmp_path and do NOT modify live corpus.
    The live corpus root is the parent of scripts/; tmp_path is different.
    """
    scripts_dir = os.path.dirname(os.path.dirname(__file__))
    live_root = os.path.dirname(scripts_dir)
    tmp_root = str(tmp_path)
    assert os.path.abspath(tmp_root) != os.path.abspath(live_root), (
        "tmp_path must not be the live corpus root"
    )


def test_import_csv_row_has_correct_schema(tmp_path):
    """Every written flat row must have all FLAT_COLS columns."""
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, [VALID_ROW_1])

    tl.import_csv(csv_path, root)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames
        rows = list(reader)

    assert header == v.FLAT_COLS, f"Header mismatch: {header}"
    assert len(rows) == 1
    for col in v.FLAT_COLS:
        assert col in rows[0], f"Missing column {col!r} in flat row"


def test_import_csv_gtin_check_digit_valid_for_all_trusted(tmp_path):
    """All trusted rows in the corpus must have valid GTIN check digits."""
    root = _make_corpus(tmp_path)
    csv_path = _write_csv(tmp_path, ALL_ROWS)

    tl.import_csv(csv_path, root)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    rows = list(csv.DictReader(open(flat_path, encoding="utf-8")))
    for r in rows:
        assert v.gtin_check_digit_valid(r["barcode"]), (
            f"Barcode {r['barcode']!r} fails GTIN check"
        )


def test_detect_columns_aliases_manufacturer():
    """'manufacturer' alias should map to brand."""
    header = ["manufacturer", "model", "size", "gtin12"]
    colmap = tl.detect_columns(header)
    assert colmap["brand"] == "manufacturer"


def test_detect_columns_aliases_pattern():
    """'pattern' alias should map to model."""
    header = ["brand", "pattern", "tire_size", "upc"]
    colmap = tl.detect_columns(header)
    assert colmap["model"] == "pattern"
    assert colmap["size"] == "tire_size"


def test_import_csv_row_without_mpn_is_trusted(tmp_path):
    """
    verified_vendor rows with valid GTIN + brand + model + size now route as TRUSTED
    even without an MPN (same no-MPN path as verified_db).
    This test was updated when the routing change was made to allow verified_vendor
    to use the barcode-anchored trusted path.
    """
    root = _make_corpus(tmp_path)
    no_mpn_row = {**VALID_ROW_1, "MPC": ""}
    csv_path = _write_csv(tmp_path, [no_mpn_row])

    summary = tl.import_csv(csv_path, root)

    # verified_vendor + valid GTIN + brand + model + size -> trusted (no MPN required)
    assert summary["trusted"] == 1
    assert summary["backlog"] == 0
    assert summary["rejected"] == 0
