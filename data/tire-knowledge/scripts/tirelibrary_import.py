#!/usr/bin/env python3
"""
tirelibrary_import.py — Flexible CSV importer for Tirelibrary-style tire data.

Reads a Tirelibrary (or similar vendor) CSV with flexible column headers,
normalizes each row into a tire identity, and writes trusted rows to the
local tire corpus using the same write_rows / ledger pipeline as other harvesters.

No network calls. Pure local file processing.
"""

import argparse
import csv
import os
import sys
import uuid

# Make scripts/ importable when run as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
from upcitemdb_parse import parse_name
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit

# ── Column alias map ─────────────────────────────────────────────────────────
# Maps logical field -> list of CSV header aliases (all compared case-insensitive)

_COL_ALIASES = {
    "barcode":      ["upc", "upc_a", "upca", "barcode", "gtin", "gtin12"],
    "ean":          ["ean", "ean13", "gtin13"],
    "mpn":          ["mpc", "mpn", "manufacturer_product_code", "part_number",
                     "partnumber", "mfr_part", "sku"],
    "brand":        ["brand", "make", "manufacturer", "brand_name"],
    "model":        ["model", "model_name", "pattern", "tire_model", "description", "name"],
    "size":         ["size", "tire_size", "size_canonical", "sizedesc"],
    "load_index":   ["load", "load_index", "loadindex", "li"],
    "speed_rating": ["speed", "speed_rating", "speedrating", "sr", "speed_index"],
    "tire_type":    ["type", "category", "tire_type"],
    "season":       ["season"],
}

_REQUIRED_FIELDS = {"brand", "model", "size"}
_REQUIRED_BARCODE = {"barcode", "ean"}  # at least one of these


def detect_columns(header: list) -> dict:
    """
    Map logical field names to actual CSV column names via case-insensitive alias matching.

    Args:
        header: list of column names from the CSV file.

    Returns:
        dict mapping logical field -> actual CSV column name (only matched fields included).

    Raises:
        ValueError: if required fields are missing.
    """
    lower_to_actual = {col.lower().strip(): col for col in header}
    colmap = {}
    for logical, aliases in _COL_ALIASES.items():
        for alias in aliases:
            if alias.lower() in lower_to_actual:
                colmap[logical] = lower_to_actual[alias.lower()]
                break  # first match wins

    # Validate: need at least (barcode OR ean) + brand + model + size
    has_barcode = "barcode" in colmap or "ean" in colmap
    missing = []
    if not has_barcode:
        missing.append("barcode or ean")
    for fld in ("brand", "model", "size"):
        if fld not in colmap:
            missing.append(fld)

    if missing:
        raise ValueError(
            f"CSV is missing required columns: {missing}. "
            f"Headers seen: {header}"
        )

    return colmap


def _derive_barcode_from_ean(ean_raw: str) -> str:
    """
    Derive a 12-digit UPC from an EAN-13 by stripping a leading '0'.
    Returns the 12-digit string if valid GTIN, else the original (or empty).
    """
    ean = ean_raw.strip()
    if not ean:
        return ""
    # EAN-13 with leading 0 -> UPC-12
    if len(ean) == 13 and ean.startswith("0"):
        candidate = ean[1:]  # strip leading zero
        if v.gtin_check_digit_valid(candidate):
            return candidate
    # If EAN-13 is itself valid, keep as 13-digit
    if len(ean) == 13 and v.gtin_check_digit_valid(ean):
        return ean
    # Try as-is
    if v.gtin_check_digit_valid(ean):
        return ean
    return ""


