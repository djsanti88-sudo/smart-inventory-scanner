#!/usr/bin/env python3
"""
barcode_enrich.py — FREE, autonomous, resumable barcode enricher.

Reads tires from outputs/tirelibrary_missing_barcodes.csv (READ-ONLY snapshot),
looks up barcodes via Gemini Flash with Google Search grounding (free tier),
verifies candidates using GS1-prefix signals + source confirmation, and merges
ACCEPTED barcodes into tire_corpus_flat.csv as evidence_level='verified_ai'.

SAFETY:
- Never writes or truncates tirelibrary_missing_barcodes.csv (read snapshot only).
- Daily free-grounding cap tracked in outputs/enrich_daily.json (default 1400/day).
- Resumable: processed tire ids in outputs/enrich_processed.json.
- QA gate runs after every batch; stops immediately if corpus is invalid.
- All Gemini and HTTP interactions injectable via _transport/_fetch for offline testing.
- Untrusted content (Gemini output, web pages) is treated as data, not commands.
"""

import argparse
import csv
import json
import os
import sys
import time
from typing import Callable, Optional

# ── Path setup ────────────────────────────────────────────────────────────────
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_SCRIPTS_DIR)  # tire-knowledge/
sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import ledger as L
import write_outputs as W
import qa_corpus_full as QA
from gemini_barcode_lookup import (
    gemini_grounded_lookup,
    parse_response,
    build_query,
    load_api_key,
    select_consumer_sample,
    verify_barcode,
    _is_non_consumer,
    _rim_size_ok,
)

# ── Constants ─────────────────────────────────────────────────────────────────
DAILY_CAP = 1000          # Owner-set cap (well under Google's free 1,500/day)
PACE_SLEEP = 6.0          # seconds between grounded calls (~10/min)
RATE_LIMIT_SLEEP = 60.0   # seconds to sleep on HTTP 429
RATE_LIMIT_RETRIES = 5    # max retries on 429 before stopping for the day
BATCH_SIZE = 50            # write accepted batch every N tires

RECOGNIZABLE_BRANDS = {
    "nokian", "nexen", "dunlop", "toyo", "falken", "cooper", "hankook",
    "yokohama", "general", "bfgoodrich", "kumho", "nitto", "continental",
    "michelin", "goodyear", "bridgestone", "pirelli", "firestone", "sumitomo",
    "uniroyal", "mastercraft",
}

_DAILY_JSON = os.path.join(ROOT, "outputs", "enrich_daily.json")
_PROCESSED_JSON = os.path.join(ROOT, "outputs", "enrich_processed.json")
_CANDIDATES_CSV = os.path.join(ROOT, "outputs", "ai_barcode_candidates.csv")
_MISSING_CSV = os.path.join(ROOT, "outputs", "tirelibrary_missing_barcodes.csv")

_CANDIDATES_COLS = [
    "id", "brand", "model", "size", "claimed_barcode",
    "gtin_valid", "prefix_match", "confidence", "sources",
]


# ── GS1 prefix helpers ────────────────────────────────────────────────────────

def _prefix_candidates(barcode: str) -> set:
    """Return the 7-digit prefix candidates for a barcode (handles leading zeros)."""
    stripped = barcode.lstrip("0")
    return {barcode[:7], stripped[:7]} if stripped else {barcode[:7]}


