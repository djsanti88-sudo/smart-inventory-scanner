#!/usr/bin/env python3
"""
upcitemdb_firecrawl_harvest.py — Firecrawl-proxy harvester for upcitemdb brand pages.

Uses Firecrawl (rotating proxy IPs) to bypass HTTP 429 rate-limiting that blocks
the free requests-based harvester (upcitemdb_harvest.py).

INCREMENTAL: harvested_brands.json (shared with upcitemdb_harvest.py) is read on
startup; any brand already there is skipped. Brands successfully scraped here are
written back to that same file.

EFFICIENCY FLOOR: after a warmup of 5 scraped brands, if cumulative
rows_per_credit < 8, the run stops immediately (stopped_low_efficiency=True).

CHECKPOINT every 2,000 new trusted rows:
  1. verify_corpus_full.py (free) — FAIL -> STOP
  2. gemini_verify_sample.py --n 25 --seed <varying> (~$1) — advisory, log only

All Firecrawl calls go through firecrawl_client.call() (credit firewall).
"""

import json
import os
import subprocess
import sys
import datetime

# Make scripts/ importable when run as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import firecrawl_client
from upcitemdb_harvest import (
    BRAND_SLUGS,
    load_harvested_brands,
    save_harvested_brands,
    should_skip,
    crossed_1000,
)
from upcitemdb_parse import parse_page
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_BASE_URL = "https://www.upcitemdb.com/info-{slug}_tires"
_WARMUP_BRANDS = 5          # number of scraped brands before efficiency check
_ROWS_PER_CREDIT_FLOOR = 8  # minimum acceptable rows/credit after warmup
_CHECKPOINT_EVERY = 2000    # new trusted rows between QA checkpoints


# ---------------------------------------------------------------------------
# Checkpoint boundary helper (analogous to crossed_1000, but for 2000)
# ---------------------------------------------------------------------------

