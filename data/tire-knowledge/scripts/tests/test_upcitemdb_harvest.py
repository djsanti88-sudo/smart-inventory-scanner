"""
test_upcitemdb_harvest.py — Tests for upcitemdb_harvest.harvest() and helpers.

ALL OFFLINE — no network calls. fetch() is monkeypatched to return the
saved fixture for slug "fortune" and None for all other slugs.

Tests:
  1. harvest() with a temp root returns trusted_added > 0 and audit_ok True.
  2. Every written row has evidence_level == "verified_db".
  3. harvest() is idempotent: second run returns trusted_added == 0, dup_skipped > 0.
  4. crossed_1000() triggers at the right cumulative boundary counts.
"""

import csv
import json
import os
import sys
import tempfile

import pytest

# Make scripts/ importable
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import upcitemdb_harvest as H

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "upcitemdb_fortune.html")


def _load_fixture() -> str:
    with open(FIXTURE_PATH, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Helpers to set up a minimal temp corpus root
# ---------------------------------------------------------------------------

def _make_temp_root(tmp_dir: str) -> str:
    """
    Create the minimum files harvest() needs in tmp_dir:
      - tire_corpus_flat.csv  (header-only)
      - tire_identifiers.csv  (header-only)
      - tire_size_aliases.csv (empty)
      - coverage_ledger.json  (does not need to pre-exist; load_ledger handles missing)
    Returns tmp_dir.
    """
    # tire_corpus_flat.csv — header only
    flat_path = os.path.join(tmp_dir, "tire_corpus_flat.csv")
    with open(flat_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    # tire_identifiers.csv — header only
    ids_path = os.path.join(tmp_dir, "tire_identifiers.csv")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")

    # tire_size_aliases.csv — empty (write_rows doesn't read it, just needs path)
    sz_path = os.path.join(tmp_dir, "tire_size_aliases.csv")
    with open(sz_path, "w", encoding="utf-8") as f:
        pass

    return tmp_dir


# ---------------------------------------------------------------------------
# Fixture: monkeypatch fetch() so only "fortune" returns HTML
# ---------------------------------------------------------------------------

@pytest.fixture()
def patched_harvest(monkeypatch):
    """
    Patch upcitemdb_harvest.fetch so:
      - slug == "fortune"  -> returns the saved fixture HTML
      - any other slug     -> returns None  (simulates miss / 404)

    Also temporarily replace BRAND_SLUGS with ["fortune"] so the harvest
    loop only runs one brand, keeping the test fast and deterministic.
    """
    fixture_html = _load_fixture()

    def _fake_fetch(slug: str):
        if slug == "fortune":
            return fixture_html
        return None

    monkeypatch.setattr(H, "fetch", _fake_fetch)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune"])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_harvest_trusted_added_and_audit_ok(patched_harvest, tmp_path):
    """harvest() should add trusted rows and pass audit in a clean temp root."""
    root = _make_temp_root(str(tmp_path))
    result = H.harvest(root)

    assert result["trusted_added"] > 0, (
        f"Expected trusted_added > 0, got {result['trusted_added']}. "
        f"brands_hit={result['brands_hit']} products_parsed={result['products_parsed']}"
    )
    assert result["audit_ok"] is True, (
        f"audit_ok is False. Errors: {result['_audit_errors']}"
    )
    assert result["brands_hit"] == 1
    assert result["brands_missed"] == 0


def test_harvest_all_rows_have_verified_db_evidence(patched_harvest, tmp_path):
    """Every trusted row written to flat CSV must have evidence_level == 'verified_db'."""
    root = _make_temp_root(str(tmp_path))
    H.harvest(root)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) > 0, "No rows written to flat CSV"
    for row in rows:
        assert row["evidence_level"] == "verified_db", (
            f"Row has evidence_level={row['evidence_level']!r}, expected 'verified_db'. "
            f"barcode={row['barcode']}"
        )


def test_harvest_idempotent(patched_harvest, tmp_path):
    """
    Running harvest twice: first adds rows, second skips the brand entirely
    via incremental logic (brand is already in harvested_brands.json).
    """
    root = _make_temp_root(str(tmp_path))

    r1 = H.harvest(root)
    assert r1["trusted_added"] > 0, "First run should add rows"

    r2 = H.harvest(root)
    assert r2["trusted_added"] == 0, "Second run should add 0 new rows"
    # With incremental logic, the second run skips via harvested_brands.json
    # rather than re-fetching and deduplicating.
    assert r2["brands_skipped"] == 1, (
        f"Second run should skip 1 brand via incremental, got brands_skipped={r2['brands_skipped']}"
    )
    assert r2["audit_ok"] is True, f"audit_ok False after second run: {r2['_audit_errors']}"


def test_harvest_miss_slug_counted(monkeypatch, tmp_path):
    """A slug that returns None (HTTP miss) increments brands_missed."""
    monkeypatch.setattr(H, "fetch", lambda slug: None)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune", "goodyear"])

    root = _make_temp_root(str(tmp_path))
    result = H.harvest(root)

    assert result["brands_hit"] == 0
    assert result["brands_missed"] == 2
    assert result["trusted_added"] == 0
    # Audit must still pass (empty corpus is valid — ledger count matches CSV count = 0)
    assert result["audit_ok"] is True, f"audit errors: {result['_audit_errors']}"


def test_harvest_source_url_set_correctly(patched_harvest, tmp_path):
    """Every trusted row's source_url must be the upcitemdb brand page URL."""
    root = _make_temp_root(str(tmp_path))
    H.harvest(root)

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) > 0
    expected_url = "https://www.upcitemdb.com/info-fortune_tires"
    for row in rows:
        assert row["source_url"] == expected_url, (
            f"source_url={row['source_url']!r}, expected {expected_url!r}"
        )


