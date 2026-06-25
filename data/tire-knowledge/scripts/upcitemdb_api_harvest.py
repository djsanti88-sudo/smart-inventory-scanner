#!/usr/bin/env python3
"""
upcitemdb_api_harvest.py — FREE trial-API harvester for upcitemdb.com.

Uses the trial search endpoint (no API key required) with offset pagination
to harvest tire listings per brand, going DEEPER than the 45-item HTML cap.

API endpoint:
    GET https://api.upcitemdb.com/prod/trial/search?s={query}&offset={n}
    Headers: User-Agent: Mozilla/5.0 Chrome/125, Accept: application/json
    Response: {code, total, offset, items:[{upc, ean, brand, title, ...}]}

Rate limits (trial):
    ~100 requests/day total; burst ~2 searches/30s.
    This harvester sleeps 16s between calls and hard-stops at 95 requests/day.

Resume logic:
    api_progress.json persists per-brand next_offset so multi-day runs pick up
    exactly where they left off without re-paging already-fetched pages.

QA checkpoints:
    verify_corpus_full.py runs (free, deterministic) after every 2000 new trusted rows.
    gemini_verify_sample.py --n 25 runs as advisory (logged, non-blocking) at same threshold.
"""

import json
import os
import subprocess
import sys
import time

# Make scripts/ importable when run as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import requests
import certifi

from upcitemdb_parse import parse_name
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit
from upcitemdb_harvest import BRAND_SLUGS

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_API_BASE = "https://api.upcitemdb.com/prod/trial/search"
_API_SOURCE_URL = "https://api.upcitemdb.com/prod/trial/search"
_SLEEP_S = 16.0          # seconds between API calls (respects ~2/30s burst limit)
_DAILY_CAP_DEFAULT = 95  # hard stop before the 100/day trial limit
_CHECKPOINT_EVERY = 2000  # new trusted rows between QA checkpoints

_API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0",
    "Accept": "application/json",
}

# Priority brands: niche/budget/shop brands FIRST (depth matters most there),
# then fill in from BRAND_SLUGS preserving order.
_NICHE_FIRST = [
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

# Build PRIORITY_BRANDS: niche first, then the rest of BRAND_SLUGS in their
# existing order, deduplicating so each brand appears exactly once.
def _build_priority_brands() -> list:
    seen: set = set()
    result = []
    for b in _NICHE_FIRST:
        if b not in seen:
            seen.add(b)
            result.append(b)
    for b in BRAND_SLUGS:
        if b not in seen:
            seen.add(b)
            result.append(b)
    return result

PRIORITY_BRANDS = _build_priority_brands()

# ---------------------------------------------------------------------------
# Progress persistence (per-brand next_offset)
# ---------------------------------------------------------------------------

_PROGRESS_FILE = "api_progress.json"


def _progress_path(root: str) -> str:
    return os.path.join(root, _PROGRESS_FILE)


def load_progress(root: str) -> dict:
    """Load api_progress.json; return empty dict if missing or malformed."""
    path = _progress_path(root)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        return {}
    except Exception:
        return {}


def save_progress(root: str, progress: dict) -> None:
    """Persist api_progress.json (sorted keys for deterministic diffs)."""
    path = _progress_path(root)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(progress.items())), f, indent=2)


# ---------------------------------------------------------------------------
# HTTP search helper
# ---------------------------------------------------------------------------

def _search_page(query: str, offset: int) -> dict | None:
    """
    Call the trial search API for one page.
    Returns the parsed JSON dict, or None on any error.
    Does NOT sleep — callers sleep before calling this (keeps tests clean).
    """
    params = {"s": query, "offset": offset}
    try:
        resp = requests.get(
            _API_BASE,
            params=params,
            headers=_API_HEADERS,
            timeout=25,
            verify=certifi.where(),
        )
        if resp.status_code == 200:
            return resp.json()
        print(
            f"  [api] {query!r} offset={offset}: HTTP {resp.status_code} -> skip",
            flush=True,
        )
        return None
    except Exception as exc:
        print(f"  [api] {query!r} offset={offset}: exception {exc}", flush=True)
        return None


# ---------------------------------------------------------------------------
# Brand search with pagination
# ---------------------------------------------------------------------------

def search_brand(query: str, start_offset: int, budget: int) -> tuple:
    """
    Page the trial search for `query` starting at `start_offset`.

    Sleeps _SLEEP_S between calls.  Stops when:
      - offset >= total (all pages fetched), OR
      - items list is empty (API returned nothing), OR
      - budget hits 0 (daily request cap exhausted).

    Returns:
        (items: list, requests_used: int, total: int)
        items  — all raw API item dicts collected across pages
        total  — the `total` value from the first response (or 0 if unknown)
    """
    all_items = []
    requests_used = 0
    current_offset = start_offset
    total = 0

    while budget > 0:
        time.sleep(_SLEEP_S)
        page = _search_page(query, current_offset)
        requests_used += 1
        budget -= 1

        if page is None:
            # Network error or non-200; stop this brand gracefully
            break

        page_total = page.get("total", 0)
        if total == 0 and page_total:
            total = page_total

        items = page.get("items", [])
        if not items:
            # Empty page — no more results
            break

        all_items.extend(items)
        current_offset += len(items)

        if current_offset >= page_total and page_total > 0:
            # Fetched all available pages
            break

    return all_items, requests_used, total