def crossed_2000(prev: int, now: int) -> bool:
    """
    Return True if adding (now - prev) new rows crossed a new multiple of 2000.

    Examples:
        crossed_2000(1999, 2001) -> True   (crossed 2000)
        crossed_2000(0, 2000)   -> True   (exactly hit 2000)
        crossed_2000(2000, 3500)-> False  (stayed in the same band 2000-3999)
        crossed_2000(3500, 4100)-> True   (crossed 4000)
        crossed_2000(500, 1800) -> False  (no boundary crossed)
    """
    if now <= prev:
        return False
    return (now // _CHECKPOINT_EVERY) > (prev // _CHECKPOINT_EVERY)


# ---------------------------------------------------------------------------
# UTC timestamp helper
# ---------------------------------------------------------------------------

def _utc_now() -> str:
    """Return current UTC time as an ISO-8601 string."""
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# QA checkpoint: verify_corpus_full.py (free)
# ---------------------------------------------------------------------------

def _run_verify_corpus(root: str, log_path: str, cumulative: int) -> bool:
    """
    Run verify_corpus_full.py via subprocess.
    Returns True if 'ALL DETERMINISTIC CHECKS PASS' appears in output.
    Appends a ## CHECKPOINT block to run-log.md.
    """
    script_path = os.path.join(root, "scripts", "verify_corpus_full.py")
    print(
        f"\n[FC CHECKPOINT @ {cumulative} rows] running verify_corpus_full.py ...",
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

        corpus_total = "unknown"
        for line in output.splitlines():
            if "FULL CORPUS QA" in line and "rows" in line:
                parts = line.split()
                for p in parts:
                    if p.isdigit():
                        corpus_total = p
                        break

        verdict = "PASS" if passed else "FAIL"
        print(
            f"[FC CHECKPOINT @ {cumulative} rows] verify_corpus verdict={verdict}, corpus={corpus_total}",
            flush=True,
        )

        entry = (
            f"\n## CHECKPOINT @ {cumulative} rows\n"
            f"- verify_corpus: {verdict}\n"
            f"- corpus_total: {corpus_total}\n"
            f"- timestamp: {_utc_now()}\n"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)

        if not passed:
            print("[FC CHECKPOINT] verify_corpus FAIL — halting harvest immediately.", flush=True)
            print(output, flush=True)

        return passed

    except Exception as exc:
        msg = f"[FC CHECKPOINT] exception running verify_corpus_full.py: {exc}"
        print(msg, flush=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(
                f"\n## CHECKPOINT @ {cumulative} rows\n"
                f"- verify_corpus: ERROR\n"
                f"- error: {exc}\n"
                f"- timestamp: {_utc_now()}\n"
            )
        return False


# ---------------------------------------------------------------------------
# QA checkpoint: gemini_verify_sample.py (advisory, ~$1 for n=25)
# ---------------------------------------------------------------------------

def _run_gemini_sample(root: str, log_path: str, cumulative: int, seed: int) -> None:
    """
    Run gemini_verify_sample.py --n 25 --seed <seed> via subprocess.
    Parses yes/no/uncertain counts and appends them to the checkpoint block in run-log.md.
    Advisory only — does NOT stop the harvest regardless of results.
    """
    script_path = os.path.join(root, "scripts", "gemini_verify_sample.py")
    print(
        f"[FC CHECKPOINT @ {cumulative} rows] running gemini_verify_sample.py --n 25 --seed {seed} ...",
        flush=True,
    )
    try:
        result = subprocess.run(
            ["uv", "run", "python", script_path, "--n", "25", "--seed", str(seed)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            cwd=root,
        )
        output = result.stdout + result.stderr

        # Extract yes/no/uncertain counts from summary lines like "  yes         : 22"
        counts: dict = {}
        for line in output.splitlines():
            for verdict in ("yes", "no", "uncertain", "error", "parse_error"):
                if line.strip().startswith(verdict):
                    parts = line.strip().split(":")
                    if len(parts) >= 2:
                        try:
                            counts[verdict] = int(parts[-1].strip())
                        except ValueError:
                            pass

        print(f"[FC CHECKPOINT @ {cumulative} rows] gemini sample counts: {counts}", flush=True)

        entry = (
            f"- gemini_sample (n=25, seed={seed}): "
            + " ".join(f"{k}={v}" for k, v in sorted(counts.items()))
            + f"\n- gemini_est_cost: ~${25 * 0.035:.2f}\n"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)

    except Exception as exc:
        msg = f"[FC CHECKPOINT] gemini_verify_sample exception: {exc}"
        print(msg, flush=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"- gemini_sample: ERROR ({exc})\n")


# ---------------------------------------------------------------------------
# Core: scrape one brand via Firecrawl
# ---------------------------------------------------------------------------

def _scrape_brand(
    slug: str,
    run_state: dict,
    paths: dict,
    led: dict,
    run_id: str,
    root: str,
) -> dict:
    """
    Scrape one brand page via Firecrawl, parse, write rows.

    Returns dict with keys:
        html_ok (bool), parsed (int), trusted (int), dup_skipped (int),
        backlog (int), rejected (int), credits_spent (int)
    """
    url = _BASE_URL.format(slug=slug)
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
    html = result.get("stdout", "")

    # A successful scrape has returncode 0 and non-trivial HTML
    if result["returncode"] != 0 or not html.strip():
        print(
            f"  [fc_harvest] {slug}: scrape failed (rc={result['returncode']}, "
            f"credits_spent={credits_spent})",
            flush=True,
        )
        return {
            "html_ok": False,
            "parsed": 0,
            "trusted": 0,
            "dup_skipped": 0,
            "backlog": 0,
            "rejected": 0,
            "credits_spent": credits_spent,
        }

    identities = parse_page(html, slug)
    source_url = url
    for idn in identities:
        idn["evidence_level"] = "verified_db"
        idn["source_url"] = source_url

    parsed_count = len(identities)

    if identities:
        counts = write_rows(identities, paths, led, run_id)
    else:
        counts = {"trusted": 0, "backlog": 0, "rejected": 0, "dup_skipped": 0}

    print(
        f"  [fc_harvest] {slug}: parsed={parsed_count} "
        f"trusted={counts['trusted']} dup={counts['dup_skipped']} "
        f"backlog={counts['backlog']} rejected={counts['rejected']} "
        f"credits_spent={credits_spent}",
        flush=True,
    )

    return {
        "html_ok": True,
        "parsed": parsed_count,
        "trusted": counts.get("trusted", 0),
        "dup_skipped": counts.get("dup_skipped", 0),
        "backlog": counts.get("backlog", 0),
        "rejected": counts.get("rejected", 0),
        "credits_spent": credits_spent,
    }


# ---------------------------------------------------------------------------
# Main harvest function
# ---------------------------------------------------------------------------

def harvest(root: str, run_state: dict, run_id: str = "upcitemdb_fc_001") -> dict:
    """
    Firecrawl-proxy harvest of all brands in BRAND_SLUGS.

    Args:
        root: tire-knowledge root directory
        run_state: mutable dict with 'run_credits_spent' (int), updated in place
        run_id: identifier for this run (written to CSV rows)

    Returns:
        dict with keys:
            brands_done_this_run, trusted_added, credits_spent,
            rows_per_credit, stopped_low_efficiency, audit_ok,
            brands_skipped, brands_missed, qa_aborted, _audit_errors
    """
    ledger_path = os.path.join(root, "coverage_ledger.json")
    log_path = os.path.join(root, "run-log.md")
    paths = {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }

    led = L.load_ledger(ledger_path)
    done_brands: set = load_harvested_brands(root)

    print(
        f"[fc_harvest] incremental: {len(done_brands)} brand(s) already done — will skip",
        flush=True,
    )

    totals = {"trusted": 0, "backlog": 0, "rejected": 0, "dup_skipped": 0}
    brands_done_this_run = 0
    brands_skipped = 0
    brands_missed = 0
    credits_spent_total = 0
    cumulative_trusted = 0
    qa_aborted = False
    stopped_low_efficiency = False
    brands_scraped_count = 0  # brands actually scraped (for warmup counting)
    checkpoint_seed_offset = 0  # varies the seed for each gemini sample

    for slug in BRAND_SLUGS:
        if should_skip(slug, done_brands):
            print(f"[fc_harvest] SKIP {slug} (already in harvested_brands.json)", flush=True)
            brands_skipped += 1
            continue

        print(f"[fc_harvest] scraping {slug} ...", flush=True)

        try:
            res = _scrape_brand(slug, run_state, paths, led, run_id, root)
        except RuntimeError as exc:
            # Firecrawl cap or kill switch — finalize cleanly
            print(f"[fc_harvest] Firecrawl cap/kill switch: {exc}", flush=True)
            break

        credits_spent_total += res["credits_spent"]
        brands_scraped_count += 1

        if not res["html_ok"]:
            brands_missed += 1
            # Do NOT mark done — retry next run
            continue

        trusted_this = res["trusted"]
        for k in ("trusted", "backlog", "rejected", "dup_skipped"):
            totals[k] += res.get(k, 0)

        # Mark brand done (>=0 rows after a successful scrape)
        done_brands.add(slug)
        save_harvested_brands(root, done_brands)
        brands_done_this_run += 1

        # Update cumulative and checkpoint tracking
        prev = cumulative_trusted
        cumulative_trusted += trusted_this

        # QA checkpoint every 2000 new trusted rows
        if crossed_2000(prev, cumulative_trusted):
            checkpoint_seed_offset += 1
            # Step 1: free full-corpus verification (STOP on fail)
            if not _run_verify_corpus(root, log_path, cumulative_trusted):
                qa_aborted = True
                break
            # Step 2: Gemini advisory sample (never stops harvest)
            _run_gemini_sample(
                root, log_path, cumulative_trusted,
                seed=42 + checkpoint_seed_offset,
            )

        # Efficiency floor check (after warmup of WARMUP_BRANDS scraped brands)
        if brands_scraped_count >= _WARMUP_BRANDS:
            rpc = cumulative_trusted / max(1, credits_spent_total)
            if rpc < _ROWS_PER_CREDIT_FLOOR:
                print(
                    f"[fc_harvest] EFFICIENCY FLOOR: rows_per_credit={rpc:.2f} < "
                    f"{_ROWS_PER_CREDIT_FLOOR} after {brands_scraped_count} brands "
                    f"({cumulative_trusted} trusted / {credits_spent_total} credits). Stopping.",
                    flush=True,
                )
                stopped_low_efficiency = True
                break

    # Persist ledger
    L.save_ledger(led, ledger_path)

    # Final audit
    audit_ok, audit_errors = audit(root)

    rows_per_credit = (
        cumulative_trusted / max(1, credits_spent_total)
        if credits_spent_total > 0 else 0.0
    )

    result = {
        "brands_done_this_run": brands_done_this_run,
        "trusted_added": cumulative_trusted,
        "credits_spent": credits_spent_total,
        "rows_per_credit": rows_per_credit,
        "stopped_low_efficiency": stopped_low_efficiency,
        "audit_ok": audit_ok,
        "brands_skipped": brands_skipped,
        "brands_missed": brands_missed,
        "qa_aborted": qa_aborted,
        "_audit_errors": audit_errors,
    }

    if qa_aborted:
        result["audit_ok"] = False

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    run_state = {"run_credits_spent": 0}
    run_id = "upcitemdb_fc_001"

    print(f"[upcitemdb_firecrawl_harvest] starting run_id={run_id}")
    print(f"[upcitemdb_firecrawl_harvest] root={_ROOT}")
    print(f"[upcitemdb_firecrawl_harvest] brands to check: {len(BRAND_SLUGS)}")
    print(f"[upcitemdb_firecrawl_harvest] efficiency floor: {_ROWS_PER_CREDIT_FLOOR} rows/credit (after {_WARMUP_BRANDS} brands warmup)")
    print(f"[upcitemdb_firecrawl_harvest] checkpoint every: {_CHECKPOINT_EVERY} trusted rows")
    print()

    result = harvest(_ROOT, run_state, run_id)

    print()
    print("=== FIRECRAWL HARVEST SUMMARY ===")
    for k in ("brands_done_this_run", "trusted_added", "credits_spent",
              "rows_per_credit", "stopped_low_efficiency", "audit_ok",
              "brands_skipped", "brands_missed", "qa_aborted"):
        print(f"  {k}: {result[k]}")

    print()
    if result["audit_ok"]:
        print("AUDIT PASS")
    else:
        print("AUDIT FAIL")
        for e in result["_audit_errors"]:
            print(f"  - {e}")

    sys.exit(0 if result["audit_ok"] else 1)
