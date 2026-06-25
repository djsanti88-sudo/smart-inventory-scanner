#!/usr/bin/env python3
"""
qa_corpus_full.py — All-angles quality gate for tire_corpus_flat.csv.

Catches the brand/model-corruption class (stringified API dicts) plus GTIN
validity, duplicate barcodes/UIDs, size sanity, schema drift, evidence-level
and source-url format, and ledger/CSV count agreement.

Usage:
    uv run python scripts/qa_corpus_full.py
Exit code 0 = PASS, 1 = FAIL. Designed to be run repeatedly during a harvest.
"""
import csv
import os
import re
import sys

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import ledger as L

# Markers that should NEVER appear in a brand/model cell — these are the
# fingerprints of a stringified API object (the bug we just fixed).
_CORRUPT_MARKERS = ("{", "}", "http", "image_url", "dot_reg", "':", "://")

_EVIDENCE_OK = {"verified_1src_strong", "verified_db", "verified_vendor", "verified_ai"}
# Standard (incl. LT/P/ST prefix + decimal width/aspect) and floatation (NNxNN.NNRNN)
_SIZE_RE = re.compile(
    r"^[A-Z]{0,3}\d{2,3}(\.\d+)?[/X]\d{1,3}(\.\d+)?R\d{1,2}(\.\d+)?[A-Z]*$",
    re.I,
)
_VENDOR_SRC_RE = re.compile(r"^tirelibrary:\d+$")


def _add(problems, key, sample):
    problems.setdefault(key, {"count": 0, "samples": []})
    problems[key]["count"] += 1
    if len(problems[key]["samples"]) < 3:
        problems[key]["samples"].append(sample)


def check_corpus(root):
    """Return (ok: bool, problems: dict, stats: dict)."""
    flat = os.path.join(root, "tire_corpus_flat.csv")
    problems = {}
    barcodes, uids = {}, {}
    n = 0
    ev_counts = {}

    with open(flat, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        cols = r.fieldnames or []
        if cols != list(v.FLAT_COLS):
            _add(problems, "schema_mismatch", f"cols={cols}")
        for row in r:
            n += 1
            brand = (row.get("brand") or "")
            model = (row.get("model") or "")
            size = (row.get("size_canonical") or "")
            bc = (row.get("barcode") or "")
            uid = (row.get("canonical_product_uid") or "")
            ev = (row.get("evidence_level") or "")
            src = (row.get("source_url") or "")
            ev_counts[ev] = ev_counts.get(ev, 0) + 1

            # 1. required non-empty
            if not brand: _add(problems, "empty_brand", uid)
            if not model: _add(problems, "empty_model", uid)
            if not size:  _add(problems, "empty_size", uid)
            if not bc:    _add(problems, "empty_barcode", uid)

            # 2. brand/model corruption (the bug) + lowercase convention
            bl = brand.lower()
            if any(m in bl for m in _CORRUPT_MARKERS) or len(brand) > 40:
                _add(problems, "corrupt_brand", f"{uid}: {brand[:60]!r}")
            elif brand and brand != bl:
                _add(problems, "brand_not_normalized", f"{uid}: {brand!r}")
            ml = model.lower()
            if any(m in ml for m in _CORRUPT_MARKERS) or len(model) > 80:
                _add(problems, "corrupt_model", f"{uid}: {model[:70]!r}")

            # 3. barcode validity
            if bc:
                if not bc.isdigit() or len(bc) not in (12, 13, 14):
                    _add(problems, "bad_barcode_format", f"{uid}: {bc!r}")
                elif not v.gtin_check_digit_valid(bc):
                    _add(problems, "bad_gtin_check_digit", f"{uid}: {bc}")

            # 4. dup barcode / dup uid
            if bc:
                if bc in barcodes:
                    _add(problems, "dup_barcode", f"{bc} ({barcodes[bc]} & {uid})")
                else:
                    barcodes[bc] = uid
            if uid:
                if uid in uids:
                    _add(problems, "dup_uid", uid)
                else:
                    uids[uid] = True

            # 5. size sanity
            if size and not _SIZE_RE.match(size):
                _add(problems, "bad_size_format", f"{uid}: {size!r}")

            # 6. evidence level
            if ev not in _EVIDENCE_OK:
                _add(problems, "bad_evidence_level", f"{uid}: {ev!r}")

            # 7. vendor source-url format + no-MPN expectation
            if ev == "verified_vendor":
                if not _VENDOR_SRC_RE.match(src):
                    _add(problems, "bad_vendor_source_url", f"{uid}: {src!r}")

    # 8. ledger / csv agreement
    try:
        led = L.load_ledger(os.path.join(root, "coverage_ledger.json"))
        ok_counts, msg = L.counts_match_csv(led, flat)
        if not ok_counts:
            _add(problems, "ledger_csv_mismatch", msg)
    except Exception as e:
        _add(problems, "ledger_check_error", str(e)[:80])

    stats = {"rows": n, "distinct_barcodes": len(barcodes), "evidence": ev_counts}
    return (len(problems) == 0, problems, stats)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ok, problems, stats = check_corpus(_ROOT)
    print(f"QA rows={stats['rows']} barcodes={stats['distinct_barcodes']} evidence={stats['evidence']}")
    if ok:
        print("QA RESULT: PASS")
        sys.exit(0)
    print("QA RESULT: FAIL")
    for key, info in problems.items():
        print(f"  [{key}] x{info['count']}  e.g. {info['samples']}")
    sys.exit(1)


if __name__ == "__main__":
    main()
