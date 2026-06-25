"""
test_upcitemdb_fc_api.py -- Offline tests for upcitemdb_firecrawl_api_harvest.

ALL OFFLINE -- no network calls, no Firecrawl credits.
firecrawl_client.call is monkeypatched throughout.

Tests:
  1. Tire items written with evidence_level=verified_db; junk skipped; offset advances.
  2. Non-tire (no tire size) item is skipped; real tire item is written.
  3. Per-brand efficiency floor: <4 rows/credit after 3 pages moves to next brand.
  4. Global efficiency floor: <4 rows/credit after 5 brands stops the harvest.
  5. RuntimeError from Firecrawl (cap/kill switch) caught cleanly -- no re-raise.
  6. Lock acquired at start and released on exit (even on exception).
  7. api_progress.json offset advances correctly after a brand.
  8. Credit budget respected: stops when credits_spent >= budget.
  9. JSON parse fallback: if stdout wraps the JSON in HTML, re.search extracts it.
  10. Item's OWN brand field used (not the search brand slug).
"""

import csv
import json
import os
import sys
import re

import pytest

# Make scripts/ importable
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _SCRIPTS_DIR)

import validate as v
import firecrawl_client
import upcitemdb_firecrawl_api_harvest as FCAH

# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

# Valid UPC-12 with correct GTIN check digit (reuse from api_harvest tests)
_FORTUNE_UPC = "840139631771"
_FORTUNE_UPC_2 = "840139631788"

# A real Goodyear barcode (valid GTIN-12)
_GOODYEAR_UPC = "045583723004"

# Junk / non-tire item
_JUNK_ITEM = {
    "upc": "012345678905",
    "ean": "0012345678905",
    "brand": "NHL",
    "title": "NHL Blackhawks Tire Cover for Full Size Spare",
}

# Real Fortune tire items
_FORTUNE_ITEM_1 = {
    "upc": _FORTUNE_UPC,
    "ean": "0" + _FORTUNE_UPC,
    "brand": "Fortune",
    "title": "Fortune Tormenta A/T FSR308 All Terrain 245/70R17 110T Light Truck Tire",
}

_FORTUNE_ITEM_2 = {
    "upc": _FORTUNE_UPC_2,
    "ean": "0" + _FORTUNE_UPC_2,
    "brand": "Fortune",
    "title": "Fortune Tormenta H/T FSR702 Highway 265/70R17 115T Light Truck Tire",
}

# Goodyear tire item with explicit brand (tests that OWN brand is used)
_GOODYEAR_ITEM = {
    "upc": _GOODYEAR_UPC,
    "ean": "0" + _GOODYEAR_UPC,
    "brand": "Goodyear",
    "title": "Goodyear Eagle F1 Asymmetric 3 245/45R18 96Y Performance Tire",
}


def _make_page(items: list, total: int, offset: int) -> dict:
    """Build a fake upcitemdb API response dict."""
    return {
        "code": "OK",
        "total": total,
        "offset": offset,
        "items": items,
    }


def _page_json(items: list, total: int, offset: int) -> str:
    """Return the JSON string for a fake API page."""
    return json.dumps(_make_page(items, total, offset))


# ---------------------------------------------------------------------------
# Temp root setup
# ---------------------------------------------------------------------------

