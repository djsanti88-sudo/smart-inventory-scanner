#!/usr/bin/env python3
"""
upcitemdb_firecrawl_api_harvest.py — Firecrawl-proxy DEPTH harvester for upcitemdb API.

Calls the upcitemdb trial SEARCH API THROUGH Firecrawl (rotating IPs bypass the
per-IP 429), allowing pagination past the 45-item HTML cap.

How it works:
    firecrawl_client.call(["scrape","--format","rawHtml","--proxy","auto", URL],
                          expected_max_credits=2, run_state, root)
    where URL = https://api.upcitemdb.com/prod/trial/search?s={brand}+tire&offset={n}
    (use + for spaces, NOT %20 -- the firewall rejects %)

    The result stdout contains the API JSON:
      parse with json.loads(stdout), fallback to re.search(r'\{.*\}', stdout, re.S)

JSON shape: {total, offset, items:[{upc, ean, brand, title}]}
  (~5 items/page; page by offset += len(items) until offset>=total or empty).

REUSES _item_to_identity from upcitemdb_api_harvest.py (builds identity from
item upc/ean + item brand + parse_name(title); skips non-tires).

SHARES api_progress.json with the free API harvester so both cooperate:
whoever runs advances the shared offset; no double-paging.

EFFICIENCY FLOOR = 4 rows/credit: track per-brand; if a brand yields <4 rows/credit
after 3 pages, move to the next brand. Global stop if overall <4/credit after 5 brands.

BUDGET: harvest(root, credit_budget=100) -- stop when credits_spent >= credit_budget
OR brands exhausted.

LOCK: acquire harvest.lock at start (reuse run_once.py helpers). If a FRESH lock
(<90min) exists, exit "another run in progress"; reclaim stale.

CHECKPOINT every 2000 new rows: verify_corpus_full.py (STOP on FAIL) +
gemini_verify_sample.py --n 25 (advisory).
"""

import argparse
import json
import os
import re
import sys
import datetime

# Make scripts/ importable when run as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import firecrawl_client
from upcitemdb_api_harvest import (
    _item_to_identity,
    load_progress,
    save_progress,
    _run_verify_checkpoint,
    _run_gemini_advisory,
    _utc_now,
)
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_API_BASE = "https://api.upcitemdb.com/prod/trial/search"
_CHECKPOINT_EVERY = 2000      # new trusted rows between QA checkpoints
_EFFICIENCY_FLOOR = 4         # rows/credit floor
_EFFICIENCY_WARMUP_PAGES = 3  # pages per brand before efficiency check kicks in
_EFFICIENCY_GLOBAL_BRANDS = 5 # global stop if <4/credit after this many brands

# Priority brands: unambiguous, clean-search, deep-results.
PRIORITY_BRANDS = [
    "fortune",
    "toyo",
    "falken",
    "dunlop",
    "nexen",
    "nokian",
    "milestar",
    "delinte",
    "federal",
    "ironman",
    "hercules",
    "kumho",
    "cooper",
    "yokohama",
    "pirelli",
    "michelin",
    "bridgestone",
    "continental",
    "general",
    "hankook",
    "kelly",
    "laufenn",
    "sumitomo",
    "sailun",
    "kenda",
    "maxxis",
]

# ---------------------------------------------------------------------------
# Lock helpers (inline, compatible with run_once.py harvest.lock format)
# ---------------------------------------------------------------------------

_LOCK_FILE = "harvest.lock"
_STALE_MINUTES = 90


def _lock_path(root: str) -> str:
    return os.path.join(root, _LOCK_FILE)


def _parse_iso(ts: str):
    """Parse ISO-8601 UTC timestamp; return float POSIX seconds or None."""
    m = re.match(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$", ts.strip()
    )
    if not m:
        return None
    try:
        dt = datetime.datetime(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)),
            tzinfo=datetime.timezone.utc,
        )
        return dt.timestamp()
    except Exception:
        return None


def _lock_is_stale(lock_data: dict) -> bool:
    """Return True if last_heartbeat_at is >90 minutes old or unparseable."""
    import time
    ts_str = lock_data.get("last_heartbeat_at", "")
    ts = _parse_iso(ts_str)
    if ts is None:
        return True
    age_minutes = (time.time() - ts) / 60.0
    return age_minutes > _STALE_MINUTES


