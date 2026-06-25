"""
test_upcitemdb_fc_harvest.py — Tests for upcitemdb_firecrawl_harvest.

ALL OFFLINE — no network calls, no Firecrawl credits.
firecrawl_client.call is monkeypatched throughout.

Tests:
  1. Happy path: fixture HTML returned with credits_spent=1; assert trusted rows
     written with evidence_level=verified_db, rows_per_credit computed correctly,
     and harvested_brands.json updated.
  2. Efficiency floor stop: empty page with credits_spent=1 per brand; after
     warmup (5 brands) rows/credit < 8 -> stopped_low_efficiency=True.
  3. Unit-test crossed_2000 boundary helper.
  4. Firecrawl RuntimeError (cap/kill switch) caught cleanly — harvest finalizes
     without re-raising.
  5. Incremental skip: brand already in harvested_brands.json is skipped without
     calling firecrawl_client.call.
"""

import csv
import json
import os
import sys

import pytest

# Make scripts/ importable
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import upcitemdb_firecrawl_harvest as FCH
import firecrawl_client

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "upcitemdb_fortune.html")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_fixture() -> str:
    with open(FIXTURE_PATH, encoding="utf-8") as f:
        return f.read()


def _make_temp_root(tmp_dir: str) -> str:
    """
    Create the minimum files harvest() needs:
      - tire_corpus_flat.csv  (header-only)
      - tire_identifiers.csv  (header-only)
      - tire_size_aliases.csv (empty)
      - firecrawl_policy.json (required by firecrawl_client.call)
    """
    # tire_corpus_flat.csv
    flat_path = os.path.join(tmp_dir, "tire_corpus_flat.csv")
    with open(flat_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    # tire_identifiers.csv
    ids_path = os.path.join(tmp_dir, "tire_identifiers.csv")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")

    # tire_size_aliases.csv
    sz_path = os.path.join(tmp_dir, "tire_size_aliases.csv")
    with open(sz_path, "w", encoding="utf-8") as f:
        pass

    # firecrawl_policy.json — generous caps so tests never hit them
    policy = {
        "TOTAL_CAP": 100000,
        "PER_RUN_CAP": 50000,
        "ROWS_PER_CREDIT_FLOOR": 8,
        "STEALTH_ALLOWED": False,
        "KILL_SWITCH_FILE": ".firecrawl_STOP",
        "total_credits_spent": 0,
    }
    with open(os.path.join(tmp_dir, "firecrawl_policy.json"), "w", encoding="utf-8") as f:
        json.dump(policy, f, indent=2)

    return tmp_dir


# ---------------------------------------------------------------------------
# Test 1: Happy path
# ---------------------------------------------------------------------------

def test_happy_path_trusted_rows_and_harvested_brands(monkeypatch, tmp_path):
    """
    Monkeypatch firecrawl_client.call to return fixture HTML with credits_spent=1.
    Run harvest over ["fortune"] brand only.

    Assert:
      - trusted_added > 0
      - rows_per_credit computed as trusted_added / 1
      - harvested_brands.json contains "fortune"
      - stopped_low_efficiency is False
      - audit_ok is True
    """
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {
            "returncode": 0,
            "stdout": fixture_html,
            "stderr": "",
            "credits_spent": 1,
        }

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_001")

    assert result["trusted_added"] > 0, (
        f"Expected trusted_added > 0, got {result['trusted_added']}"
    )
    assert result["credits_spent"] == 1, (
        f"Expected credits_spent=1, got {result['credits_spent']}"
    )
    expected_rpc = result["trusted_added"] / 1
    assert abs(result["rows_per_credit"] - expected_rpc) < 0.001, (
        f"rows_per_credit={result['rows_per_credit']!r} != {expected_rpc}"
    )
    assert result["stopped_low_efficiency"] is False
    assert result["audit_ok"] is True, f"audit errors: {result['_audit_errors']}"
    assert result["brands_done_this_run"] == 1

    # harvested_brands.json must contain "fortune"
    done = FCH.load_harvested_brands(root)
    assert "fortune" in done, f"'fortune' not in harvested_brands.json: {done}"


def test_happy_path_all_rows_have_verified_db_evidence(monkeypatch, tmp_path):
    """Every trusted row written to flat CSV must have evidence_level='verified_db'."""
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": fixture_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    FCH.harvest(root, run_state, run_id="test_fc_001")

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) > 0, "No rows written to flat CSV"
    for row in rows:
        assert row["evidence_level"] == "verified_db", (
            f"Row has evidence_level={row['evidence_level']!r}, barcode={row['barcode']}"
        )