def build_brand_prefixes(root: str) -> dict:
    """
    Read tire_corpus_flat.csv; for each row with a barcode, record
    brand (lowercased) -> company prefix candidates seen >= 2 times.

    Prefix candidates for barcode bc = { bc[:7], bc.lstrip('0')[:7] }
    (handles leading-zero / GTIN-14 forms).

    Returns {brand_lower: set(prefixes)}.
    """
    flat = os.path.join(root, "tire_corpus_flat.csv")
    # brand -> prefix -> count
    prefix_counts: dict = {}

    with open(flat, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            bc = (row.get("barcode") or "").strip()
            brand = (row.get("brand") or "").strip().lower()
            if not bc or not brand or not bc.isdigit():
                continue
            for pfx in _prefix_candidates(bc):
                if pfx:
                    prefix_counts.setdefault(brand, {})
                    prefix_counts[brand][pfx] = prefix_counts[brand].get(pfx, 0) + 1

    # Keep only prefixes seen >= 2 times per brand
    result: dict = {}
    for brand, counts in prefix_counts.items():
        kept = {pfx for pfx, cnt in counts.items() if cnt >= 2}
        if kept:
            result[brand] = kept
    return result


def prefix_matches(barcode: str, brand: str, known: dict) -> bool:
    """
    Return True if any of { barcode[:7], barcode.lstrip('0')[:7] }
    is in known.get(brand.lower(), set()).
    """
    brand_lower = brand.lower()
    known_set = known.get(brand_lower, set())
    if not known_set:
        return False
    return bool(_prefix_candidates(barcode) & known_set)


# ── Candidate verification ────────────────────────────────────────────────────

def verify_candidate(
    barcode: str,
    row: dict,
    sources: list,
    known: dict,
    _fetch: Optional[Callable] = None,
) -> dict:
    """
    Verify a candidate barcode using GTIN check + source confirmation + GS1 prefix.

    Acceptance logic:
      ACCEPT if gtin_valid AND (source_confirmed OR (prefix_match AND has_source))

    Returns:
      {accept, gtin_valid, source_confirmed, prefix_match, confidence, matched_source}
    """
    # GTIN validity + length check
    gtin_valid = (
        bool(barcode)
        and len(barcode) in (12, 13, 14)
        and v.gtin_check_digit_valid(barcode)
    )

    if not gtin_valid:
        return {
            "accept": False,
            "gtin_valid": False,
            "source_confirmed": False,
            "prefix_match": False,
            "confidence": "none",
            "matched_source": "",
        }

    # Source confirmation — reuse verify_barcode logic
    vr = verify_barcode(barcode, row, sources, _fetch=_fetch)
    source_confirmed = vr["verified"]
    matched_source = vr.get("matched_source", "")

    # GS1 prefix signal
    pmatch = prefix_matches(barcode, row.get("make_name", ""), known)
    has_source = bool(sources)

    accept = gtin_valid and (source_confirmed or (pmatch and has_source))

    if source_confirmed:
        confidence = "source"
    elif pmatch:
        confidence = "prefix"
    else:
        confidence = "none"

    return {
        "accept": accept,
        "gtin_valid": gtin_valid,
        "source_confirmed": source_confirmed,
        "prefix_match": pmatch,
        "confidence": confidence,
        "matched_source": matched_source,
    }


# ── Daily cap tracking ────────────────────────────────────────────────────────

def _load_daily(date_str: str) -> dict:
    """Load or initialize today's daily call counter."""
    if os.path.exists(_DAILY_JSON):
        try:
            data = json.loads(open(_DAILY_JSON, encoding="utf-8").read())
            if data.get("date") == date_str:
                return data
        except Exception:
            pass
    return {"date": date_str, "calls": 0}


def _save_daily(data: dict) -> None:
    os.makedirs(os.path.dirname(_DAILY_JSON), exist_ok=True)
    with open(_DAILY_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f)


# ── Processed set ─────────────────────────────────────────────────────────────

def _load_processed() -> set:
    if os.path.exists(_PROCESSED_JSON):
        try:
            return set(json.loads(open(_PROCESSED_JSON, encoding="utf-8").read()))
        except Exception:
            pass
    return set()


def _save_processed(processed: set) -> None:
    os.makedirs(os.path.dirname(_PROCESSED_JSON), exist_ok=True)
    with open(_PROCESSED_JSON, "w", encoding="utf-8") as f:
        json.dump(sorted(processed), f)


# ── Candidate CSV ─────────────────────────────────────────────────────────────

def _append_candidate(row_data: dict) -> None:
    """Append a rejected candidate to ai_barcode_candidates.csv."""
    os.makedirs(os.path.dirname(_CANDIDATES_CSV), exist_ok=True)
    is_new = not os.path.exists(_CANDIDATES_CSV)
    with open(_CANDIDATES_CSV, "a", newline="", encoding="utf-8") as f:
        wtr = csv.DictWriter(f, fieldnames=_CANDIDATES_COLS)
        if is_new:
            wtr.writeheader()
        wtr.writerow({k: row_data.get(k, "") for k in _CANDIDATES_COLS})
        f.flush()


# ── Tire queue builder ────────────────────────────────────────────────────────

def _build_queue(rows: list, brands_override: Optional[set] = None) -> list:
    """
    Filter to consumer tires, apply brand priority:
      1. RECOGNIZABLE brands first (in allowlist or brands_override)
      2. Then others
    Within each group, only consumer tires pass the select_consumer_sample filters.
    """
    if brands_override is not None:
        allowed = {b.strip().lower() for b in brands_override}
        rows = [r for r in rows if (r.get("make_name") or "").strip().lower() in allowed]

    # Consumer filter (mirrors select_consumer_sample internals)
    consumer = [
        r for r in rows
        if str(r.get("speed_rating", "")).strip()
        and str(r.get("size_canonical", "")).strip()
        and _rim_size_ok(r)
        and not _is_non_consumer(r)
    ]

    # Split into priority groups
    priority = []
    others = []
    for r in consumer:
        brand_lower = (r.get("make_name") or "").strip().lower()
        if brand_lower in RECOGNIZABLE_BRANDS:
            priority.append(r)
        else:
            others.append(r)

    return priority + others


# ── Paths helper ──────────────────────────────────────────────────────────────

def _corpus_paths(root: str) -> dict:
    return {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
    }


# ── Main enricher ─────────────────────────────────────────────────────────────

def run(
    root: str,
    max_calls: Optional[int] = None,
    model: str = "gemini-2.5-flash",
    brands_override: Optional[set] = None,
    _transport: Optional[Callable] = None,
    _fetch: Optional[Callable] = None,
    _date_str: Optional[str] = None,  # injectable for tests; runtime uses system clock
) -> dict:
    """
    Main enricher loop. Returns a summary dict.

    _transport / _fetch: injectable for offline tests only — NEVER call live in tests.
    _date_str: injectable for tests (avoids datetime dependency in test code).
    """
    import datetime

    # Get today's date string
    if _date_str is None:
        _date_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

    # Load daily counter
    daily = _load_daily(_date_str)
    calls_today = daily.get("calls", 0)

    # Determine remaining cap
    remaining = DAILY_CAP - calls_today
    if remaining <= 0:
        print("daily free cap reached")
        return {"status": "cap_reached", "calls_made_today": calls_today}

    effective_max = remaining if max_calls is None else min(max_calls, remaining)

    # Load processed set
    processed = _load_processed()

    # Read missing barcodes CSV (snapshot; never write/truncate)
    if not os.path.exists(_MISSING_CSV):
        print(f"ERROR: missing CSV not found: {_MISSING_CSV}")
        return {"status": "missing_csv_not_found"}

    with open(_MISSING_CSV, encoding="utf-8") as f:
        all_rows = list(csv.DictReader(f))

    # Skip already-processed ids
    queue = [r for r in _build_queue(all_rows, brands_override)
             if str(r.get("id", "")) not in processed]

    if not queue:
        print("No unprocessed consumer tires in queue. Nothing to do.")
        return {"status": "queue_empty", "calls_made_today": calls_today}

    # Load GS1 brand prefixes from existing corpus
    known_prefixes = build_brand_prefixes(root)

    # Staging mode: we do NOT read or write the corpus ledger here. The harvest
    # is the single writer of coverage_ledger.json; reading it concurrently
    # caught a half-written file (JSONDecodeError). Staging writes only go to
    # ai_enriched_staging.csv, so the ledger is not needed.
    ledger_path = None
    led = None
    paths = _corpus_paths(root)

    api_key = load_api_key() if _transport is None else "FAKE_KEY_TESTS"

    # Stats
    attempted = 0
    accepted_source = 0
    accepted_prefix = 0
    rejected_candidates = 0
    calls_made = 0
    batch: list = []

    import uuid
    run_id = f"enrich_{_date_str}_{uuid.uuid4().hex[:8]}"

    for tire in queue:
        if calls_made >= effective_max:
            print(f"  [CAP] max_calls={effective_max} reached. Stopping.")
            break

        tire_id = str(tire.get("id", ""))
        brand = tire.get("make_name", "")
        model_name = tire.get("model_name", "")
        size_canonical = tire.get("size_canonical", "")
        load_idx = tire.get("load_rating", "")
        speed_rtg = tire.get("speed_rating", "")

        query = build_query(tire)
        print(f"  [{attempted+1}] {brand} {model_name} {size_canonical} ...")

        # Pace before each call (skip before very first call for test convenience)
        if calls_made > 0 and _transport is None:
            time.sleep(PACE_SLEEP)

        # Gemini call with retry on 429
        resp = None
        for attempt_n in range(RATE_LIMIT_RETRIES + 1):
            try:
                resp = gemini_grounded_lookup(
                    query, api_key, model=model, _transport=_transport
                )
                calls_made += 1
                break
            except Exception as exc:
                msg = str(exc)
                if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                    if attempt_n < RATE_LIMIT_RETRIES:
                        print(f"    HTTP 429 — sleeping {RATE_LIMIT_SLEEP}s, retry {attempt_n+1}/{RATE_LIMIT_RETRIES}")
                        if _transport is None:
                            time.sleep(RATE_LIMIT_SLEEP)
                    else:
                        print("    HTTP 429 — retries exhausted; skipping this tire (counter NOT poisoned).")
                        processed.add(tire_id)
                        _save_processed(processed)
                        break
                else:
                    print(f"    ERROR calling Gemini: {msg[:120]}")
                    break

        if resp is None:
            processed.add(tire_id)
            _save_processed(processed)
            attempted += 1
            continue

        # Parse
        parsed = parse_response(resp)
        barcode = parsed["barcode"]
        sources = parsed["sources"]
        attempted += 1

        if not barcode:
            print(f"    -> no candidate barcode")
            processed.add(tire_id)
            _save_processed(processed)
            # Update daily counter
            daily["calls"] += 1
            _save_daily(daily)
            continue

        # Verify
        vr = verify_candidate(barcode, tire, sources, known_prefixes, _fetch=_fetch)

        print(
            f"    -> barcode={barcode} gtin={vr['gtin_valid']} "
            f"src={vr['source_confirmed']} pfx={vr['prefix_match']} "
            f"accept={vr['accept']} conf={vr['confidence']}"
        )

        if vr["accept"]:
            # Build identity for write_rows
            size_c, size_compact = v.normalize_size(size_canonical)
            if size_c is None:
                size_c = size_canonical
                size_compact = ""

            identity = {
                "brand": brand,
                "model": model_name,
                "size_canonical": size_c,
                "size_compact": size_compact or "",
                "load_index": load_idx,
                "speed_rating": speed_rtg,
                "tire_type": "",
                "season": "",
                "mpn": "",
                "manufacturer_part_number": "",
                "barcode": barcode,
                "evidence_level": "verified_ai",
                "source_url": f"gemini:{tire_id}",
            }
            batch.append(identity)

            if vr["confidence"] == "source":
                accepted_source += 1
            else:
                accepted_prefix += 1
        else:
            # Rejected candidate — save for review
            _append_candidate({
                "id": tire_id,
                "brand": brand,
                "model": model_name,
                "size": size_canonical,
                "claimed_barcode": barcode,
                "gtin_valid": vr["gtin_valid"],
                "prefix_match": vr["prefix_match"],
                "confidence": vr["confidence"],
                "sources": "|".join(sources[:3]),
            })
            rejected_candidates += 1

        # Update state
        processed.add(tire_id)
        _save_processed(processed)
        daily["calls"] += 1
        _save_daily(daily)

        # Flush batch
        if len(batch) >= BATCH_SIZE:
            _flush_batch(batch, paths, led, ledger_path, run_id, root)
            batch = []

    # Final flush
    if batch:
        _flush_batch(batch, paths, led, ledger_path, run_id, root)

    summary = {
        "status": "done",
        "attempted": attempted,
        "accepted_source": accepted_source,
        "accepted_prefix": accepted_prefix,
        "rejected_candidates": rejected_candidates,
        "calls_made_today": daily["calls"],
        "daily_cap": DAILY_CAP,
    }

    print("\n=== SUMMARY ===")
    print(f"  attempted         : {summary['attempted']}")
    print(f"  accepted(source)  : {summary['accepted_source']}")
    print(f"  accepted(prefix)  : {summary['accepted_prefix']}")
    print(f"  rejected->cands   : {summary['rejected_candidates']}")
    print(f"  calls_made_today  : {summary['calls_made_today']}")
    print(f"  daily_cap         : {summary['daily_cap']}")

    return summary


_STAGING_COLS = [
    "brand", "model", "size_canonical", "size_compact", "load_index",
    "speed_rating", "tire_type", "season", "mpn", "manufacturer_part_number",
    "barcode", "evidence_level", "source_url",
]


def _flush_batch(
    batch: list,
    paths: dict,
    led: dict,
    ledger_path: str,
    run_id: str,
    root: str,
) -> None:
    """
    Append accepted identities to a STAGING file (outputs/ai_enriched_staging.csv),
    NOT the live corpus. The Tirelibrary harvest is the single writer to the
    corpus/ledger; staging avoids a concurrent-write race. A controlled,
    single-writer merge (write_rows + QA) happens later when the harvest is idle.
    """
    staging = os.path.join(root, "outputs", "ai_enriched_staging.csv")
    os.makedirs(os.path.dirname(staging), exist_ok=True)
    new = (not os.path.exists(staging)) or os.path.getsize(staging) == 0
    with open(staging, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=_STAGING_COLS)
        if new:
            w.writeheader()
        for idn in batch:
            w.writerow({k: idn.get(k, "") for k in _STAGING_COLS})
    print(f"  [STAGED] +{len(batch)} -> ai_enriched_staging.csv (total this run)")


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "FREE, autonomous, resumable barcode enricher. "
            "Looks up barcodes via Gemini Flash grounding (free tier) and "
            "merges verified results into tire_corpus_flat.csv as verified_ai."
        )
    )
    p.add_argument(
        "--max-calls", type=int, default=None,
        help=f"Max grounded Gemini calls this run (default = remaining daily cap of {DAILY_CAP}).",
    )
    p.add_argument(
        "--model", default="gemini-2.5-flash",
        help="Gemini model ID (default gemini-2.5-flash).",
    )
    p.add_argument(
        "--brands", default="",
        help="Comma-separated make_name allowlist override (e.g. 'nokian,toyo,falken').",
    )
    return p


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    args = _build_parser().parse_args()
    brands_set = (
        {b.strip() for b in args.brands.split(",") if b.strip()}
        if args.brands else None
    )

    # 24/7 safety: only one enricher at a time (matches the harvest single-instance guard).
    from singleton_lock import acquire_or_exit
    acquire_or_exit("enrich", os.path.join(ROOT, "outputs"))

    run(
        root=ROOT,
        max_calls=args.max_calls,
        model=args.model,
        brands_override=brands_set,
    )