def _now_iso() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def write_lock(root: str, run_id: str) -> None:
    """Write harvest.lock with run_id, timestamps, and PID."""
    lock_data = {
        "run_id": run_id,
        "started_at": _now_iso(),
        "last_heartbeat_at": _now_iso(),
        "process": os.getpid(),
    }
    with open(_lock_path(root), "w", encoding="utf-8") as f:
        json.dump(lock_data, f, indent=2)
        f.write("\n")


def release_lock(root: str) -> None:
    """Delete harvest.lock if it exists."""
    path = _lock_path(root)
    if os.path.exists(path):
        os.remove(path)


def acquire_lock(root: str, run_id: str) -> bool:
    """
    Try to acquire harvest.lock.

    Returns True if acquired successfully.
    Returns False if a FRESH lock (<90 min) already exists.
    Automatically reclaims stale locks (>90 min).
    """
    lock_file = _lock_path(root)
    if os.path.exists(lock_file):
        try:
            with open(lock_file, encoding="utf-8") as f:
                lock_data = json.load(f)
            if _lock_is_stale(lock_data):
                os.remove(lock_file)
                print(
                    f"[fc_api_harvest] reclaimed stale lock "
                    f"(run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')})",
                    flush=True,
                )
            else:
                print(
                    f"[fc_api_harvest] another run in progress "
                    f"(run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')}) -- "
                    "remove harvest.lock manually if the previous run crashed",
                    flush=True,
                )
                return False
        except Exception as exc:
            # Unparseable lock -> reclaim it
            try:
                os.remove(lock_file)
                print(f"[fc_api_harvest] reclaimed unparseable lock ({exc})", flush=True)
            except Exception as rm_exc:
                print(
                    f"[fc_api_harvest] lock exists but could not be removed: {rm_exc}",
                    flush=True,
                )
                return False

    write_lock(root, run_id)
    return True


# ---------------------------------------------------------------------------
# Firecrawl API page fetch
# ---------------------------------------------------------------------------

def _fetch_api_page(brand: str, offset: int, run_state: dict, root: str) -> tuple:
    """
    Fetch one page of the upcitemdb search API via Firecrawl proxy.

    URL uses + for spaces (% causes firewall rejection).

    Returns:
        (page_dict: dict | None, credits_spent: int)
        page_dict is None on any error or parse failure.

    Raises:
        RuntimeError: propagated from firecrawl_client.call on cap/kill switch.
    """
    url = f"{_API_BASE}?s={brand}+tire&offset={offset}"
    cmd_args = [
        "scrape",
        "--format", "rawHtml",
        "--proxy", "auto",
        url,
    ]

    result = firecrawl_client.call(
        cmd_args,
        expected_max_credits=2,
        run_state=run_state,
        root=root,
    )

    credits_spent = result.get("credits_spent", 0)
    stdout = result.get("stdout", "")

    if not stdout.strip():
        print(
            f"  [fc_api] {brand!r} offset={offset}: empty stdout "
            f"(rc={result['returncode']}, credits={credits_spent})",
            flush=True,
        )
        return None, credits_spent

    # Try direct JSON parse first
    page = None
    try:
        page = json.loads(stdout)
    except Exception:
        pass

    if page is None:
        # Fallback: extract JSON object from surrounding HTML/text
        m = re.search(r'\{.*\}', stdout, re.S)
        if m:
            try:
                page = json.loads(m.group(0))
            except Exception:
                pass

    if page is None:
        print(
            f"  [fc_api] {brand!r} offset={offset}: could not parse JSON from stdout",
            flush=True,
        )
        return None, credits_spent

    return page, credits_spent


# ---------------------------------------------------------------------------
# Per-brand pagination with efficiency floor
# ---------------------------------------------------------------------------

