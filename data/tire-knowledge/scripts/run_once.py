#!/usr/bin/env python3
"""
run_once.py — Orchestrator entry point for the tire barcode harvester.

One repeatable command that safely runs a harvest batch under credit caps,
with preflight + lock discipline + logging.

Usage:
    uv run python scripts/run_once.py [--max-credits N] [--preflight-only]

Gate 1 (preflight) verifies:
  (a) root directory is writable
  (b) firecrawl credits are readable (returns an int)
  (c) policy loads cleanly
  (d) kill switch is NOT active
  (e) harvest.lock: stale locks (>90 min) are reclaimed; fresh locks abort

Lock file: harvest.lock (JSON) at the harvester root.
Logs: current_run_progress.json + run-log.md
"""

import argparse
import csv
import json
import os
import sys

# ── Path bootstrap: ensure scripts/ is importable ─────────────────────────────
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DEFAULT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import firecrawl_client as FC
from collect_sources import collect
from harvest_tiresandwheels import harvest
from audit_corpus import audit
from validate import now_iso

# Public alias so callers can reference the default root.
ROOT = _ROOT_DEFAULT

# ---------------------------------------------------------------------------
# Lock helpers
# ---------------------------------------------------------------------------

_LOCK_FILE = "harvest.lock"
_STALE_MINUTES = 90  # A lock older than this is considered stale


def _lock_path(root: str) -> str:
    return os.path.join(root, _LOCK_FILE)


def _parse_iso(ts: str):
    """
    Parse an ISO-8601 UTC timestamp string like '2026-01-02T03:04:05Z'.
    Returns a float (POSIX seconds) or None on failure.
    """
    import re
    m = re.match(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$", ts.strip()
    )
    if not m:
        return None
    from datetime import datetime, timezone
    try:
        dt = datetime(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)),
            tzinfo=timezone.utc,
        )
        return dt.timestamp()
    except Exception:
        return None


def _lock_is_stale(lock_data: dict) -> bool:
    """
    Return True if the lock's last_heartbeat_at is >90 minutes old or unparseable.
    """
    import time
    ts_str = lock_data.get("last_heartbeat_at", "")
    ts = _parse_iso(ts_str)
    if ts is None:
        return True  # Unparseable → treat as stale
    age_minutes = (time.time() - ts) / 60.0
    return age_minutes > _STALE_MINUTES


