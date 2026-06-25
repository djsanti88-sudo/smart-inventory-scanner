"""
test_run_once.py — Unit tests for run_once.py (Gate 1 / preflight).

NO network calls. NO Firecrawl credits. All external calls are mocked.

Tests:
  - Stale lock detection (>90 min old last_heartbeat_at) -> reclaimed, preflight OK
  - Fresh lock detection -> preflight returns ok=False ("in progress")
  - Unparseable lock -> treated as stale, reclaimed
  - write_lock / release_lock round-trip
  - _make_run_id format
  - preflight all-pass (mocked credits + policy + no lock)
"""

import json
import os
import sys
import time
import tempfile
from datetime import datetime, timezone, timedelta
from unittest import mock

import pytest

# ── Path bootstrap ─────────────────────────────────────────────────────────────
SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import run_once as ro


# ---------------------------------------------------------------------------
# Shared fixture factory
# ---------------------------------------------------------------------------

def _make_temp_root(tmp_path: str, *, policy_overrides: dict = None, kill_switch: bool = False) -> str:
    """
    Create a minimal harvester root in tmp_path with:
      - firecrawl_policy.json
      - optionally .firecrawl_STOP (kill switch)
    """
    policy = {
        "TOTAL_CAP": 50,
        "PER_RUN_CAP": 15,
        "ROWS_PER_CREDIT_FLOOR": None,
        "STEALTH_ALLOWED": False,
        "KILL_SWITCH_FILE": ".firecrawl_STOP",
        "total_credits_spent": 0,
    }
    if policy_overrides:
        policy.update(policy_overrides)

    policy_path = os.path.join(tmp_path, "firecrawl_policy.json")
    with open(policy_path, "w", encoding="utf-8") as f:
        json.dump(policy, f)

    if kill_switch:
        stop_path = os.path.join(tmp_path, ".firecrawl_STOP")
        with open(stop_path, "w", encoding="utf-8") as f:
            f.write("stop")

    return tmp_path


def _iso_minutes_ago(minutes: float) -> str:
    """Return an ISO-8601 UTC timestamp that was `minutes` ago."""
    dt = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_lock_data(root: str, run_id: str, last_heartbeat_at: str) -> None:
    """Write a harvest.lock file with the given data."""
    lock_data = {
        "run_id": run_id,
        "started_at": last_heartbeat_at,
        "last_heartbeat_at": last_heartbeat_at,
        "process": 99999,
    }
    with open(os.path.join(root, "harvest.lock"), "w", encoding="utf-8") as f:
        json.dump(lock_data, f)


# ---------------------------------------------------------------------------
# Test: stale lock is reclaimed during preflight
# ---------------------------------------------------------------------------

def test_preflight_reclaims_stale_lock(tmp_path):
    """
    A lock with last_heartbeat_at >90 minutes ago is stale.
    Preflight must reclaim it (delete the file) and report OK.
    """
    root = _make_temp_root(str(tmp_path))
    _write_lock_data(root, "old_run", _iso_minutes_ago(120))  # 120 min old = stale

    # Mock get_remaining_credits to return a valid int so other checks pass.
    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is True, f"Expected ok=True after stale lock reclaim, got False. Checks:\n{checks}"

    # Lock file must be gone after reclaim
    assert not os.path.exists(os.path.join(root, "harvest.lock")), \
        "harvest.lock should have been deleted by preflight"

    # Check lines must mention 'reclaim'
    lock_checks = [c for c in checks if "reclaim" in c.lower()]
    assert lock_checks, f"Expected a 'reclaim' message in checks. Got:\n{checks}"


# ---------------------------------------------------------------------------
# Test: fresh lock blocks preflight
# ---------------------------------------------------------------------------

def test_preflight_fails_on_fresh_lock(tmp_path):
    """
    A lock with last_heartbeat_at <90 minutes ago is fresh.
    Preflight must return ok=False with a message indicating 'in progress'.
    """
    root = _make_temp_root(str(tmp_path))
    _write_lock_data(root, "active_run", _iso_minutes_ago(5))  # 5 min old = fresh

    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is False, f"Expected ok=False for fresh lock, got True. Checks:\n{checks}"

    # Lock file must still exist (not deleted for fresh locks)
    assert os.path.exists(os.path.join(root, "harvest.lock")), \
        "harvest.lock should NOT have been deleted for a fresh lock"

    # Check line must mention 'in progress'
    fail_checks = [c for c in checks if "in progress" in c.lower() or "[fail]" in c.lower()]
    assert fail_checks, f"Expected a '[FAIL]' or 'in progress' message. Got:\n{checks}"


# ---------------------------------------------------------------------------
# Test: unparseable lock is reclaimed
# ---------------------------------------------------------------------------

def test_preflight_reclaims_unparseable_lock(tmp_path):
    """
    A lock file with corrupt JSON is treated as stale and reclaimed.
    Preflight must return ok=True (lock removed).
    """
    root = _make_temp_root(str(tmp_path))
    lock_path = os.path.join(root, "harvest.lock")
    with open(lock_path, "w", encoding="utf-8") as f:
        f.write("NOT VALID JSON {{{")

    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is True, f"Expected ok=True after unparseable lock reclaim. Checks:\n{checks}"
    assert not os.path.exists(lock_path), "harvest.lock should be deleted after unparseable reclaim"

    reclaim_checks = [c for c in checks if "reclaim" in c.lower() or "[ok]" in c.lower()]
    assert reclaim_checks, f"Expected reclaim or [OK] message. Checks:\n{checks}"