def _harvest_brand(
    brand_slug: str,
    start_offset: int,
    credit_budget: int,
    run_state: dict,
    paths: dict,
    led: dict,
    run_id: str,
    root: str,
) -> tuple:
    """
    Page the API for one brand starting at start_offset.

    Efficiency floor: if after _EFFICIENCY_WARMUP_PAGES pages the brand has
    yielded <4 rows/credit, stop this brand early and return move_on=True.

    Returns:
        (new_offset, trusted, dup_skipped, credits_spent, move_on, fully_paged)
        All ints except move_on and fully_paged which are bools.

    Raises:
        RuntimeError: propagated from firecrawl_client.call on cap/kill switch.
    """
    current_offset = start_offset
    brand_trusted = 0
    brand_dup_skipped = 0
    brand_credits = 0
    pages_fetched = 0
    total = 0
    fully_paged = False
    move_on = False

    while credit_budget > 0:
        page, credits = _fetch_api_page(brand_slug, current_offset, run_state, root)

        brand_credits += credits
        credit_budget -= credits

        if page is None:
            break

        page_total = page.get("total", 0)
        if total == 0 and page_total:
            total = page_total

        items = page.get("items", [])
        if not items:
            fully_paged = True
            break

        # Convert items to identities; use item's OWN brand field
        identities = []
        for item in items:
            idn = _item_to_identity(item, brand_slug)
            if idn is not None:
                idn["source_url"] = f"{_API_BASE}?s={brand_slug}+tire&offset={current_offset}"
                identities.append(idn)

        if identities:
            counts = write_rows(identities, paths, led, run_id)
            brand_trusted += counts.get("trusted", 0)
            brand_dup_skipped += counts.get("dup_skipped", 0)
        else:
            counts = {"trusted": 0, "dup_skipped": 0}

        pages_fetched += 1
        current_offset += len(items)

        print(
            f"  [fc_api] {brand_slug!r} page={pages_fetched} "
            f"items={len(items)} identities={len(identities)} "
            f"trusted={counts.get('trusted',0)} dup={counts.get('dup_skipped',0)} "
            f"credits={credits}",
            flush=True,
        )

        if total > 0 and current_offset >= total:
            fully_paged = True
            break

        # Efficiency floor check after warmup pages
        if pages_fetched >= _EFFICIENCY_WARMUP_PAGES and brand_credits > 0:
            rpc = brand_trusted / brand_credits
            if rpc < _EFFICIENCY_FLOOR:
                print(
                    f"  [fc_api] {brand_slug!r}: per-brand efficiency floor hit "
                    f"({rpc:.2f} rows/credit < {_EFFICIENCY_FLOOR} after "
                    f"{pages_fetched} pages) -- moving to next brand",
                    flush=True,
                )
                move_on = True
                break

    return current_offset, brand_trusted, brand_dup_skipped, brand_credits, move_on, fully_paged


# ---------------------------------------------------------------------------
# Main harvest function
# ---------------------------------------------------------------------------