# ---------------------------------------------------------------------------
# Item -> identity conversion
# ---------------------------------------------------------------------------

def _barcode_from_item(item: dict) -> str:
    """
    Derive a 12-digit UPC barcode from item.
    Prefer 'upc' field; fall back to stripping leading '0' from 'ean' (13-digit
    EAN -> 12-digit UPC).  Returns '' if neither is usable.
    """
    upc = str(item.get("upc", "")).strip()
    if upc and upc.isdigit() and len(upc) == 12:
        return upc

    ean = str(item.get("ean", "")).strip()
    if ean and ean.isdigit():
        if len(ean) == 12:
            return ean
        if len(ean) == 13 and ean.startswith("0"):
            return ean[1:]  # strip leading zero to get 12-digit UPC

    return ""


def _item_to_identity(item: dict, brand_slug: str) -> dict | None:
    """
    Convert a raw API item dict to an identity dict ready for write_rows.

    Returns None if:
      - No usable barcode can be derived.
      - parse_name() returns {} (no valid tire size or not a tire product).
    """
    title = str(item.get("title", "")).strip()
    if not title:
        return None

    parsed = parse_name(title)
    if not parsed:
        return None  # no valid tire size — skip

    barcode = _barcode_from_item(item)
    if not barcode:
        return None

    # Use the API-provided brand name if available; fall back to brand_slug
    api_brand = str(item.get("brand", "")).strip() or brand_slug

    return {
        "brand": api_brand,
        "model": parsed["model"],
        "mpn": parsed["mpn"],
        "manufacturer_part_number": parsed["mpn"],
        "barcode": barcode,
        "size_canonical": parsed["size_canonical"],
        "size_compact": parsed["size_compact"],
        "load_index": parsed["load_index"],
        "speed_rating": parsed["speed_rating"],
        "tire_type": parsed["tire_type"],
        "season": parsed["season"],
        "evidence_level": "verified_db",
        "source_url": _API_SOURCE_URL,
    }


# ---------------------------------------------------------------------------
# QA checkpoint helpers (mirrors upcitemdb_harvest pattern)
# ---------------------------------------------------------------------------