# ---------------------------------------------------------------------------
# Test: no lock file — preflight passes the lock check
# ---------------------------------------------------------------------------

def test_preflight_passes_with_no_lock(tmp_path):
    """
    When no lock file exists, the lock check must report OK.
    """
    root = _make_temp_root(str(tmp_path))

    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is True, f"Expected ok=True with no lock. Checks:\n{checks}"
    no_lock_checks = [c for c in checks if "no lock" in c.lower()]
    assert no_lock_checks, f"Expected 'no lock' check line. Checks:\n{checks}"


# ---------------------------------------------------------------------------
# Test: kill switch active -> preflight fails
# ---------------------------------------------------------------------------

def test_preflight_fails_when_kill_switch_active(tmp_path):
    """
    When the kill switch file is present, preflight must return ok=False.
    """
    root = _make_temp_root(str(tmp_path), kill_switch=True)

    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is False, f"Expected ok=False with kill switch active. Checks:\n{checks}"
    kill_checks = [c for c in checks if "kill switch" in c.lower()]
    assert kill_checks, f"Expected kill-switch message in checks. Checks:\n{checks}"


# ---------------------------------------------------------------------------
# Test: credits unreadable -> preflight fails
# ---------------------------------------------------------------------------

def test_preflight_fails_when_credits_unreadable(tmp_path):
    """
    If get_remaining_credits raises, preflight must return ok=False.
    """
    root = _make_temp_root(str(tmp_path))

    with mock.patch(
        "firecrawl_client.get_remaining_credits",
        side_effect=RuntimeError("cannot parse Credits line"),
    ):
        ok, checks = ro.preflight(root)

    assert ok is False, f"Expected ok=False when credits unreadable. Checks:\n{checks}"
    fail_checks = [c for c in checks if "[fail]" in c.lower()]
    assert fail_checks, f"Expected [FAIL] in checks. Checks:\n{checks}"


# ---------------------------------------------------------------------------
# Test: write_lock / release_lock round-trip
# ---------------------------------------------------------------------------

def test_write_and_release_lock(tmp_path):
    """write_lock creates harvest.lock; release_lock removes it."""
    root = str(tmp_path)
    ro.write_lock(root, "test_run_001")

    lock_path = os.path.join(root, "harvest.lock")
    assert os.path.exists(lock_path), "harvest.lock should exist after write_lock"

    with open(lock_path, encoding="utf-8") as f:
        data = json.load(f)

    assert data["run_id"] == "test_run_001"
    assert "started_at" in data
    assert "last_heartbeat_at" in data
    assert "process" in data

    ro.release_lock(root)
    assert not os.path.exists(lock_path), "harvest.lock should be gone after release_lock"


def test_release_lock_noop_when_no_lock(tmp_path):
    """release_lock must not raise if harvest.lock does not exist."""
    root = str(tmp_path)
    ro.release_lock(root)  # Should not raise


# ---------------------------------------------------------------------------
# Test: _make_run_id format
# ---------------------------------------------------------------------------

def test_make_run_id_format():
    """run_id must match 'run_YYYYMMDD_HHMMSS'."""
    import re
    run_id = ro._make_run_id()
    assert re.match(r"^run_\d{8}_\d{6}$", run_id), \
        f"run_id '{run_id}' does not match 'run_YYYYMMDD_HHMMSS'"


# ---------------------------------------------------------------------------
# Test: _lock_is_stale helper
# ---------------------------------------------------------------------------

def test_lock_is_stale_with_old_timestamp():
    """A heartbeat 120 minutes ago is stale."""
    data = {"last_heartbeat_at": _iso_minutes_ago(120)}
    assert ro._lock_is_stale(data) is True


def test_lock_is_stale_with_fresh_timestamp():
    """A heartbeat 5 minutes ago is NOT stale."""
    data = {"last_heartbeat_at": _iso_minutes_ago(5)}
    assert ro._lock_is_stale(data) is False


def test_lock_is_stale_with_bad_timestamp():
    """An unparseable timestamp is treated as stale."""
    data = {"last_heartbeat_at": "not-a-date"}
    assert ro._lock_is_stale(data) is True


def test_lock_is_stale_with_missing_key():
    """A missing last_heartbeat_at is treated as stale."""
    assert ro._lock_is_stale({}) is True


# ---------------------------------------------------------------------------
# Test: preflight all-pass (complete happy path)
# ---------------------------------------------------------------------------

def test_preflight_all_pass_happy_path(tmp_path):
    """
    With no lock, valid policy, credits readable, kill switch off:
    preflight must return ok=True with 5 check lines all containing [OK].
    """
    root = _make_temp_root(str(tmp_path))

    with mock.patch("firecrawl_client.get_remaining_credits", return_value=150):
        ok, checks = ro.preflight(root)

    assert ok is True, f"Expected ok=True on happy path. Checks:\n{checks}"
    # Every line should be an [OK] line
    fail_lines = [c for c in checks if "[fail]" in c.lower()]
    assert not fail_lines, f"Unexpected [FAIL] lines on happy path: {fail_lines}"
    # Should have 5 check lines (a through e)
    assert len(checks) == 5, f"Expected 5 check lines, got {len(checks)}: {checks}"
