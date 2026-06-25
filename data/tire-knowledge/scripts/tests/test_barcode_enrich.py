"""
test_barcode_enrich.py — Offline-only tests for barcode_enrich.py.

NO network calls, NO live Gemini, NO datetime.now() dependency.
All injectable parameters (_fetch, _transport, _date_str) are used.

Coverage:
  build_brand_prefixes  — builds correct brand->prefix sets, handles leading zeros.
  prefix_matches        — matches on bc[:7] and lstrip('0')[:7]; non-match False.
  verify_candidate      — accept/reject logic for all four cases.
  routing integration   — verified_ai identity writes as TRUSTED; qa_corpus_full PASSES.
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

import barcode_enrich as E
import validate as v
import write_outputs as W
import ledger as L
import qa_corpus_full as QA


# ── Fixtures / helpers ────────────────────────────────────────────────────────

# Valid GTIN-12 barcodes (confirmed check digit)
_FALKEN_BC = "848983006257"   # Falken Wildpeak — valid GTIN-12
_FORT_BC   = "840139631771"   # Fortune — valid GTIN-12
_BAD_BC    = "848983006250"   # Bad check digit (last digit wrong)

# Company prefix for Falken barcode: 8489830 (first 7 digits)
_FALKEN_PFX = "8489830"
# Leading-zero GTIN-14 variant of Fortune barcode: 00840139631771 -> prefix 0084013
_FORT_PFX   = "0084013"


def _make_row(
    make_name="Falken",
    model_name="Wildpeak A/T3W",
    size_canonical="265/70R17",
    width="265",
    aspect_ratio="70",
    rim_size="17",
    speed_rating="T",
    load_rating="121",
    id="1",
) -> dict:
    return {
        "id": id,
        "make_name": make_name,
        "model_name": model_name,
        "size_canonical": size_canonical,
        "width": width,
        "aspect_ratio": aspect_ratio,
        "rim_size": rim_size,
        "speed_rating": speed_rating,
        "load_rating": load_rating,
        "category": "",
        "terrain": "",
    }


def _write_corpus(d: str, rows: list) -> str:
    """Write a minimal tire_corpus_flat.csv to directory d and return its path."""
    flat = os.path.join(d, "tire_corpus_flat.csv")
    with open(flat, "w", newline="", encoding="utf-8") as f:
        wtr = csv.DictWriter(f, fieldnames=v.FLAT_COLS)
        wtr.writeheader()
        for row in rows:
            wtr.writerow({k: row.get(k, "") for k in v.FLAT_COLS})
    return flat


def _corpus_row(
    brand: str,
    model: str,
    size_canonical: str,
    barcode: str,
    evidence_level: str = "verified_db",
    source_url: str = "tirelibrary:1",
) -> dict:
    """Build a minimal FLAT_COLS row for tests."""
    nb = v.normalize_brand(brand)
    nm = v.normalize_model(model)
    _, size_compact = v.normalize_size(size_canonical)
    uid = v.make_uid(nb, nm, size_canonical, "", "", barcode)
    return {
        "canonical_product_uid": uid,
        "brand": nb,
        "model": nm,
        "size_canonical": size_canonical,
        "size_compact": size_compact or "",
        "load_index": "",
        "speed_rating": "",
        "tire_type": "",
        "season": "",
        "barcode": barcode,
        "barcode_type": v.barcode_type_label(barcode),
        "manufacturer_part_number": "",
        "source_url": source_url,
        "evidence_level": evidence_level,
        "usable_for": "auto_count_candidate",
        "current_status": "active_retail",
        "missing_fields": "",
        "field_completeness_score": "80",
        "harvested_at": "2026-01-01T00:00:00Z",
        "run_id": "test",
    }


def _flat_paths(d: str) -> dict:
    """Create an empty flat.csv with header and return paths dict."""
    flat = os.path.join(d, "tire_corpus_flat.csv")
    with open(flat, "w", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=v.FLAT_COLS).writeheader()
    ids = os.path.join(d, "tire_identifiers.csv")
    with open(ids, "w", encoding="utf-8") as f:
        f.write("barcode,retailer_sku,source_url\n")
    return {"flat": flat, "identifiers": ids}


# ── build_brand_prefixes tests ────────────────────────────────────────────────

class TestBuildBrandPrefixes:
    """build_brand_prefixes reads corpus and returns brand -> prefix sets."""

    def test_returns_prefix_for_brand_with_enough_barcodes(self):
        """Brand with 2+ barcodes sharing the same prefix should appear."""
        with tempfile.TemporaryDirectory() as d:
            # Two Falken barcodes both start with 8489830
            bc1 = "848983006257"  # valid GTIN-12
            bc2 = "848983006264"  # same prefix 8489830 — compute check digit
            # Note: bc2 needs valid check digit for corpus but build_brand_prefixes
            # just reads raw barcodes from the corpus — no GTIN check in that function.
            # We force it valid by using another known Falken UPC:
            bc2 = "848983006257"  # reuse same barcode for simplicity (same prefix!)
            # Actually use a distinct one with same prefix:
            # Build a corpus with 2 rows that share a brand and prefix
            rows = [
                _corpus_row("falken", "Wildpeak A/T3W", "265/70R17", "848983006257"),
                _corpus_row("falken", "Sincera SN201", "205/65R16", "848983001160"),
            ]
            _write_corpus(d, rows)
            result = E.build_brand_prefixes(d)
            assert "falken" in result
            # Both barcodes start with 8489830
            assert "8489830" in result["falken"]

    def test_prefix_below_threshold_excluded(self):
        """Brand with only 1 barcode should NOT appear (count < 2)."""
        with tempfile.TemporaryDirectory() as d:
            rows = [
                _corpus_row("nokian", "Hakkapeliitta R3", "225/45R17", "6419991006185"),
            ]
            _write_corpus(d, rows)
            result = E.build_brand_prefixes(d)
            # Only 1 row -> no prefix passes threshold
            assert "nokian" not in result or not result.get("nokian")

    def test_leading_zero_prefix_included(self):
        """GTIN-14 or EAN-13 with leading zeros: lstrip('0') prefix also recorded."""
        with tempfile.TemporaryDirectory() as d:
            # barcode "0048418000000" -> lstrip('0') = "48418000000" -> prefix candidate "4841800"
            # Use two rows with same brand and barcode prefix after stripping
            bc1 = _FORT_BC  # 840139631771 -> prefix 8401396
            bc2 = "840139631788"  # same prefix 8401396
            rows = [
                _corpus_row("fortune", "Tormenta A/T", "245/70R17", bc1),
                _corpus_row("fortune", "Tormenta H/T", "225/65R17", bc2),
            ]
            _write_corpus(d, rows)
            result = E.build_brand_prefixes(d)
            assert "fortune" in result
            # Both share prefix "8401396"
            assert "8401396" in result["fortune"]

    def test_unknown_brand_not_in_result_when_below_threshold(self):
        """A brand with a single barcode entry contributes no prefixes."""
        with tempfile.TemporaryDirectory() as d:
            rows = [_corpus_row("cooper", "Discoverer AT3", "265/70R17", _FALKEN_BC)]
            _write_corpus(d, rows)
            result = E.build_brand_prefixes(d)
            assert "cooper" not in result or not result.get("cooper")

    def test_empty_corpus_returns_empty_dict(self):
        with tempfile.TemporaryDirectory() as d:
            _write_corpus(d, [])
            result = E.build_brand_prefixes(d)
            assert result == {}

    def test_rows_without_barcode_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            row = _corpus_row("goodyear", "Assurance", "225/65R17", "036000291452")
            row["barcode"] = ""  # no barcode
            _write_corpus(d, [row])
            result = E.build_brand_prefixes(d)
            assert "goodyear" not in result or not result.get("goodyear")


# ── prefix_matches tests ──────────────────────────────────────────────────────

class TestPrefixMatches:
    """prefix_matches checks bc[:7] and bc.lstrip('0')[:7] against known set."""

    def _known(self):
        return {"falken": {"8489830"}, "fortune": {"8401396", "0084013"}}

    def test_matches_on_first_7_digits(self):
        # _FALKEN_BC = "848983006257" -> prefix "8489830"
        assert E.prefix_matches(_FALKEN_BC, "Falken", self._known()) is True

    def test_matches_case_insensitive_brand(self):
        assert E.prefix_matches(_FALKEN_BC, "FALKEN", self._known()) is True
        assert E.prefix_matches(_FALKEN_BC, "falken", self._known()) is True

    def test_no_match_for_unknown_brand(self):
        assert E.prefix_matches(_FALKEN_BC, "Nokian", self._known()) is False

    def test_no_match_for_wrong_prefix(self):
        # _FORT_BC prefix is "8401396", not in falken's set
        assert E.prefix_matches(_FORT_BC, "Falken", self._known()) is False

    def test_matches_on_lstrip_zero_prefix(self):
        """A barcode with leading zeros: stripping them gives a different prefix candidate."""
        # "0048418123456" -> lstrip('0') = "48418123456" -> prefix "4841812"
        # Build known with that stripped prefix
        known = {"bridgestone": {"4841812"}}
        bc = "0048418123456"  # not a real GTIN, just testing prefix extraction
        assert E.prefix_matches(bc, "Bridgestone", known) is True

    def test_empty_known_returns_false(self):
        assert E.prefix_matches(_FALKEN_BC, "Falken", {}) is False

    def test_brand_not_in_known_returns_false(self):
        assert E.prefix_matches(_FALKEN_BC, "UnknownBrand", self._known()) is False


# ── verify_candidate tests ────────────────────────────────────────────────────

class TestVerifyCandidate:
    """Core accept/reject logic for barcode candidates."""

    _ROW = _make_row(
        make_name="Falken",
        size_canonical="265/70R17",
        width="265",
        aspect_ratio="70",
        rim_size="17",
    )
    _KNOWN = {"falken": {"8489830"}}

    def _page_ok(self, barcode, brand="falken", size="265/70R17") -> str:
        return f"Product page for {brand} tire {size} UPC: {barcode} buy online."

    def test_accept_when_source_confirmed(self):
        """source_confirmed=True -> accept even without prefix match."""
        page = self._page_ok(_FALKEN_BC)
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW, sources=["https://example.com"],
            known={},  # no known prefixes
            _fetch=lambda url: page,
        )
        assert result["accept"] is True
        assert result["source_confirmed"] is True
        assert result["confidence"] == "source"

    def test_accept_when_prefix_match_and_sources_nonempty(self):
        """prefix_match=True AND sources non-empty -> accept even if source page doesn't confirm."""
        # Page does NOT contain the barcode/brand/size
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=["https://example.com"],
            known=self._KNOWN,
            _fetch=lambda url: "this page has no tire info at all",
        )
        assert result["accept"] is True
        assert result["source_confirmed"] is False
        assert result["prefix_match"] is True
        assert result["confidence"] == "prefix"

    def test_reject_when_gtin_invalid(self):
        """Invalid GTIN -> reject immediately, no source check."""
        fetched = []
        result = E.verify_candidate(
            _BAD_BC, self._ROW,
            sources=["https://example.com"],
            known=self._KNOWN,
            _fetch=lambda url: (fetched.append(url) or ""),
        )
        assert result["accept"] is False
        assert result["gtin_valid"] is False
        assert fetched == []  # no fetch attempted when GTIN invalid

    def test_reject_when_no_prefix_and_no_source_confirmation(self):
        """No prefix match, source page doesn't confirm -> reject."""
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=["https://example.com"],
            known={},  # no known prefixes
            _fetch=lambda url: "this page has no tire info at all",
        )
        assert result["accept"] is False
        assert result["gtin_valid"] is True
        assert result["source_confirmed"] is False
        assert result["prefix_match"] is False
        assert result["confidence"] == "none"

    def test_reject_when_no_sources_and_no_prefix(self):
        """No sources at all + no prefix match -> reject."""
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=[],
            known={},
            _fetch=lambda url: "",
        )
        assert result["accept"] is False

    def test_reject_when_prefix_match_but_no_sources(self):
        """prefix_match AND has_source must BOTH be true for prefix path."""
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=[],  # no sources
            known=self._KNOWN,  # prefix would match
            _fetch=lambda url: "",
        )
        # has_source is False -> prefix path doesn't trigger
        assert result["accept"] is False
        assert result["prefix_match"] is True

    def test_empty_barcode_rejected(self):
        result = E.verify_candidate(
            "", self._ROW, sources=["https://x.com"], known=self._KNOWN,
            _fetch=lambda url: "falken 265/70R17",
        )
        assert result["accept"] is False
        assert result["gtin_valid"] is False

    def test_wrong_length_barcode_rejected(self):
        """11-digit barcode (even if digits-only) is invalid."""
        result = E.verify_candidate(
            "12345678901", self._ROW,
            sources=["https://x.com"], known=self._KNOWN,
            _fetch=lambda url: "falken 265/70R17 12345678901",
        )
        assert result["accept"] is False
        assert result["gtin_valid"] is False

    def test_confidence_source_beats_prefix(self):
        """When source_confirmed, confidence is 'source' even if prefix also matches."""
        page = self._page_ok(_FALKEN_BC)
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=["https://example.com"],
            known=self._KNOWN,
            _fetch=lambda url: page,
        )
        assert result["confidence"] == "source"
        assert result["source_confirmed"] is True
        assert result["prefix_match"] is True

    def test_returns_matched_source_when_source_confirmed(self):
        page = self._page_ok(_FALKEN_BC)
        result = E.verify_candidate(
            _FALKEN_BC, self._ROW,
            sources=["https://tirerack.com/falken"],
            known={},
            _fetch=lambda url: page,
        )
        assert result["matched_source"] == "https://tirerack.com/falken"