def _utc_now() -> str:
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _run_verify_checkpoint(cumulative: int, root: str, log_path: str) -> bool:
    """
    Run verify_corpus_full.py via subprocess.
    Returns True if QA passed, False otherwise.
    Appends a block to run-log.md.
    """
    script_path = os.path.join(root, "scripts", "verify_corpus_full.py")
    print(
        f"\n[API-QA CHECKPOINT @ {cumulative} rows] running verify_corpus_full.py ...",
        flush=True,
    )
    try:
        result = subprocess.run(
            ["uv", "run", "python", script_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            cwd=root,
        )
        output = result.stdout + result.stderr
        passed = "ALL DETERMINISTIC CHECKS PASS" in output
        verdict = "PASS" if passed else "FAIL"

        print(f"[API-QA CHECKPOINT @ {cumulative} rows] verdict={verdict}", flush=True)

        entry = (
            f"\n## API-QA CHECKPOINT @ {cumulative} rows\n"
            f"- verdict: {verdict}\n"
            f"- timestamp: {_utc_now()}\n"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)

        if not passed:
            print("[API-QA CHECKPOINT] FAIL — halting harvest.", flush=True)
            print(output, flush=True)

        return passed

    except Exception as exc:
        msg = f"[API-QA CHECKPOINT] exception: {exc}"
        print(msg, flush=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"\n## API-QA CHECKPOINT @ {cumulative} rows\n- verdict: ERROR\n- error: {exc}\n")
        return False


def _run_gemini_advisory(cumulative: int, root: str, log_path: str) -> None:
    """
    Run gemini_verify_sample.py --n 25 as an advisory (non-blocking).
    Logs result to run-log.md; never halts the harvest on failure.
    """
    script_path = os.path.join(root, "scripts", "gemini_verify_sample.py")
    if not os.path.exists(script_path):
        return

    print(
        f"\n[API-GEMINI ADVISORY @ {cumulative} rows] running gemini_verify_sample.py --n 25 ...",
        flush=True,
    )
    try:
        result = subprocess.run(
            ["uv", "run", "python", script_path, "--n", "25"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            cwd=root,
        )
        output = (result.stdout + result.stderr)[:2000]  # cap log size
        print(f"[API-GEMINI ADVISORY] exit={result.returncode}", flush=True)

        entry = (
            f"\n## API-GEMINI ADVISORY @ {cumulative} rows\n"
            f"- exit: {result.returncode}\n"
            f"- timestamp: {_utc_now()}\n"
            f"- output (first 2000 chars):\n{output}\n"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)

    except Exception as exc:
        print(f"[API-GEMINI ADVISORY] exception: {exc}", flush=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"\n## API-GEMINI ADVISORY @ {cumulative} rows\n- error: {exc}\n")


# ---------------------------------------------------------------------------
# Main harvest function
# ---------------------------------------------------------------------------

def harvest(root: str, daily_request_cap: int = _DAILY_CAP_DEFAULT) -> dict:
    """
    Harvest tire data from the upcitemdb trial search API.

    Loads api_progress.json to resume from where the last run stopped.
    Iterates PRIORITY_BRANDS; for each brand pages the API from its saved
    offset; writes rows via write_rows (dedup against ledger).
    Saves api_progress.json + ledger after each brand.
    Runs QA checkpoints every _CHECKPOINT_EVERY new trusted rows.
    Stops when daily_request_cap is exhausted.

    Returns a summary dict:
        requests_used, brands_touched, trusted_added, dup_skipped, audit_ok,
        _audit_errors (list), budget_remaining
    """
    # -- Paths --
    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    ids_path = os.path.join(root, "tire_identifiers.csv")
    ledger_path = os.path.join(root, "coverage_ledger.json")
    log_path = os.path.join(root, "run-log.md")
    paths = {"flat": flat_path, "identifiers": ids_path}

    # -- Load state --
    led = L.load_ledger(ledger_path)
    progress = load_progress(root)

    # -- Run tracking --
    import datetime
    run_id = f"api_harvest_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    budget = daily_request_cap
    total_requests = 0
    total_trusted = 0
    total_dups = 0
    brands_touched = 0
    checkpoint_baseline = led.get("total_trusted_barcode_rows", 0)

    print(
        f"[api_harvest] start run_id={run_id} cap={daily_request_cap} "
        f"brands={len(PRIORITY_BRANDS)}",
        flush=True,
    )

    for brand_slug in PRIORITY_BRANDS:
        if budget <= 0:
            print(f"[api_harvest] daily cap reached — stopping.", flush=True)
            break

        start_offset = progress.get(brand_slug, 0)
        query = f"{brand_slug} tire"

        print(
            f"[api_harvest] brand={brand_slug!r} start_offset={start_offset} budget={budget}",
            flush=True,
        )

        items, reqs_used, api_total = search_brand(query, start_offset, budget)
        budget -= reqs_used
        total_requests += reqs_used

        if reqs_used > 0:
            brands_touched += 1

        if not items:
            # Nothing returned — keep offset as-is so next run can retry
            print(f"  [api_harvest] {brand_slug}: 0 items from API", flush=True)
            save_progress(root, progress)
            continue

        # Convert items to identities; skip non-tires
        identities = []
        for item in items:
            idn = _item_to_identity(item, brand_slug)
            if idn is not None:
                identities.append(idn)

        # Write rows (dedup, route, append to CSV)
        if identities:
            counts = write_rows(identities, paths, led, run_id)
            trusted_this_brand = counts["trusted"]
            dup_this_brand = counts["dup_skipped"]
        else:
            trusted_this_brand = 0
            dup_this_brand = 0
            counts = {"trusted": 0, "dup_skipped": 0}

        total_trusted += trusted_this_brand
        total_dups += dup_this_brand

        print(
            f"  [api_harvest] {brand_slug}: items={len(items)} "
            f"identities={len(identities)} trusted={trusted_this_brand} "
            f"dups={dup_this_brand} api_total={api_total}",
            flush=True,
        )

        # Advance the brand's offset in progress
        new_offset = start_offset + len(items)
        if api_total > 0 and new_offset >= api_total:
            # Fully paged this brand — mark complete with a sentinel
            progress[brand_slug] = api_total
        else:
            progress[brand_slug] = new_offset

        # Save progress + ledger after every brand
        save_progress(root, progress)
        L.save_ledger(led, ledger_path)

        # QA checkpoint every _CHECKPOINT_EVERY new trusted rows
        cumulative_trusted = led.get("total_trusted_barcode_rows", 0)
        prev_check = checkpoint_baseline + (
            ((cumulative_trusted - checkpoint_baseline) // _CHECKPOINT_EVERY - 1)
            * _CHECKPOINT_EVERY
        )
        rows_since_baseline = cumulative_trusted - checkpoint_baseline
        if rows_since_baseline > 0 and (rows_since_baseline % _CHECKPOINT_EVERY) < trusted_this_brand:
            # Crossed a checkpoint boundary this brand
            qa_ok = _run_verify_checkpoint(rows_since_baseline, root, log_path)
            if not qa_ok:
                print("[api_harvest] QA FAIL — halting immediately.", flush=True)
                break
            _run_gemini_advisory(rows_since_baseline, root, log_path)

    # Save final state
    save_progress(root, progress)
    L.save_ledger(led, ledger_path)

    # Final audit
    audit_ok, audit_errors = audit(root)

    result = {
        "requests_used": total_requests,
        "brands_touched": brands_touched,
        "trusted_added": total_trusted,
        "dup_skipped": total_dups,
        "audit_ok": audit_ok,
        "_audit_errors": audit_errors,
        "budget_remaining": budget,
    }

    print(
        f"[api_harvest] done: requests={total_requests} brands={brands_touched} "
        f"trusted={total_trusted} dups={total_dups} "
        f"audit={'PASS' if audit_ok else 'FAIL'} budget_left={budget}",
        flush=True,
    )
    return result



# ---------------------------------------------------------------------------
# Lock helpers (inline, compatible with run_once.py harvest.lock format)
# ---------------------------------------------------------------------------

_LOCK_FILE = "harvest.lock"
_STALE_MINUTES = 90


def _lock_path_api(root: str) -> str:
    return os.path.join(root, _LOCK_FILE)


def _parse_iso_api(ts: str):
    """Parse ISO-8601 UTC timestamp; return float POSIX seconds or None."""
    import re as _re
    m = _re.match(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$", ts.strip()
    )
    if not m:
        return None
    import datetime as _dt
    try:
        d = _dt.datetime(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)),
            tzinfo=_dt.timezone.utc,
        )
        return d.timestamp()
    except Exception:
        return None


def _lock_is_stale_api(lock_data: dict) -> bool:
    ts_str = lock_data.get("last_heartbeat_at", "")
    ts = _parse_iso_api(ts_str)
    if ts is None:
        return True
    age_minutes = (time.time() - ts) / 60.0
    return age_minutes > _STALE_MINUTES


def write_lock_api(root: str, run_id: str) -> None:
    """Write harvest.lock."""
    now = _utc_now()
    lock_data = {
        "run_id": run_id,
        "started_at": now,
        "last_heartbeat_at": now,
        "process": os.getpid(),
    }
    with open(_lock_path_api(root), "w", encoding="utf-8") as f:
        json.dump(lock_data, f, indent=2)
        f.write("\n")


def release_lock_api(root: str) -> None:
    """Delete harvest.lock if it exists."""
    path = _lock_path_api(root)
    if os.path.exists(path):
        os.remove(path)


def acquire_lock_api(root: str, run_id: str) -> bool:
    """
    Try to acquire harvest.lock.

    Returns True if acquired.
    Returns False if a FRESH lock (<90 min) exists.
    Reclaims stale locks automatically.
    """
    lock_file = _lock_path_api(root)
    if os.path.exists(lock_file):
        try:
            with open(lock_file, encoding="utf-8") as f:
                lock_data = json.load(f)
            if _lock_is_stale_api(lock_data):
                os.remove(lock_file)
                print(
                    f"[api_harvest] reclaimed stale lock "
                    f"(run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')})",
                    flush=True,
                )
            else:
                print(
                    f"[api_harvest] another run in progress "
                    f"(run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')}) -- "
                    "remove harvest.lock manually if the previous run crashed",
                    flush=True,
                )
                return False
        except Exception as exc:
            try:
                os.remove(lock_file)
                print(f"[api_harvest] reclaimed unparseable lock ({exc})", flush=True)
            except Exception as rm_exc:
                print(f"[api_harvest] lock could not be removed: {rm_exc}", flush=True)
                return False

    write_lock_api(root, run_id)
    return True
# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    root = _ROOT
    import datetime as _dt_main
    _run_id_api = f"api_harvest_{_dt_main.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"

    if not acquire_lock_api(root, _run_id_api):
        sys.exit(1)

    result = {}
    try:
        result = harvest(root)
    finally:
        release_lock_api(root)

    print("\n=== API HARVEST SUMMARY ===")
    print(f"  requests_used     : {result['requests_used']}")
    print(f"  brands_touched    : {result['brands_touched']}")
    print(f"  trusted_added     : {result['trusted_added']}")
    print(f"  dup_skipped       : {result['dup_skipped']}")
    print(f"  budget_remaining  : {result['budget_remaining']}")
    print(f"  audit             : {'PASS' if result['audit_ok'] else 'FAIL'}")
    if result["_audit_errors"]:
        for e in result["_audit_errors"]:
            print(f"    - {e}")

    sys.exit(0 if result["audit_ok"] else 1)