def test_happy_path_source_url_set_correctly(monkeypatch, tmp_path):
    """Every trusted row's source_url must be the upcitemdb brand page URL."""
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": fixture_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    FCH.harvest(root, run_state, run_id="test_fc_001")

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) > 0
    expected_url = "https://www.upcitemdb.com/info-fortune_tires"
    for row in rows:
        assert row["source_url"] == expected_url, (
            f"source_url={row['source_url']!r}, expected {expected_url!r}"
        )


def test_happy_path_rows_per_credit_multiple_brands(monkeypatch, tmp_path):
    """
    With two brands both returning fixture HTML and credits_spent=1 each:
    rows_per_credit == trusted_added / 2.
    """
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    call_count = {"n": 0}

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count["n"] += 1
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": fixture_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    # Use two different slugs; "fortune" fixture will parse for both
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune", "ironman"])

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_002")

    assert call_count["n"] == 2, f"Expected 2 calls, got {call_count['n']}"
    assert result["credits_spent"] == 2
    # rows_per_credit = trusted_added / 2 (some may be dups from second brand)
    # Just verify it's computed correctly from the reported values
    expected_rpc = result["trusted_added"] / max(1, result["credits_spent"])
    assert abs(result["rows_per_credit"] - expected_rpc) < 0.001


# ---------------------------------------------------------------------------
# Test 2: Efficiency floor stop
# ---------------------------------------------------------------------------

def test_efficiency_floor_stops_after_warmup(monkeypatch, tmp_path):
    """
    Monkeypatch firecrawl_client.call to return empty HTML with credits_spent=1.
    After WARMUP_BRANDS (5) scraped brands, rows/credit will be 0 < 8.
    Harvest must stop with stopped_low_efficiency=True.
    """
    root = _make_temp_root(str(tmp_path))
    empty_html = "<html><body><h1>Fortune Tires</h1></body></html>"

    call_count = {"n": 0}

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count["n"] += 1
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": empty_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    # Provide enough brands to pass warmup (5) and trigger the check
    brands = ["fortune", "ironman", "hercules", "mastercraft", "sumitomo", "laufenn", "kenda"]
    monkeypatch.setattr(FCH, "BRAND_SLUGS", brands)

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_floor")

    assert result["stopped_low_efficiency"] is True, (
        f"Expected stopped_low_efficiency=True, got {result['stopped_low_efficiency']}"
    )
    # Should have stopped after exactly WARMUP_BRANDS calls (the 5th brand triggers the check)
    assert call_count["n"] == FCH._WARMUP_BRANDS, (
        f"Expected {FCH._WARMUP_BRANDS} calls before stop, got {call_count['n']}"
    )
    assert result["trusted_added"] == 0


def test_efficiency_floor_not_triggered_before_warmup(monkeypatch, tmp_path):
    """
    Fewer than WARMUP_BRANDS (5) brands scraped — efficiency floor must NOT trigger
    even if rows/credit is 0.
    """
    root = _make_temp_root(str(tmp_path))
    empty_html = "<html><body><h1>No products</h1></body></html>"

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": empty_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    # Only 3 brands — below warmup threshold
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune", "ironman", "hercules"])

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_nowarmup")

    assert result["stopped_low_efficiency"] is False, (
        "Should not trigger efficiency floor before warmup"
    )


def test_efficiency_floor_not_triggered_when_yield_is_high(monkeypatch, tmp_path):
    """
    When rows/credit >= 8 after warmup, stopped_low_efficiency must be False.
    """
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()  # many rows

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": fixture_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    # Enough brands to exceed warmup; fixture gives many rows per brand
    brands = ["fortune", "ironman", "hercules", "mastercraft", "sumitomo"]
    monkeypatch.setattr(FCH, "BRAND_SLUGS", brands)

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_highyield")

    assert result["stopped_low_efficiency"] is False, (
        f"Should not stop: rows_per_credit={result['rows_per_credit']}"
    )
    assert result["rows_per_credit"] >= FCH._ROWS_PER_CREDIT_FLOOR


# ---------------------------------------------------------------------------
# Test 3: crossed_2000 boundary helper
# ---------------------------------------------------------------------------

def test_crossed_2000_exact_boundary():
    """0 -> 2000 crosses the 2000 mark."""
    assert FCH.crossed_2000(0, 2000) is True


def test_crossed_2000_crosses_over():
    """1999 -> 2001 crosses the 2000 boundary."""
    assert FCH.crossed_2000(1999, 2001) is True


def test_crossed_2000_large_jump_crosses_4000():
    """3500 -> 4100 crosses the 4000 boundary."""
    assert FCH.crossed_2000(3500, 4100) is True


def test_crossed_2000_same_band_no_trigger():
    """2000 -> 3500 stays in band 2000-3999 — no trigger."""
    assert FCH.crossed_2000(2000, 3500) is False