# ---------------------------------------------------------------------------
# crossed_1000 unit tests
# ---------------------------------------------------------------------------

def test_crossed_1000_exact_boundary():
    """Accumulating to exactly 1000 from below triggers a checkpoint."""
    assert H.crossed_1000(0, 1000) is True


def test_crossed_1000_crosses_over():
    """Going from 999 to 1001 crosses the 1000 boundary."""
    assert H.crossed_1000(999, 1001) is True


def test_crossed_1000_large_jump_crosses_2000():
    """Jumping from 1500 to 2100 crosses the 2000 boundary."""
    assert H.crossed_1000(1500, 2100) is True


def test_crossed_1000_same_band_no_trigger():
    """Staying within the same 1000-band does NOT trigger."""
    assert H.crossed_1000(1000, 1500) is False


def test_crossed_1000_below_first_boundary_no_trigger():
    """500 -> 800 does not cross any 1000 boundary."""
    assert H.crossed_1000(500, 800) is False


def test_crossed_1000_zero_delta_no_trigger():
    """prev == now should never trigger."""
    assert H.crossed_1000(1000, 1000) is False


def test_crossed_1000_decreasing_no_trigger():
    """now < prev (shouldn't happen in practice) must not trigger."""
    assert H.crossed_1000(2000, 1500) is False


def test_crossed_1000_multiple_boundaries_triggers():
    """
    A single big jump from 0 to 3500 crosses boundaries at 1000, 2000, 3000.
    crossed_1000 only checks whether at least one boundary was crossed.
    """
    assert H.crossed_1000(0, 3500) is True


def test_crossed_1000_at_exactly_2000_from_1999():
    """1999 -> 2000 crosses the 2000 mark."""
    assert H.crossed_1000(1999, 2000) is True


def test_crossed_1000_at_exactly_1000_from_1000():
    """1000 -> 1000 (no change) must not trigger (equal values)."""
    assert H.crossed_1000(1000, 1000) is False