def harvest(root: str, credit_budget: int = 100) -> dict:
    """
    Harvest tire data from the upcitemdb trial search API via Firecrawl proxy.

    Shares api_progress.json with upcitemdb_api_harvest.py -- both advance the
    same per-brand offset, so they cooperate without double-paging.

    Stops when:
      - credit_budget credits spent
      - All PRIORITY_BRANDS exhausted
      - Firecrawl cap / kill switch RuntimeError
      - Global efficiency floor: <4 rows/credit after 5 brands with any credits

    Returns summary dict with keys:
        brands_touched, trusted_added, dup_skipped, credits_spent,
        rows_per_credit, audit_ok, _audit_errors
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
    run_id = f"fc_api_harvest_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    run_state = {"run_credits_spent": 0}
    total_credits = 0
    total_trusted = 0
    total_dups = 0
    brands_touched = 0
    brands_with_credits = 0  # for global efficiency floor
    checkpoint_baseline = led.get("total_trusted_barcode_rows", 0)
    qa_halted = False

    print(
        f"[fc_api_harvest] start run_id={run_id} credit_budget={credit_budget} "
        f"brands={len(PRIORITY_BRANDS)}",
        flush=True,
    )

    for brand_slug in PRIORITY_BRANDS:
        if total_credits >= credit_budget:
            print(f"[fc_api_harvest] credit budget reached -- stopping.", flush=True)
            break

        remaining_budget = credit_budget - total_credits
        start_offset = progress.get(brand_slug, 0)

        print(
            f"[fc_api_harvest] brand={brand_slug!r} start_offset={start_offset} "
            f"credits_remaining={remaining_budget}",
            flush=True,
        )

        try:
            (
                new_offset,
                brand_trusted,
                brand_dups,
                brand_credits,
                move_on,
                fully_paged,
            ) = _harvest_brand(
                brand_slug,
                start_offset,
                remaining_budget,
                run_state,
                paths,
                led,
                run_id,
                root,
            )
        except RuntimeError as exc:
            print(f"[fc_api_harvest] Firecrawl cap/kill switch: {exc}", flush=True)
            break

        total_credits += brand_credits
        total_trusted += brand_trusted
        total_dups += brand_dups

        if brand_credits > 0:
            brands_touched += 1
            brands_with_credits += 1

        print(
            f"[fc_api_harvest] {brand_slug!r}: trusted={brand_trusted} "
            f"dups={brand_dups} credits={brand_credits} "
            f"new_offset={new_offset}",
            flush=True,
        )

        # Advance progress offset (shared with free API harvester)
        progress[brand_slug] = new_offset

        # Save progress + ledger after every brand
        save_progress(root, progress)
        L.save_ledger(led, ledger_path)

        # QA checkpoint every _CHECKPOINT_EVERY new trusted rows
        cumulative_trusted = led.get("total_trusted_barcode_rows", 0)
        rows_since_baseline = cumulative_trusted - checkpoint_baseline
        if (
            brand_trusted > 0
            and rows_since_baseline > 0
            and (rows_since_baseline % _CHECKPOINT_EVERY) < brand_trusted
        ):
            qa_ok = _run_verify_checkpoint(rows_since_baseline, root, log_path)
            if not qa_ok:
                print("[fc_api_harvest] QA FAIL -- halting immediately.", flush=True)
                qa_halted = True
                break
            _run_gemini_advisory(rows_since_baseline, root, log_path)

        # Global efficiency floor: after 5 brands with credits, check overall
        if brands_with_credits >= _EFFICIENCY_GLOBAL_BRANDS and total_credits > 0:
            global_rpc = total_trusted / total_credits
            if global_rpc < _EFFICIENCY_FLOOR:
                print(
                    f"[fc_api_harvest] GLOBAL EFFICIENCY FLOOR: "
                    f"{global_rpc:.2f} rows/credit < {_EFFICIENCY_FLOOR} "
                    f"after {brands_with_credits} brands -- stopping.",
                    flush=True,
                )
                break

    # Save final state
    save_progress(root, progress)
    L.save_ledger(led, ledger_path)

    # Final audit
    audit_ok, audit_errors = audit(root)
    if qa_halted:
        audit_ok = False

    rows_per_credit = total_trusted / max(1, total_credits) if total_credits > 0 else 0.0

    result = {
        "brands_touched": brands_touched,
        "trusted_added": total_trusted,
        "dup_skipped": total_dups,
        "credits_spent": total_credits,
        "rows_per_credit": rows_per_credit,
        "audit_ok": audit_ok,
        "_audit_errors": audit_errors,
    }

    print(
        f"[fc_api_harvest] done: brands={brands_touched} "
        f"trusted={total_trusted} dups={total_dups} "
        f"credits={total_credits} rpc={rows_per_credit:.2f} "
        f"audit={'PASS' if audit_ok else 'FAIL'}",
        flush=True,
    )
    return result


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Firecrawl-proxy depth harvester for upcitemdb trial search API."
    )
    parser.add_argument(
        "--credit-budget",
        type=int,
        default=100,
        help="Maximum Firecrawl credits to spend this run (default: 100)",
    )
    args = parser.parse_args()

    root = _ROOT
    run_id = f"fc_api_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"

    # Acquire lock before doing any work
    if not acquire_lock(root, run_id):
        sys.exit(1)

    result = {}
    try:
        result = harvest(root, credit_budget=args.credit_budget)
    finally:
        release_lock(root)

    print("\n=== FC API HARVEST SUMMARY ===")
    print(f"  brands_touched    : {result.get('brands_touched', 0)}")
    print(f"  trusted_added     : {result.get('trusted_added', 0)}")
    print(f"  dup_skipped       : {result.get('dup_skipped', 0)}")
    print(f"  credits_spent     : {result.get('credits_spent', 0)}")
    print(f"  rows_per_credit   : {result.get('rows_per_credit', 0.0):.2f}")
    print(f"  audit_ok          : {result.get('audit_ok', False)}")
    if result.get("_audit_errors"):
        for e in result["_audit_errors"]:
            print(f"    - {e}")

    sys.exit(0 if result.get("audit_ok", False) else 1)