def test_crossed_2000_below_first_boundary_no_trigger():
    """500 -> 1800 does not cross any 2000 boundary."""
    assert FCH.crossed_2000(500, 1800) is False


def test_crossed_2000_zero_delta_no_trigger():
    """prev == now must not trigger."""
    assert FCH.crossed_2000(2000, 2000) is False


def test_crossed_2000_decreasing_no_trigger():
    """now < prev must not trigger."""
    assert FCH.crossed_2000(4000, 2000) is False


def test_crossed_2000_multiple_boundaries():
    """0 -> 5000 crosses 2000 and 4000 — True."""
    assert FCH.crossed_2000(0, 5000) is True


def test_crossed_2000_exactly_at_4000_from_3999():
    """3999 -> 4000 crosses 4000."""
    assert FCH.crossed_2000(3999, 4000) is True


def test_crossed_2000_at_2000_from_2000():
    """2000 -> 2000 (no change) must not trigger."""
    assert FCH.crossed_2000(2000, 2000) is False


# ---------------------------------------------------------------------------
# Test 4: Firecrawl RuntimeError caught cleanly
# ---------------------------------------------------------------------------

def test_firecrawl_runtime_error_caught_cleanly(monkeypatch, tmp_path):
    """
    If firecrawl_client.call raises RuntimeError (cap/kill switch), harvest
    must NOT re-raise — it finalizes and returns a result dict with audit_ok.
    """
    root = _make_temp_root(str(tmp_path))

    def _raise_cap(*args, **kwargs):
        raise RuntimeError("per-run cap exceeded: test")

    monkeypatch.setattr(firecrawl_client, "call", _raise_cap)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    # Must not raise
    result = FCH.harvest(root, run_state, run_id="test_fc_cap")

    assert isinstance(result, dict), "harvest() must return a dict even on cap error"
    assert "audit_ok" in result
    assert result["trusted_added"] == 0
    assert result["brands_done_this_run"] == 0


# ---------------------------------------------------------------------------
# Test 5: Incremental skip
# ---------------------------------------------------------------------------

def test_incremental_skip_brand_already_done(monkeypatch, tmp_path):
    """
    A brand already in harvested_brands.json must be skipped without calling
    firecrawl_client.call.
    """
    root = _make_temp_root(str(tmp_path))

    # Pre-seed harvested_brands.json
    FCH.save_harvested_brands(root, {"fortune"})

    call_count = {"n": 0}

    def _should_not_be_called(*args, **kwargs):
        call_count["n"] += 1
        return {"returncode": 0, "stdout": "", "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _should_not_be_called)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_skip")

    assert call_count["n"] == 0, (
        f"firecrawl_client.call was called {call_count['n']} times for a skipped brand"
    )
    assert result["brands_skipped"] == 1
    assert result["brands_done_this_run"] == 0
    assert result["trusted_added"] == 0


def test_incremental_idempotent_second_run(monkeypatch, tmp_path):
    """
    Run harvest twice. Second run must skip the brand (already in harvested_brands.json)
    and not call firecrawl_client.call again.
    """
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    call_count = {"n": 0}

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count["n"] += 1
        run_state["run_credits_spent"] += 1
        return {"returncode": 0, "stdout": fixture_html, "stderr": "", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state1 = {"run_credits_spent": 0}
    r1 = FCH.harvest(root, run_state1, run_id="test_fc_idem_1")
    assert r1["trusted_added"] > 0, "First run should add rows"
    assert call_count["n"] == 1

    run_state2 = {"run_credits_spent": 0}
    r2 = FCH.harvest(root, run_state2, run_id="test_fc_idem_2")
    assert r2["trusted_added"] == 0, "Second run should add 0 new rows"
    assert r2["brands_skipped"] == 1
    # No additional firecrawl call on second run
    assert call_count["n"] == 1, (
        f"firecrawl_client.call was called {call_count['n']} times total, expected 1"
    )


# ---------------------------------------------------------------------------
# Test 6: Failed scrape (returncode != 0) not marked done
# ---------------------------------------------------------------------------

def test_failed_scrape_not_marked_done(monkeypatch, tmp_path):
    """
    If firecrawl returns returncode != 0, brand must NOT be marked done and
    brands_missed must be incremented.
    """
    root = _make_temp_root(str(tmp_path))

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] += 1
        return {"returncode": 1, "stdout": "", "stderr": "error", "credits_spent": 1}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCH, "BRAND_SLUGS", ["fortune"])

    run_state = {"run_credits_spent": 0}
    result = FCH.harvest(root, run_state, run_id="test_fc_fail")

    assert result["brands_missed"] == 1
    assert result["brands_done_this_run"] == 0

    done = FCH.load_harvested_brands(root)
    assert "fortune" not in done, "Failed scrape brand must not be in harvested_brands.json"