def write_lock(root: str, run_id: str) -> None:
    """Write harvest.lock with run_id, started_at, last_heartbeat_at, process."""
    now = now_iso()
    lock_data = {
        "run_id": run_id,
        "started_at": now,
        "last_heartbeat_at": now,
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


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

def preflight(root: str) -> tuple:
    """
    Gate 1 preflight checks.

    Returns (ok: bool, checks: list[str]) where each string is a human-readable
    status line.  ok is False if ANY check fails.
    """
    checks = []
    ok = True

    # (a) Root writable
    try:
        _tmp = os.path.join(root, ".preflight_write_test")
        with open(_tmp, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(_tmp)
        checks.append("  [OK] root directory is writable")
    except Exception as exc:
        checks.append(f"  [FAIL] root not writable: {exc}")
        ok = False

    # (b) Credits readable
    try:
        credits = FC.get_remaining_credits(root)
        if not isinstance(credits, int):
            raise TypeError(f"expected int, got {type(credits).__name__}")
        checks.append(f"  [OK] firecrawl credits readable: {credits} remaining")
    except Exception as exc:
        checks.append(f"  [FAIL] cannot read firecrawl credits: {exc}")
        ok = False

    # (c) Policy loads
    try:
        policy = FC.load_policy(root)
        checks.append(
            f"  [OK] policy loaded: PER_RUN_CAP={policy.get('PER_RUN_CAP')}, "
            f"TOTAL_CAP={policy.get('TOTAL_CAP')}, "
            f"total_spent={policy.get('total_credits_spent', 0)}"
        )
    except Exception as exc:
        checks.append(f"  [FAIL] policy load failed: {exc}")
        ok = False

    # (d) Kill switch NOT active
    try:
        if FC.kill_switch_active(root):
            checks.append("  [FAIL] kill switch is ACTIVE — remove the stop file to proceed")
            ok = False
        else:
            checks.append("  [OK] kill switch not active")
    except Exception as exc:
        checks.append(f"  [FAIL] could not check kill switch: {exc}")
        ok = False

    # (e) Lock file check
    lock_file = _lock_path(root)
    if os.path.exists(lock_file):
        try:
            with open(lock_file, encoding="utf-8") as f:
                lock_data = json.load(f)
            if _lock_is_stale(lock_data):
                os.remove(lock_file)
                checks.append(
                    f"  [OK] reclaimed stale lock (run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')})"
                )
            else:
                checks.append(
                    f"  [FAIL] another run in progress (run_id={lock_data.get('run_id','?')}, "
                    f"last_heartbeat={lock_data.get('last_heartbeat_at','?')}) — "
                    "remove harvest.lock manually if the previous run crashed"
                )
                ok = False
        except Exception as exc:
            # Unparseable lock → reclaim it (treat as stale)
            try:
                os.remove(lock_file)
                checks.append(f"  [OK] reclaimed unparseable lock ({exc})")
            except Exception as rm_exc:
                checks.append(f"  [FAIL] lock exists but could not be read or removed: {rm_exc}")
                ok = False
    else:
        checks.append("  [OK] no lock file present")

    return ok, checks


# ---------------------------------------------------------------------------
# Queue helper
# ---------------------------------------------------------------------------

def _count_queued_rows(root: str) -> int:
    """Return number of rows in tire_model_queue.csv with status=='queued'."""
    queue_path = os.path.join(root, "tire_model_queue.csv")
    if not os.path.exists(queue_path):
        return 0
    try:
        with open(queue_path, newline="", encoding="utf-8") as f:
            return sum(1 for row in csv.DictReader(f) if row.get("status") == "queued")
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Run-id helper
# ---------------------------------------------------------------------------

def _make_run_id() -> str:
    """
    Derive a run_id like 'run_YYYYMMDD_HHMMSS' from now_iso().
    Does not call datetime directly — uses validate.now_iso() then strips
    the non-digit characters.
    """
    iso = now_iso()  # e.g. '2026-06-22T18:35:12Z'
    # Extract date and time digits: '20260622' and '183512'
    digits = iso.replace("-", "").replace("T", "").replace(":", "").replace("Z", "")
    # digits is now '20260622183512' (14 chars)
    date_part = digits[:8]
    time_part = digits[8:14]
    return f"run_{date_part}_{time_part}"


# ---------------------------------------------------------------------------
# Run-log helper
# ---------------------------------------------------------------------------

def _append_run_log(root: str, run_id: str, result: dict, audit_ok: bool) -> None:
    """Append a Markdown block to run-log.md."""
    log_path = os.path.join(root, "run-log.md")
    audit_label = "AUDIT PASS" if audit_ok else "AUDIT FAIL"
    block = (
        f"\n## Run: {run_id}\n"
        f"- models_scraped: {result.get('models_scraped', 0)}\n"
        f"- trusted_added: {result.get('trusted_added', 0)}\n"
        f"- dup_skipped: {result.get('dup_skipped', 0)}\n"
        f"- credits_spent: {result.get('credits_spent', 0)}\n"
        f"- rows_per_credit: {result.get('rows_per_credit', 0)}\n"
        f"- remaining_credits: {result.get('remaining_credits', -1)}\n"
        f"- audit: {audit_label}\n"
        f"- timestamp: {now_iso()}\n"
    )
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(block)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(max_credits: int = 5, preflight_only: bool = False, root: str = ROOT) -> None:
    """
    Orchestrate one harvest batch.

    Steps:
      1. Preflight (Gate 1) — abort with exit(1) if any check fails.
      2. If --preflight-only, exit(0) (no credits).
      3. Acquire lock.
      4. Refill queue if empty.
      5. Harvest.
      6. Audit.
      7. Write current_run_progress.json and append run-log.md block.
      8. Release lock (always — even on crash).
      9. Print summary.
    """
    # ── 1. Preflight ──────────────────────────────────────────────────────────
    print("=== Preflight checks ===")
    ok, checks = preflight(root)
    for line in checks:
        print(line)

    if not ok:
        print("\n[ABORT] Preflight failed. Fix the issues above and retry.")
        sys.exit(1)

    print("\n[OK] All preflight checks passed.")

    # ── 2. Preflight-only exit ─────────────────────────────────────────────────
    if preflight_only:
        print("[INFO] --preflight-only flag set. Exiting without spending credits.")
        sys.exit(0)

    # ── 3. Acquire lock ───────────────────────────────────────────────────────
    run_id = _make_run_id()
    write_lock(root, run_id)
    print(f"\n[INFO] Lock acquired. run_id={run_id}")

    result = {}
    audit_ok = False

    try:
        # ── 4. Refill queue if empty ───────────────────────────────────────────
        queued = _count_queued_rows(root)
        if queued == 0:
            print("[INFO] Queue is empty — running collect() to refill (free).")
            collect_result = collect(root)
            print(f"[INFO] collect() result: {collect_result}")
        else:
            print(f"[INFO] Queue has {queued} rows ready.")

        # ── 5. Harvest ────────────────────────────────────────────────────────
        run_state = {"run_credits_spent": 0}
        print(f"\n[INFO] Starting harvest: max_credits={max_credits}")
        result = harvest(max_credits, root, run_state, run_id)
        print(f"[INFO] Harvest complete: {result}")

        # ── 6. Audit ──────────────────────────────────────────────────────────
        audit_ok, audit_errs = audit(root)
        if audit_ok:
            print("\n[OK] AUDIT PASS")
        else:
            print(f"\n[WARN] AUDIT FAIL: {audit_errs}")

        # ── 7. Write progress + log ───────────────────────────────────────────
        progress = {
            "run_id": run_id,
            "result": result,
            "audit_ok": audit_ok,
            "timestamp": now_iso(),
        }
        progress_path = os.path.join(root, "current_run_progress.json")
        with open(progress_path, "w", encoding="utf-8") as f:
            json.dump(progress, f, indent=2)
            f.write("\n")

        _append_run_log(root, run_id, result, audit_ok)
        print(f"[INFO] run-log.md updated. current_run_progress.json written.")

    finally:
        # ── 8. Release lock ───────────────────────────────────────────────────
        release_lock(root)
        print(f"[INFO] Lock released (harvest.lock removed).")

    # ── 9. Print summary ──────────────────────────────────────────────────────
    summary = {
        "run_id": run_id,
        **result,
        "audit_ok": audit_ok,
    }
    print("\n=== Run summary ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Windows stdout utf-8 guard
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Run one harvest batch under credit caps."
    )
    parser.add_argument(
        "--max-credits",
        type=int,
        default=5,
        help="Maximum Firecrawl credits to spend this run (default: 5)",
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="Run preflight checks only; do not harvest (spends 0 credits)",
    )
    args = parser.parse_args()

    main(max_credits=args.max_credits, preflight_only=args.preflight_only)