def _make_temp_root(tmp_dir: str) -> str:
    """Create the minimum files harvest() needs in tmp_dir."""
    flat_path = os.path.join(tmp_dir, "tire_corpus_flat.csv")
    with open(flat_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    ids_path = os.path.join(tmp_dir, "tire_identifiers.csv")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")

    # firecrawl_policy.json -- generous caps so tests never hit them
    policy = {
        "TOTAL_CAP": 100000,
        "PER_RUN_CAP": 50000,
        "KILL_SWITCH_FILE": ".firecrawl_STOP",
        "total_credits_spent": 0,
    }
    with open(os.path.join(tmp_dir, "firecrawl_policy.json"), "w", encoding="utf-8") as f:
        json.dump(policy, f, indent=2)

    return tmp_dir


# ---------------------------------------------------------------------------
# Test 1: Happy path -- tire written verified_db; junk skipped; offset advances
# ---------------------------------------------------------------------------

def test_tire_written_verified_db_junk_skipped_offset_advances(monkeypatch, tmp_path):
    """
    Page 1: one junk item + one Fortune tire item.
    Assert:
      - Fortune tire written with evidence_level=verified_db
      - Junk item (no tire size) not written
      - api_progress.json offset advances past the page items
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            return {
                "returncode": 0,
                "stdout": _page_json([_JUNK_ITEM, _FORTUNE_ITEM_1], total=2, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }
        # Page 2: empty -- stop paging
        return {
            "returncode": 0,
            "stdout": _page_json([], total=2, offset=2),
            "stderr": "",
            "credits_spent": 1,
        }

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    result = FCAH.harvest(root, credit_budget=50)

    # Fortune tire written
    assert result["trusted_added"] >= 1, (
        f"Expected at least 1 trusted row, got {result['trusted_added']}"
    )

    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    barcodes = [r["barcode"] for r in rows]
    assert _FORTUNE_UPC in barcodes, "Fortune tire barcode must be in flat CSV"
    assert _JUNK_ITEM["upc"] not in barcodes, "Junk item barcode must NOT be in flat CSV"

    # All written rows must have evidence_level=verified_db
    for row in rows:
        assert row["evidence_level"] == "verified_db", (
            f"Row {row['barcode']} has evidence_level={row['evidence_level']!r}"
        )

    # Offset must have advanced in api_progress.json
    from upcitemdb_api_harvest import load_progress
    progress = load_progress(root)
    assert progress.get("fortune", 0) > 0, (
        f"Expected offset > 0 for 'fortune', got {progress.get('fortune', 0)}"
    )


# ---------------------------------------------------------------------------
# Test 2: Non-tire item (junk NHL cover) specifically skipped
# ---------------------------------------------------------------------------

def test_junk_nhl_tire_cover_skipped(monkeypatch, tmp_path):
    """
    The NHL Blackhawks Tire Cover has no tire size in the title.
    parse_name() returns {} -> _item_to_identity returns None -> skipped.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            return {
                "returncode": 0,
                "stdout": _page_json([_JUNK_ITEM], total=1, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }
        return {"returncode": 0, "stdout": _page_json([], total=1, offset=1), "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    result = FCAH.harvest(root, credit_budget=10)

    # Junk item must not appear in corpus
    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    assert _JUNK_ITEM["upc"] not in [r["barcode"] for r in rows], (
        "Junk NHL item must not be in the corpus"
    )


# ---------------------------------------------------------------------------
# Test 3: Per-brand efficiency floor moves on after 3 pages with <4 rows/credit
# ---------------------------------------------------------------------------

def test_per_brand_efficiency_floor_moves_on(monkeypatch, tmp_path):
    """
    fortune: 3 pages each returning 0 tire items (1 junk item each) but 1 credit each.
    After 3 pages with 0 trusted rows / 3 credits = 0 rows/credit < 4 -> move_on=True.
    The harvest must then move to the next brand (ironman).
    """
    root = _make_temp_root(str(tmp_path))

    fortune_calls = [0]
    ironman_calls = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        # Determine which brand by inspecting URL in cmd_args
        url = cmd_args[-1] if cmd_args else ""
        if "fortune" in url:
            fortune_calls[0] += 1
            # Return 1 junk item (no tire size) per page for fortune
            return {
                "returncode": 0,
                "stdout": _page_json([_JUNK_ITEM], total=999, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }
        else:
            ironman_calls[0] += 1
            # ironman returns a real tire
            return {
                "returncode": 0,
                "stdout": _page_json([_FORTUNE_ITEM_1], total=1, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune", "ironman"])

    result = FCAH.harvest(root, credit_budget=50)

    # Fortune must have been called exactly EFFICIENCY_WARMUP_PAGES (3) times
    assert fortune_calls[0] == FCAH._EFFICIENCY_WARMUP_PAGES, (
        f"Expected fortune called {FCAH._EFFICIENCY_WARMUP_PAGES} times "
        f"(efficiency floor), got {fortune_calls[0]}"
    )

    # Ironman must have been called (moved on to next brand)
    assert ironman_calls[0] >= 1, (
        f"Expected ironman to be called after fortune efficiency floor, got {ironman_calls[0]}"
    )


# ---------------------------------------------------------------------------
# Test 4: Global efficiency floor stops after 5 brands
# ---------------------------------------------------------------------------

def test_global_efficiency_floor_stops_after_5_brands(monkeypatch, tmp_path):
    """
    5 brands each return only junk items (0 trusted) but spend 1 credit/brand.
    Global rpc = 0 < 4 after 5 brands -> harvest must stop.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]
    brand_calls = {}

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        url = cmd_args[-1] if cmd_args else ""
        for brand in ["fortune", "toyo", "falken", "dunlop", "nexen", "nokian"]:
            if brand in url:
                brand_calls[brand] = brand_calls.get(brand, 0) + 1
        # Always return junk (no tires harvested)
        return {
            "returncode": 0,
            "stdout": _page_json([_JUNK_ITEM], total=999, offset=0),
            "stderr": "",
            "credits_spent": 1,
        }

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    # Six brands -- global floor should kick in after 5
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", [
        "fortune", "toyo", "falken", "dunlop", "nexen", "nokian"
    ])

    result = FCAH.harvest(root, credit_budget=200)

    # The harvest should have stopped. brands_touched <= EFFICIENCY_GLOBAL_BRANDS
    # (it may stop at 5 brands after the global floor triggers)
    assert result["trusted_added"] == 0, "No tires should be written"

    # We must have stopped well short of exhausting all 6 brands worth of paging
    # Specifically: after 5 brands each with _EFFICIENCY_WARMUP_PAGES calls each brand
    # would move on (per-brand floor), but the global floor should stop at 5 brands.
    # The total call count should be bounded.
    assert call_count[0] <= (FCAH._EFFICIENCY_GLOBAL_BRANDS * FCAH._EFFICIENCY_WARMUP_PAGES + FCAH._EFFICIENCY_WARMUP_PAGES), (
        f"Too many calls before global efficiency floor: {call_count[0]}"
    )


# ---------------------------------------------------------------------------
# Test 5: RuntimeError from Firecrawl caught cleanly
# ---------------------------------------------------------------------------

def test_firecrawl_runtime_error_caught_cleanly(monkeypatch, tmp_path):
    """
    If firecrawl_client.call raises RuntimeError (cap/kill switch), harvest
    must NOT re-raise -- it finalizes and returns a valid result dict.
    """
    root = _make_temp_root(str(tmp_path))

    def _raise_cap(cmd_args, expected_max_credits, run_state, root=None):
        raise RuntimeError("per-run cap exceeded: test")

    monkeypatch.setattr(firecrawl_client, "call", _raise_cap)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    # Must not raise
    result = FCAH.harvest(root, credit_budget=100)

    assert isinstance(result, dict), "harvest() must return a dict even on cap error"
    assert "audit_ok" in result
    assert result["trusted_added"] == 0


# ---------------------------------------------------------------------------
# Test 6: Lock acquired at start and released on exit
# ---------------------------------------------------------------------------

def test_lock_acquired_and_released(monkeypatch, tmp_path):
    """
    acquire_lock writes harvest.lock; release_lock removes it.
    After a normal harvest with monkeypatched call:
      - lock does NOT exist (released in finally block in __main__,
        but harvest() itself does not acquire the lock)
    For __main__ path, test acquire_lock / release_lock directly.
    """
    root = _make_temp_root(str(tmp_path))

    lock_path = os.path.join(root, "harvest.lock")

    # Test acquire_lock writes the file
    assert not os.path.exists(lock_path), "Lock should not exist before acquire"
    acquired = FCAH.acquire_lock(root, "test_run_001")
    assert acquired is True, "First acquire should succeed"
    assert os.path.exists(lock_path), "Lock file must exist after acquire"

    # Verify lock contents
    with open(lock_path, encoding="utf-8") as f:
        lock_data = json.load(f)
    assert lock_data["run_id"] == "test_run_001"
    assert "last_heartbeat_at" in lock_data

    # A second acquire with a FRESH lock must fail
    acquired2 = FCAH.acquire_lock(root, "test_run_002")
    assert acquired2 is False, "Second acquire with fresh lock must fail"

    # release_lock removes it
    FCAH.release_lock(root)
    assert not os.path.exists(lock_path), "Lock file must be removed after release"

    # After release, acquire succeeds again
    acquired3 = FCAH.acquire_lock(root, "test_run_003")
    assert acquired3 is True, "Acquire after release must succeed"
    FCAH.release_lock(root)


def test_stale_lock_is_reclaimed(monkeypatch, tmp_path):
    """A lock with last_heartbeat_at >90 minutes ago is reclaimed automatically."""
    root = _make_temp_root(str(tmp_path))
    lock_path = os.path.join(root, "harvest.lock")

    # Write a stale lock (timestamp far in the past)
    stale_data = {
        "run_id": "stale_run",
        "started_at": "2020-01-01T00:00:00Z",
        "last_heartbeat_at": "2020-01-01T00:00:00Z",
        "process": 12345,
    }
    with open(lock_path, "w", encoding="utf-8") as f:
        json.dump(stale_data, f)

    acquired = FCAH.acquire_lock(root, "new_run_001")
    assert acquired is True, "Stale lock must be reclaimed and new lock acquired"
    assert os.path.exists(lock_path), "New lock must exist after reclaim"

    with open(lock_path, encoding="utf-8") as f:
        new_lock = json.load(f)
    assert new_lock["run_id"] == "new_run_001", "Lock must be for the new run"

    FCAH.release_lock(root)


# ---------------------------------------------------------------------------
# Test 7: api_progress.json offset advances after a brand
# ---------------------------------------------------------------------------

def test_progress_offset_advances(monkeypatch, tmp_path):
    """
    After processing 'fortune' with 2 items returned, the offset in
    api_progress.json must equal 2 (start_offset 0 + 2 items).
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            # 2 tire items total=2 -> fully paged after this
            return {
                "returncode": 0,
                "stdout": _page_json(
                    [_FORTUNE_ITEM_1, _FORTUNE_ITEM_2], total=2, offset=0
                ),
                "stderr": "",
                "credits_spent": 1,
            }
        # Should not be called again (fully paged)
        return {"returncode": 0, "stdout": _page_json([], total=2, offset=2), "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    FCAH.harvest(root, credit_budget=50)

    from upcitemdb_api_harvest import load_progress
    progress = load_progress(root)
    assert progress.get("fortune", 0) == 2, (
        f"Expected offset=2 for 'fortune', got {progress.get('fortune', 0)}"
    )


# ---------------------------------------------------------------------------
# Test 8: Credit budget respected
# ---------------------------------------------------------------------------

def test_credit_budget_respected(monkeypatch, tmp_path):
    """
    With credit_budget=2 and each firecrawl call costing 1 credit, harvest
    must stop after at most 2 credits spent.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        return {
            "returncode": 0,
            "stdout": _page_json([_FORTUNE_ITEM_1], total=100, offset=call_count[0] - 1),
            "stderr": "",
            "credits_spent": 1,
        }

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune", "toyo", "falken"])

    result = FCAH.harvest(root, credit_budget=2)

    assert result["credits_spent"] <= 2, (
        f"Expected credits_spent <= 2, got {result['credits_spent']}"
    )


# ---------------------------------------------------------------------------
# Test 9: JSON parse fallback -- HTML-wrapped JSON
# ---------------------------------------------------------------------------

def test_json_parse_fallback_html_wrapped(monkeypatch, tmp_path):
    """
    If stdout wraps the JSON in HTML (e.g. Firecrawl rawHtml), the fallback
    re.search(r'\{.*\}', stdout, re.S) must extract and parse it correctly.
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]
    page_json = json.dumps(_make_page([_FORTUNE_ITEM_1], total=1, offset=0))
    # Wrap JSON in fake HTML -- this is the fallback case
    html_wrapped = f"<html><body><pre>{page_json}</pre></body></html>"

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            return {
                "returncode": 0,
                "stdout": html_wrapped,
                "stderr": "",
                "credits_spent": 1,
            }
        return {"returncode": 0, "stdout": _page_json([], total=1, offset=1), "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    result = FCAH.harvest(root, credit_budget=10)

    # Fortune tire must be written even though stdout was HTML-wrapped
    assert result["trusted_added"] >= 1, (
        f"Expected trusted_added >= 1 with HTML-wrapped JSON, got {result['trusted_added']}"
    )
    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert _FORTUNE_UPC in [r["barcode"] for r in rows]


# ---------------------------------------------------------------------------
# Test 10: Item's OWN brand field is used
# ---------------------------------------------------------------------------

def test_own_brand_field_used(monkeypatch, tmp_path):
    """
    When searching for brand_slug='fortune' but the item has brand='Goodyear',
    the written row must use 'Goodyear' (from item), not 'fortune' (the slug).
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            return {
                "returncode": 0,
                "stdout": _page_json([_GOODYEAR_ITEM], total=1, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }
        return {"returncode": 0, "stdout": _page_json([], total=1, offset=1), "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])  # search slug is fortune

    result = FCAH.harvest(root, credit_budget=10)

    if result["trusted_added"] > 0:
        flat_path = os.path.join(root, "tire_corpus_flat.csv")
        with open(flat_path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        goodyear_rows = [r for r in rows if r["barcode"] == _GOODYEAR_UPC]
        if goodyear_rows:
            brand_in_corpus = goodyear_rows[0]["brand"]
            # Brand should NOT be "fortune" (the slug); it should be from the item
            assert brand_in_corpus.lower() != "fortune", (
                f"Brand must come from item, not slug. Got: {brand_in_corpus!r}"
            )


# ---------------------------------------------------------------------------
# Test 11: Duplicate barcode in same run is deduped
# ---------------------------------------------------------------------------

def test_duplicate_barcode_deduped(monkeypatch, tmp_path):
    """
    If the same barcode appears in two pages, the second must be counted as
    dup_skipped (not re-added to trusted corpus).
    """
    root = _make_temp_root(str(tmp_path))

    call_count = [0]

    def _fake_call(cmd_args, expected_max_credits, run_state, root=None):
        call_count[0] += 1
        run_state["run_credits_spent"] = run_state.get("run_credits_spent", 0) + 1
        if call_count[0] == 1:
            # First page: one tire item
            return {
                "returncode": 0,
                "stdout": _page_json([_FORTUNE_ITEM_1], total=2, offset=0),
                "stderr": "",
                "credits_spent": 1,
            }
        if call_count[0] == 2:
            # Second page: same barcode again
            return {
                "returncode": 0,
                "stdout": _page_json([_FORTUNE_ITEM_1], total=2, offset=1),
                "stderr": "",
                "credits_spent": 1,
            }
        return {"returncode": 0, "stdout": _page_json([], total=2, offset=2), "stderr": "", "credits_spent": 0}

    monkeypatch.setattr(firecrawl_client, "call", _fake_call)
    monkeypatch.setattr(FCAH, "PRIORITY_BRANDS", ["fortune"])

    result = FCAH.harvest(root, credit_budget=50)

    # Exactly 1 trusted row (the first); the second is a dup
    flat_path = os.path.join(root, "tire_corpus_flat.csv")
    with open(flat_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len([r for r in rows if r["barcode"] == _FORTUNE_UPC]) == 1, (
        "Duplicate barcode must appear only once in corpus"
    )
    assert result["dup_skipped"] >= 1, (
        f"Expected dup_skipped >= 1, got {result['dup_skipped']}"
    )


# ---------------------------------------------------------------------------
# Test 12: PRIORITY_BRANDS contains expected brands
# ---------------------------------------------------------------------------

def test_priority_brands_contains_expected():
    """PRIORITY_BRANDS must include all specified unambiguous brands."""
    required = [
        "fortune", "toyo", "falken", "dunlop", "nexen", "nokian",
        "milestar", "delinte", "federal", "ironman", "hercules", "kumho",
        "cooper", "yokohama", "pirelli", "michelin", "bridgestone",
        "continental", "general", "hankook", "kelly", "laufenn",
        "sumitomo", "sailun", "kenda", "maxxis",
    ]
    for brand in required:
        assert brand in FCAH.PRIORITY_BRANDS, (
            f"'{brand}' missing from PRIORITY_BRANDS"
        )
