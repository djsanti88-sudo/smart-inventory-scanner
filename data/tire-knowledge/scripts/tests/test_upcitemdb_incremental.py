"""
test_upcitemdb_incremental.py — Tests for incremental-harvest helpers.

All tests are offline (pure logic + temp-file I/O). Covers:
  1. should_skip() — pure helper, no I/O.
  2. load_harvested_brands() — missing file returns empty set.
  3. save_harvested_brands() / load_harvested_brands() round-trip.
  4. harvest() skips a brand that is already in harvested_brands.json.
  5. harvest() does NOT mark a brand done when fetch() returns None (network error).
  6. harvest() marks a brand done after a successful first-pass fetch.
  7. harvest() marks an empty-after-retry brand done (confirmed empty).
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


def _make_temp_root(tmp_dir: str) -> str:
    """Create minimum corpus files harvest() needs."""
    flat_path = os.path.join(tmp_dir, "tire_corpus_flat.csv")
    with open(flat_path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)

    ids_path = os.path.join(tmp_dir, "tire_identifiers.csv")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")

    sz_path = os.path.join(tmp_dir, "tire_size_aliases.csv")
    with open(sz_path, "w", encoding="utf-8") as f:
        pass

    return tmp_dir


# ---------------------------------------------------------------------------
# 1. should_skip — pure function, no I/O
# ---------------------------------------------------------------------------

def test_should_skip_returns_true_when_slug_in_done_set():
    """A slug that is in done_set should be skipped."""
    assert H.should_skip("fortune", {"fortune", "goodyear"}) is True


def test_should_skip_returns_false_when_slug_not_in_done_set():
    """A slug absent from done_set should NOT be skipped."""
    assert H.should_skip("bridgestone", {"fortune", "goodyear"}) is False


def test_should_skip_empty_done_set_never_skips():
    """An empty done_set never skips any slug."""
    assert H.should_skip("goodyear", set()) is False


def test_should_skip_exact_match_only():
    """Matching is exact; 'fortune_tires' does not match 'fortune'."""
    assert H.should_skip("fortune_tires", {"fortune"}) is False


# ---------------------------------------------------------------------------
# 2. load_harvested_brands — missing file
# ---------------------------------------------------------------------------

def test_load_harvested_brands_missing_file_returns_empty_set(tmp_path):
    """When harvested_brands.json does not exist, return an empty set."""
    result = H.load_harvested_brands(str(tmp_path))
    assert result == set()


# ---------------------------------------------------------------------------
# 3. save / load round-trip
# ---------------------------------------------------------------------------

def test_save_and_load_round_trip(tmp_path):
    """save_harvested_brands then load_harvested_brands returns the same set."""
    brands = {"fortune", "goodyear", "michelin"}
    H.save_harvested_brands(str(tmp_path), brands)
    loaded = H.load_harvested_brands(str(tmp_path))
    assert loaded == brands


def test_save_produces_sorted_json_list(tmp_path):
    """The JSON file should contain a sorted list (deterministic diffs)."""
    brands = {"zeta", "aplus", "michelin"}
    H.save_harvested_brands(str(tmp_path), brands)
    path = os.path.join(str(tmp_path), "harvested_brands.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert data == sorted(brands)


def test_load_handles_empty_list(tmp_path):
    """An empty JSON list [] should return an empty set."""
    path = os.path.join(str(tmp_path), "harvested_brands.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump([], f)
    assert H.load_harvested_brands(str(tmp_path)) == set()


def test_load_handles_malformed_json(tmp_path):
    """Malformed JSON in harvested_brands.json returns empty set (safe fallback)."""
    path = os.path.join(str(tmp_path), "harvested_brands.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{not valid json}")
    assert H.load_harvested_brands(str(tmp_path)) == set()


def test_load_handles_non_list_json(tmp_path):
    """A JSON object (not a list) returns empty set."""
    path = os.path.join(str(tmp_path), "harvested_brands.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"fortune": True}, f)
    assert H.load_harvested_brands(str(tmp_path)) == set()


# ---------------------------------------------------------------------------
# 4. harvest() skips an already-done brand
# ---------------------------------------------------------------------------

def test_harvest_skips_brand_in_harvested_brands_json(monkeypatch, tmp_path):
    """
    If 'fortune' is already in harvested_brands.json, harvest() must skip it
    without calling fetch() and return brands_skipped == 1, trusted_added == 0.
    """
    root = _make_temp_root(str(tmp_path))

    # Pre-seed harvested_brands.json with 'fortune'
    H.save_harvested_brands(root, {"fortune"})

    # fetch should never be called — if it is, fail the test
    def _fail_if_called(slug):
        raise AssertionError(f"fetch() was called for {slug!r} but it should have been skipped")

    monkeypatch.setattr(H, "fetch", _fail_if_called)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune"])

    result = H.harvest(root)

    assert result["brands_skipped"] == 1
    assert result["trusted_added"] == 0
    assert result["brands_hit"] == 0
    assert result["brands_missed"] == 0


# ---------------------------------------------------------------------------
# 5. harvest() does NOT mark a failed-fetch brand done
# ---------------------------------------------------------------------------

def test_harvest_network_error_not_marked_done(monkeypatch, tmp_path):
    """
    A slug that returns None (network error / 404) must NOT be added to
    harvested_brands.json so the next run retries it.
    """
    root = _make_temp_root(str(tmp_path))

    monkeypatch.setattr(H, "fetch", lambda slug: None)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune"])

    result = H.harvest(root)

    assert result["brands_missed"] == 1
    # harvested_brands.json must not contain 'fortune'
    done = H.load_harvested_brands(root)
    assert "fortune" not in done


# ---------------------------------------------------------------------------
# 6. harvest() marks a slug done after a successful fetch
# ---------------------------------------------------------------------------

def test_harvest_successful_slug_marked_done(monkeypatch, tmp_path):
    """
    After a slug is successfully fetched+parsed with >0 products, it should
    appear in harvested_brands.json on disk.
    """
    root = _make_temp_root(str(tmp_path))
    fixture_html = _load_fixture()

    monkeypatch.setattr(H, "fetch", lambda slug: fixture_html if slug == "fortune" else None)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune"])

    result = H.harvest(root)

    assert result["trusted_added"] > 0
    done = H.load_harvested_brands(root)
    assert "fortune" in done


# ---------------------------------------------------------------------------
# 7. harvest() marks empty-after-retry brand done
# ---------------------------------------------------------------------------

def test_harvest_empty_after_retry_marked_done(monkeypatch, tmp_path):
    """
    A slug that returns 200 with 0 products on first pass AND 0 on retry
    should be marked done so future runs don't keep hitting a dead page.
    """
    root = _make_temp_root(str(tmp_path))

    # Return an HTML page that has no tire products (parse_page will return [])
    empty_html = "<html><body><h1>No products here</h1></body></html>"

    monkeypatch.setattr(H, "fetch", lambda slug: empty_html)
    monkeypatch.setattr(H, "BRAND_SLUGS", ["fortune"])
    # Skip the 30-second retry pause
    monkeypatch.setattr(H, "_RETRY_PAUSE_S", 0.0)
    monkeypatch.setattr(H, "_RETRY_SLEEP_S", 0.0)
    monkeypatch.setattr(H, "_SLEEP_S", 0.0)

    result = H.harvest(root)

    assert result["brands_missed"] == 1
    assert result["trusted_added"] == 0
    done = H.load_harvested_brands(root)
    assert "fortune" in done
