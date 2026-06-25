#!/usr/bin/env python3
"""
tirelibrary_api_harvest.py — Resumable, rate-limited harvester for the Tirelibrary REST API.

Pulls tire barcodes from https://app.tireweblibrary.com/api/v1 and merges them
into the local tire corpus using the standard write_rows / ledger pipeline.

Usage:
    uv run python scripts/tirelibrary_api_harvest.py [OPTIONS]

Options:
    --only-priority     Stop after PRIORITY_BRANDS are processed.
    --max-details N     Cap total detail calls (useful for smoke tests).
    --brand NAME        Process only this one brand (case-insensitive match to facet).

Checkpoint: outputs/tirelibrary_progress.json
    Saved after every page. Kill/resume loses at most one page.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import uuid

import certifi
import requests

# ── Path bootstrap ────────────────────────────────────────────────────────────
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import ledger as L
from write_outputs import write_rows
from audit_corpus import audit

# ── Constants ─────────────────────────────────────────────────────────────────
BASE_URL = "https://app.tireweblibrary.com/api/v1"

PRIORITY_BRANDS = [
    "Blackhawk", "Falken", "Nokian", "Fortune",
    "Arisun", "Toyo", "Dunlop", "Nexen",
]

CHECKPOINT_PATH = os.path.join(_ROOT, "outputs", "tirelibrary_progress.json")

DETAIL_SLEEP = 0.30          # seconds between detail calls (~100/min; docs allow 200/min; 429 auto-backoff is the safety net)
RATE_LIMIT_SLEEP = 30.0      # seconds on HTTP 429
RETRY_5XX_SLEEP = 5.0        # seconds on 5xx
MAX_429_RETRIES = 5
MAX_5XX_RETRIES = 3
BATCH_SIZE = 200             # rows per write_rows call
AUDIT_INTERVAL = 2000        # run audit every N written rows

# Terrain -> tire_type mapping (substring match, order matters)
_TERRAIN_MAP = [
    ("All-Terrain", "all_terrain"),
    ("Mud",         "mud_terrain"),
    ("Highway",     "highway"),
    ("Touring",     "touring"),
]

# Season -> season mapping (exact / substring)
_SEASON_MAP = {
    "All-Season":   "all_season",
    "Winter":       "winter",
    "All-Weather":  "all_weather",
    "Summer":       "summer",
}

# ── API key loading ───────────────────────────────────────────────────────────

def _load_api_key() -> str:
    """
    Read TIRELIBRARY_API_KEY from <ROOT>/../../.env.local.
    Never prints the key.
    """
    env_path = os.path.join(_ROOT, "..", "..", ".env.local")
    env_path = os.path.normpath(env_path)
    if not os.path.exists(env_path):
        raise FileNotFoundError(f".env.local not found at: {env_path}")
    with open(env_path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)", text)
    if not m:
        raise ValueError("TIRELIBRARY_API_KEY not found in .env.local")
    key = m.group(1).strip().strip('"').strip("'")
    if not key:
        raise ValueError("TIRELIBRARY_API_KEY is empty in .env.local")
    return key


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _get(session: requests.Session, url: str, params: dict = None) -> dict:
    """
    GET with rate-limit handling.
    - HTTP 429: sleep RATE_LIMIT_SLEEP and retry (up to MAX_429_RETRIES).
    - Other 5xx: sleep RETRY_5XX_SLEEP and retry (up to MAX_5XX_RETRIES).
    """
    retries_429 = 0
    retries_5xx = 0
    while True:
        resp = session.get(url, params=params, verify=certifi.where(), timeout=30)
        if resp.status_code == 429:
            if retries_429 >= MAX_429_RETRIES:
                resp.raise_for_status()
            retries_429 += 1
            print(f"  [rate-limit] HTTP 429 — sleeping {RATE_LIMIT_SLEEP}s (attempt {retries_429})")
            time.sleep(RATE_LIMIT_SLEEP)
            continue
        if resp.status_code >= 500:
            if retries_5xx >= MAX_5XX_RETRIES:
                resp.raise_for_status()
            retries_5xx += 1
            print(f"  [5xx] HTTP {resp.status_code} — sleeping {RETRY_5XX_SLEEP}s (attempt {retries_5xx})")
            time.sleep(RETRY_5XX_SLEEP)
            continue
        resp.raise_for_status()
        return resp.json()


# ── Facet / brand discovery ───────────────────────────────────────────────────

def fetch_all_facet_brands(session: requests.Session) -> list:
    """
    Return ALL brand names from the /tire-makes endpoint (complete list, ~440).
    The catalog facets only expose the top 200 brands, which silently drops
    major brands (Nokian, Toyo, Nexen, Fortune, ...). /tire-makes is complete.
    Falls back to the catalog facet list if /tire-makes is unavailable.
    """
    try:
        data = _get(session, f"{BASE_URL}/tire-makes")
        if isinstance(data, dict):
            data = data.get("results", data.get("data", []))
        names, seen = [], set()
        for m in data:
            name = m.get("name") if isinstance(m, dict) else None
            if name and name not in seen:
                seen.add(name)
                names.append(name)
        if names:
            return names
    except Exception as e:
        print(f"[harvest] /tire-makes failed ({e}); falling back to catalog facets.")
    data = _get(session, f"{BASE_URL}/tires/catalog", params={"per_page": 1, "page": 1})
    return data.get("facets", {}).get("make_name", [])


def build_brand_queue(facet_brands: list) -> list:
    """
    Build ordered brand list: PRIORITY_BRANDS first (matched case-insensitively
    to facet spelling, using facet spelling), then remaining alphabetically.
    """
    lower_to_facet = {b.lower(): b for b in facet_brands}
    ordered = []
    used = set()

    for pb in PRIORITY_BRANDS:
        key = pb.lower()
        if key in lower_to_facet:
            facet_name = lower_to_facet[key]
            ordered.append(facet_name)
            used.add(facet_name)

    remaining = sorted(b for b in facet_brands if b not in used)
    ordered.extend(remaining)
    return ordered


# ── Checkpoint I/O ────────────────────────────────────────────────────────────

def _load_checkpoint() -> dict:
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH, encoding="utf-8") as f:
            return json.load(f)
    return None


def _save_checkpoint(cp: dict):
    os.makedirs(os.path.dirname(CHECKPOINT_PATH), exist_ok=True)
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump(cp, f, indent=2)


# ── Detail -> identity mapping ────────────────────────────────────────────────

def _map_tire_type(terrain: str, category: str) -> str:
    combined = f"{terrain or ''} {category or ''}".strip()
    for keyword, mapped in _TERRAIN_MAP:
        if keyword.lower() in combined.lower():
            return mapped
    return ""


def _map_season(season_raw: str) -> str:
    if not season_raw:
        return ""
    for key, val in _SEASON_MAP.items():
        if key.lower() in season_raw.lower():
            return val
    return ""


def _normalize_upc(raw: str) -> str:
    """
    Normalize UPC to 12 digits: left-pad '0' if 11 digits long.
    Returns empty string if not 11 or 12 digits.
    """
    raw = raw.strip()
    if not raw.isdigit():
        return ""
    if len(raw) == 12:
        return raw
    if len(raw) == 11:
        return "0" + raw
    return ""


def detail_to_identity(detail: dict, catalog_row: dict) -> dict | None:
    """
    Map a Tirelibrary detail API response to a tire identity dict, or None to skip.

    Returns None (counted as no_barcode) if neither UPC nor EAN is present.
    Returns None (counted as bad_size) if size cannot be normalized.
    """
    tire_id = detail.get("id", catalog_row.get("id", ""))

    # Barcode: prefer UPC, fall back to EAN
    barcode = ""
    upc_raw = str(detail.get("upc") or "").strip()
    ean_raw = str(detail.get("ean") or "").strip()

    if upc_raw and upc_raw != "None":
        normalized = _normalize_upc(upc_raw)
        if normalized and v.gtin_check_digit_valid(normalized):
            barcode = normalized

    if not barcode and ean_raw and ean_raw != "None":
        if len(ean_raw) == 13 and ean_raw.isdigit() and v.gtin_check_digit_valid(ean_raw):
            barcode = ean_raw

    if not barcode:
        return None  # no_barcode

    # Brand / model: the detail endpoint returns tire_make / tire_model as DICTS
    # ({"id":..,"name":..,..}), NOT plain strings, and has no make_name/model_name.
    # The catalog row carries the clean make_name/model_name string — prefer it,
    # then fall back to the dict's "name". NEVER stringify the whole dict.
    def _clean_name(cat_val, detail_val):
        if cat_val:
            return str(cat_val).strip()
        if isinstance(detail_val, dict):
            return str(detail_val.get("name") or "").strip()
        return str(detail_val or "").strip()

    brand = _clean_name(catalog_row.get("make_name"), detail.get("tire_make"))
    model = _clean_name(catalog_row.get("model_name"), detail.get("tire_model"))

    if not brand or not model:
        return None  # no_barcode (treat as skip)

    # Size
    width = str(detail.get("width") or catalog_row.get("width") or "").strip()
    aspect_ratio = str(detail.get("aspect_ratio") or catalog_row.get("aspect_ratio") or "").strip()
    rim_size = str(detail.get("rim_size") or catalog_row.get("rim_size") or "").strip()

    raw_size = f"{width}/{aspect_ratio}R{rim_size}"
    size_canonical, size_compact = v.normalize_size(raw_size)
    if not size_canonical or not size_compact:
        return None  # bad_size

    # Optional fields
    load_index = str(detail.get("load_rating") or "").strip()
    speed_rating = str(detail.get("speed_rating") or "").strip()
    tire_type = _map_tire_type(
        str(detail.get("terrain") or ""),
        str(detail.get("category") or ""),
    )
    season = _map_season(str(detail.get("season") or ""))

    return {
        "brand":          brand,
        "model":          model,
        "mpn":            "",
        "manufacturer_part_number": "",
        "barcode":        barcode,
        "size_canonical": size_canonical,
        "size_compact":   size_compact,
        "load_index":     load_index,
        "speed_rating":   speed_rating,
        "tire_type":      tire_type,
        "season":         season,
        "evidence_level": "verified_vendor",
        "source_url":     f"tirelibrary:{tire_id}",
    }


# ── Paths ─────────────────────────────────────────────────────────────────────

def _make_paths(root: str) -> dict:
    return {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }


def _ensure_flat_header(paths: dict):
    flat = paths["flat"]
    if not os.path.exists(flat):
        with open(flat, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(v.FLAT_COLS)


# ── Main harvest loop ─────────────────────────────────────────────────────────

# ── No-barcode capture (enrichment queue) ─────────────────────────────────────
# We already pay the detail-call cost for all 308k tires. Tires that have NO
# upc/ean go to a SEPARATE file so a later barcode-finder (Gemini, etc.) only
# processes these ~61%, not the whole database — saving tokens/credits.
# Barcoded tires still flow to the scanner corpus (tire_corpus_flat.csv).
MISSING_PATH = os.path.join(_ROOT, "outputs", "tirelibrary_missing_barcodes.csv")
CATALOG_COLUMNS = [
    "id", "make_name", "model_name", "size_canonical",
    "width", "aspect_ratio", "rim_size", "load_rating", "speed_rating",
    "load_range", "ply_rating", "utqg", "season", "terrain", "category",
    "tread_depth", "weight", "warranty",
    "upc", "ean", "gm_code", "asin", "item_number",
    "three_pmsf", "run_flat", "mud_and_snow", "thumbnail_image",
]


def _ensure_catalog_header(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        with open(path, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(CATALOG_COLUMNS)


def _load_catalog_ids(path):
    ids = set()
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            r = csv.reader(f)
            next(r, None)
            for row in r:
                if row:
                    ids.add(str(row[0]))
    return ids


def _catalog_row(detail, cat_row, tire_id):
    def g(k):
        val = detail.get(k, cat_row.get(k))
        return "" if val is None else val
    make = cat_row.get("make_name") or ""
    model = cat_row.get("model_name") or ""
    tm = detail.get("tire_make")
    if not make and isinstance(tm, dict):
        make = tm.get("name") or ""
    tmo = detail.get("tire_model")
    if not model and isinstance(tmo, dict):
        model = tmo.get("name") or ""
    raw_size = f"{g('width')}/{g('aspect_ratio')}R{g('rim_size')}"
    sc, _ = v.normalize_size(raw_size)
    return [
        tire_id, make, model, sc or "",
        g("width"), g("aspect_ratio"), g("rim_size"), g("load_rating"), g("speed_rating"),
        g("load_range"), g("ply_rating"), g("utqg"), g("season"), g("terrain"), g("category"),
        g("tread_depth"), g("weight"), g("warranty"),
        g("upc"), g("ean"), g("gm_code"), g("asin"), g("item_number"),
        g("three_pmsf"), g("run_flat"), g("mud_and_snow"), g("thumbnail_image"),
    ]


def _append_catalog(path, rows):
    if rows:
        with open(path, "a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows(rows)


def harvest(args):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    api_key = _load_api_key()
    session = requests.Session()
    session.headers.update({"x-api-key": api_key})

    paths = _make_paths(_ROOT)
    _ensure_flat_header(paths)

    # Full-catalog capture: load already-captured ids so re-runs don't duplicate.
    _ensure_catalog_header(MISSING_PATH)
    catalog_ids = _load_catalog_ids(MISSING_PATH)
    print(f"[harvest] No-barcode enrichment queue: {len(catalog_ids)} tires already recorded.")

    ledger_path = os.path.join(_ROOT, "coverage_ledger.json")
    led = L.load_ledger(ledger_path)

    run_id = f"tirelibrary_api_{uuid.uuid4().hex[:8]}"

    # ── Load or build checkpoint ──────────────────────────────────────────────
    cp = _load_checkpoint()

    if cp is None:
        print("[harvest] No checkpoint found — starting fresh.")
        print("[harvest] Fetching brand facets...")
        facet_brands = fetch_all_facet_brands(session)
        print(f"[harvest] Found {len(facet_brands)} brands in facet list.")
        queue = build_brand_queue(facet_brands)
        if args.brand:
            # Single-brand mode
            lower_target = args.brand.lower()
            matched = [b for b in queue if b.lower() == lower_target]
            if not matched:
                print(f"[harvest] ERROR: brand '{args.brand}' not found in facet list.")
                print(f"[harvest] Available (first 20): {queue[:20]}")
                sys.exit(1)
            queue = matched
        cp = {
            "queue": queue,
            "idx": 0,
            "page": 1,
            "stats": {
                "seen": 0, "barcoded": 0, "upc": 0, "ean": 0,
                "written": 0, "dup": 0, "no_barcode": 0, "bad_size": 0, "errors": 0,
                "captured": 0,
            },
        }
        _save_checkpoint(cp)
    else:
        print(f"[harvest] Resuming from checkpoint: brand idx={cp['idx']}, page={cp['page']}")
        if args.brand:
            lower_target = args.brand.lower()
            matched = [b for b in cp["queue"] if b.lower() == lower_target]
            if not matched:
                print(f"[harvest] ERROR: brand '{args.brand}' not in queue.")
                sys.exit(1)
            # Override queue to just this brand
            cp["queue"] = matched
            cp["idx"] = 0
            cp["page"] = 1

    stats = cp["stats"]
    stats.setdefault("captured", 0)
    total_details = 0
    last_audit_written = stats["written"]

    queue = cp["queue"]
    n_priority = len(PRIORITY_BRANDS)  # used for --only-priority cutoff check

    print(f"[harvest] Queue has {len(queue)} brands. Priority: {PRIORITY_BRANDS}")

    interrupted = False

    try:
        brand_idx = cp["idx"]
        while brand_idx < len(queue):
            brand = queue[brand_idx]

            # --only-priority: stop after priority brands
            if args.only_priority:
                # Priority brands are the first N in queue (before we inserted non-priority)
                if brand_idx >= sum(1 for pb in PRIORITY_BRANDS
                                    if pb.lower() in [b.lower() for b in queue]):
                    print("[harvest] --only-priority reached — stopping.")
                    break

            page = cp["page"] if brand_idx == cp["idx"] else 1
            last_page = None

            while True:
                # --max-details guard
                if args.max_details and total_details >= args.max_details:
                    print(f"[harvest] --max-details {args.max_details} reached — stopping.")
                    cp["idx"] = brand_idx
                    cp["page"] = page
                    cp["stats"] = stats
                    _save_checkpoint(cp)
                    return

                # Fetch catalog page
                try:
                    cat_data = _get(session, f"{BASE_URL}/tires/catalog", params={
                        "make_name": brand,
                        "per_page": 100,
                        "page": page,
                    })
                except Exception as exc:
                    print(f"  [catalog] ERROR fetching {brand} page {page}: {exc}")
                    stats["errors"] += 1
                    break

                results = cat_data.get("results", {})
                catalog_items = results.get("data", [])
                if last_page is None:
                    last_page = results.get("last_page", 1)

                print(
                    f"[{brand}] page {page}/{last_page}  "
                    f"seen={stats['seen']} no_bc_queue={stats['captured']} barcoded={stats['barcoded']} "
                    f"written={stats['written']} dup={stats['dup']} "
                    f"no_bc={stats['no_barcode']} bad_sz={stats['bad_size']} err={stats['errors']}"
                )

                batch = []
                catalog_batch = []
                for cat_row in catalog_items:
                    tire_id = cat_row.get("id")
                    if not tire_id:
                        continue

                    stats["seen"] += 1

                    # Fetch detail
                    try:
                        detail_data = _get(session, f"{BASE_URL}/tires/{tire_id}")
                        time.sleep(DETAIL_SLEEP)
                    except Exception as exc:
                        print(f"    [detail] ERROR tire_id={tire_id}: {exc}")
                        stats["errors"] += 1
                        total_details += 1
                        continue

                    total_details += 1
                    detail = detail_data.get("results", detail_data)

                    # Track UPC / EAN for stats
                    upc_raw = str(detail.get("upc") or "").strip()
                    ean_raw = str(detail.get("ean") or "").strip()
                    had_upc = bool(upc_raw and upc_raw != "None")
                    had_ean = bool(ean_raw and ean_raw != "None")

                    # No-barcode tires -> SEPARATE enrichment queue (dedup by id),
                    # so a later barcode-finder only processes these, not the whole DB.
                    if not had_upc and not had_ean:
                        tid_str = str(tire_id)
                        if tid_str not in catalog_ids:
                            catalog_batch.append(_catalog_row(detail, cat_row, tire_id))
                            catalog_ids.add(tid_str)
                            stats["captured"] += 1

                    identity = detail_to_identity(detail, cat_row)

                    if identity is None:
                        # Determine skip reason
                        if had_upc or had_ean:
                            stats["bad_size"] += 1
                        else:
                            stats["no_barcode"] += 1
                        continue

                    if had_upc:
                        stats["upc"] += 1
                    elif had_ean:
                        stats["ean"] += 1
                    stats["barcoded"] += 1

                    batch.append(identity)

                    # --max-details guard inside inner loop
                    if args.max_details and total_details >= args.max_details:
                        break

                # Write batch
                if batch:
                    counts = write_rows(batch, paths, led, run_id)
                    stats["written"] += counts["trusted"]
                    stats["dup"] += counts["dup_skipped"]
                    L.save_ledger(led, ledger_path)

                    # Periodic audit
                    if stats["written"] - last_audit_written >= AUDIT_INTERVAL:
                        last_audit_written = stats["written"]
                        ok, errs = audit(_ROOT)
                        print(f"  [AUDIT] {'PASS' if ok else 'FAIL'} (written={stats['written']})")
                        if not ok:
                            for e in errs:
                                print(f"    - {e}")

                # Flush full-catalog rows for this page (barcoded or not)
                _append_catalog(MISSING_PATH, catalog_batch)

                # Save checkpoint after every page
                cp["idx"] = brand_idx
                cp["page"] = page
                cp["stats"] = stats
                _save_checkpoint(cp)

                if page >= last_page:
                    break
                page += 1

            # Move to next brand
            brand_idx += 1
            cp["idx"] = brand_idx
            cp["page"] = 1
            cp["stats"] = stats
            _save_checkpoint(cp)

    except KeyboardInterrupt:
        print("\n[harvest] Interrupted by user. Checkpoint saved.")
        interrupted = True
    finally:
        cp["idx"] = brand_idx if not interrupted else cp.get("idx", 0)
        cp["stats"] = stats
        _save_checkpoint(cp)

    # Final audit
    if not interrupted:
        ok, errs = audit(_ROOT)
        print(f"\n[harvest] FINAL AUDIT {'PASS' if ok else 'FAIL'}")
        for e in errs:
            print(f"  - {e}")

    print("\n[harvest] DONE")
    print(f"  seen={stats['seen']} no_barcode_queue={stats['captured']} (-> {MISSING_PATH})")
    print(f"  barcoded={stats['barcoded']} upc={stats['upc']} ean={stats['ean']}")
    print(f"  written={stats['written']} dup={stats['dup']} no_barcode={stats['no_barcode']}")
    print(f"  bad_size={stats['bad_size']} errors={stats['errors']}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Tirelibrary API harvester.")
    parser.add_argument("--only-priority", action="store_true",
                        help="Stop after priority brands are processed.")
    parser.add_argument("--max-details", type=int, default=0,
                        help="Cap total detail calls (0 = no cap). Useful for smoke tests.")
    parser.add_argument("--brand", type=str, default="",
                        help="Process only this single brand (case-insensitive match).")
    args = parser.parse_args()

    harvest(args)


if __name__ == "__main__":
    main()