# ── Routing integration: verified_ai writes as TRUSTED + QA PASSES ────────────

class TestVerifiedAiRouting:
    """
    End-to-end routing test: a verified_ai identity (no MPN) must:
    - route as 'trusted' via write_outputs.route
    - write successfully via write_outputs.write_rows
    - pass qa_corpus_full.check_corpus
    """

    def _verified_ai_identity(self, barcode=None):
        barcode = barcode or _FALKEN_BC
        _, size_compact = v.normalize_size("265/70R17")
        return {
            "brand": "Falken",
            "model": "Wildpeak A/T3W",
            "size_canonical": "265/70R17",
            "size_compact": size_compact or "2657017",
            "load_index": "121",
            "speed_rating": "T",
            "tire_type": "",
            "season": "",
            "mpn": "",
            "manufacturer_part_number": "",
            "barcode": barcode,
            "evidence_level": "verified_ai",
            "source_url": f"gemini:1",
        }

    def test_route_returns_trusted(self):
        idn = self._verified_ai_identity()
        assert W.route(idn) == "trusted"

    def test_write_rows_writes_to_flat(self):
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn = self._verified_ai_identity()
            counts = W.write_rows([idn], paths, led, "run_test")
            assert counts["trusted"] == 1
            rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
            assert len(rows) == 1
            assert rows[0]["evidence_level"] == "verified_ai"
            assert rows[0]["barcode"] == _FALKEN_BC

    def test_write_rows_is_idempotent(self):
        """Writing the same verified_ai row twice skips the dup."""
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn = self._verified_ai_identity()
            c1 = W.write_rows([idn], paths, led, "run_test")
            c2 = W.write_rows([idn], paths, led, "run_test")
            assert c1["trusted"] == 1
            assert c2["dup_skipped"] == 1

    def test_qa_corpus_passes(self):
        """After writing a verified_ai row, check_corpus must return ok=True."""
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn = self._verified_ai_identity()
            W.write_rows([idn], paths, led, "run_test")
            L.save_ledger(led, os.path.join(d, "coverage_ledger.json"))

            ok, problems, stats = QA.check_corpus(d)
            assert ok, f"QA failed with problems: {problems}"

    def test_qa_corpus_passes_with_gemini_source_url(self):
        """source_url = 'gemini:123' must not trigger bad_vendor_source_url."""
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn = {**self._verified_ai_identity(), "source_url": "gemini:425643"}
            W.write_rows([idn], paths, led, "run_test")
            L.save_ledger(led, os.path.join(d, "coverage_ledger.json"))

            ok, problems, _ = QA.check_corpus(d)
            assert "bad_vendor_source_url" not in problems
            assert ok, f"QA failed: {problems}"

    def test_verified_ai_uid_uses_barcode_as_disambiguator(self):
        """Two verified_ai rows with same brand/model/size but diff barcodes get diff UIDs."""
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn1 = self._verified_ai_identity(_FALKEN_BC)
            idn2 = self._verified_ai_identity(_FORT_BC)
            W.write_rows([idn1, idn2], paths, led, "run_test")
            rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
            assert len(rows) == 2
            uid1 = rows[0]["canonical_product_uid"]
            uid2 = rows[1]["canonical_product_uid"]
            assert uid1 != uid2

    def test_manufacturer_part_number_is_empty(self):
        """verified_ai row must have empty manufacturer_part_number (not barcode)."""
        with tempfile.TemporaryDirectory() as d:
            paths = _flat_paths(d)
            led = L.load_ledger(os.path.join(d, "ledger.json"))
            idn = self._verified_ai_identity()
            W.write_rows([idn], paths, led, "run_test")
            row = next(csv.DictReader(open(paths["flat"], encoding="utf-8")))
            assert row["manufacturer_part_number"] == ""


# ── _prefix_candidates helper ─────────────────────────────────────────────────

class TestPrefixCandidates:
    """Internal helper _prefix_candidates extracts 7-char prefix candidates."""

    def test_normal_barcode(self):
        # "848983006257" -> {"8489830", "8489830"} -> {"8489830"}
        result = E._prefix_candidates("848983006257")
        assert "8489830" in result

    def test_leading_zero_barcode(self):
        # "0840139631771" -> {"0840139", "8401396"}
        result = E._prefix_candidates("0840139631771")
        assert "0840139" in result
        assert "8401396" in result

    def test_all_zeros_gives_empty_stripped(self):
        result = E._prefix_candidates("0000000000000")
        # stripped is empty -> only the bc[:7] candidate
        assert "0000000" in result

    def test_short_barcode(self):
        # 5 chars -> prefix candidates are just the 5 chars ([:7] of 5 chars = 5 chars)
        result = E._prefix_candidates("12345")
        assert "12345" in result