def row_to_identity(row: dict, colmap: dict) -> dict | None:
    """
    Convert a raw CSV row dict into a tire identity dict, or return None to skip.

    Steps:
    1. Extract barcode from UPC column; fall back to EAN derivation if absent.
    2. Extract brand, model, size from mapped columns.
    3. If no discrete size column, fall back to parse_name on model/description.
    4. Extract optional fields: load_index, speed_rating, tire_type, season, mpn.
    5. Skip if no valid size or no barcode.
    6. Set evidence_level='verified_vendor', source_url='tirelibrary'.

    Returns:
        Identity dict or None.
    """
    # 1. Barcode
    barcode = ""
    if "barcode" in colmap:
        raw_bc = str(row.get(colmap["barcode"], "")).strip()
        if v.gtin_check_digit_valid(raw_bc):
            barcode = raw_bc

    if not barcode and "ean" in colmap:
        raw_ean = str(row.get(colmap["ean"], "")).strip()
        barcode = _derive_barcode_from_ean(raw_ean)

    if not barcode:
        return None  # no valid barcode

    # 2. Brand and model
    brand = str(row.get(colmap.get("brand", ""), "")).strip() if "brand" in colmap else ""
    model = str(row.get(colmap.get("model", ""), "")).strip() if "model" in colmap else ""

    if not brand or not model:
        return None

    # 3. Size — discrete column first, then parse_name fallback
    size_canonical = ""
    size_compact = ""

    if "size" in colmap:
        raw_size = str(row.get(colmap["size"], "")).strip()
        if raw_size:
            size_canonical, size_compact = v.normalize_size(raw_size)

    if not size_canonical:
        # Fallback: try to parse size from model/description text
        parsed = parse_name(f"{brand} {model}")
        if parsed and parsed.get("size_canonical"):
            size_canonical = parsed["size_canonical"]
            size_compact = parsed["size_compact"]

    if not size_canonical or not size_compact:
        return None  # no valid size — skip

    # 4. Optional enrichment fields
    load_index = ""
    if "load_index" in colmap:
        load_index = str(row.get(colmap["load_index"], "")).strip()

    speed_rating = ""
    if "speed_rating" in colmap:
        speed_rating = str(row.get(colmap["speed_rating"], "")).strip()

    tire_type = ""
    if "tire_type" in colmap:
        tire_type = str(row.get(colmap["tire_type"], "")).strip()

    season = ""
    if "season" in colmap:
        season = str(row.get(colmap["season"], "")).strip()

    mpn = ""
    if "mpn" in colmap:
        mpn = str(row.get(colmap["mpn"], "")).strip()

    return {
        "brand":          brand,
        "model":          model,
        "mpn":            mpn,
        "manufacturer_part_number": mpn,
        "barcode":        barcode,
        "size_canonical": size_canonical,
        "size_compact":   size_compact,
        "load_index":     load_index,
        "speed_rating":   speed_rating,
        "tire_type":      tire_type,
        "season":         season,
        "evidence_level": "verified_vendor",
        "source_url":     "tirelibrary",
    }


def import_csv(csv_path: str, root: str) -> dict:
    """
    Stream a Tirelibrary-style CSV, build tire identities, write via write_rows.

    Args:
        csv_path: path to the input CSV file.
        root: tire-knowledge corpus root directory.

    Returns:
        Summary dict with keys: total_rows, parsed, trusted, dup_skipped, backlog, rejected.
    """
    ledger_path = os.path.join(root, "coverage_ledger.json")
    paths = {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }

    run_id = f"tirelibrary_{uuid.uuid4().hex[:8]}"
    led = L.load_ledger(ledger_path)

    # Ensure flat CSV has header if it doesn't exist yet
    flat_path = paths["flat"]
    if not os.path.exists(flat_path):
        with open(flat_path, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(v.FLAT_COLS)

    totals = {"total_rows": 0, "parsed": 0, "trusted": 0,
              "dup_skipped": 0, "backlog": 0, "rejected": 0}

    BATCH_SIZE = 500  # write in batches for efficiency

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []

        colmap = detect_columns(list(header))

        batch = []
        for row in reader:
            totals["total_rows"] += 1

            identity = row_to_identity(row, colmap)
            if identity is None:
                pass  # rejected silently (no barcode or no size)
            else:
                totals["parsed"] += 1
                batch.append(identity)

            if len(batch) >= BATCH_SIZE:
                counts = write_rows(batch, paths, led, run_id)
                for k in ("trusted", "dup_skipped", "backlog", "rejected"):
                    totals[k] += counts[k]
                batch = []

            if totals["total_rows"] % 10000 == 0:
                print(
                    f"[tirelibrary_import] {totals['total_rows']} rows scanned, "
                    f"{totals['parsed']} parsed, {totals['trusted']} trusted so far ...",
                    flush=True,
                )

        # Write remaining batch
        if batch:
            counts = write_rows(batch, paths, led, run_id)
            for k in ("trusted", "dup_skipped", "backlog", "rejected"):
                totals[k] += counts[k]

    # Persist ledger
    L.save_ledger(led, ledger_path)

    # Run corpus audit
    ok, errs = audit(root)
    totals["audit_ok"] = ok
    totals["_audit_errors"] = errs

    return totals


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Import a Tirelibrary-style CSV into the tire corpus."
    )
    parser.add_argument("csv_path", help="Path to the Tirelibrary CSV file to import.")
    parser.add_argument(
        "--root",
        default=_ROOT,
        help="Tire-knowledge corpus root directory (default: parent of scripts/).",
    )
    args = parser.parse_args()

    if not os.path.exists(args.csv_path):
        print(f"ERROR: CSV file not found: {args.csv_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[tirelibrary_import] csv_path={args.csv_path}", flush=True)
    print(f"[tirelibrary_import] root={args.root}", flush=True)

    result = import_csv(args.csv_path, args.root)

    print()
    print("=== TIRELIBRARY IMPORT SUMMARY ===")
    summary_keys = ["total_rows", "parsed", "trusted", "dup_skipped", "backlog", "rejected", "audit_ok"]
    for k in summary_keys:
        print(f"  {k}: {result[k]}")

    print()
    if result.get("audit_ok"):
        print("AUDIT PASS")
    else:
        print("AUDIT FAIL")
        for e in result.get("_audit_errors", []):
            print(f"  - {e}")

    sys.exit(0 if result.get("audit_ok") else 1)


if __name__ == "__main__":
    main()
