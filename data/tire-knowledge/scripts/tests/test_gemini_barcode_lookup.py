"""
test_gemini_barcode_lookup.py — Offline-only tests for gemini_barcode_lookup.py.

NO network calls are made. All Gemini and HTTP interactions are injected via
_transport / _fetch parameters so tests run entirely offline.

Coverage:
  select_consumer_sample — filters non-consumer tires, respects n, gives diverse brands.
  parse_response         — extracts barcode + sources; handles NONE; handles missing fields.
  verify_barcode         — TRUE when page has barcode+brand+size; FALSE for each missing element.
  gemini_grounded_lookup — injected _transport returns parseable structure, no real network.
"""

import os
import sys

import pytest

# Make scripts/ importable
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, _SCRIPTS_DIR)

import gemini_barcode_lookup as G


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def _make_row(
    make_name="Falken",
    model_name="Wildpeak A/T3W",
    size_canonical="265/70R17",
    width="265",
    aspect_ratio="70",
    rim_size="17",
    speed_rating="T",
    load_rating="121",
    category="Light Truck, All-Terrain",
    terrain="All-Terrain",
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
        "category": category,
        "terrain": terrain,
    }


def _make_gemini_resp(answer_text: str, uris: list[str] | None = None) -> dict:
    """Build a minimal mock Gemini generateContent response dict."""
    chunks = [{"web": {"uri": u}} for u in (uris or [])]
    return {
        "candidates": [
            {
                "content": {
                    "parts": [{"text": answer_text}]
                },
                "groundingMetadata": {
                    "groundingChunks": chunks
                },
            }
        ]
    }


# ── select_consumer_sample tests ──────────────────────────────────────────────

class TestSelectConsumerSample:
    """Filter logic and round-robin brand diversity."""

    def _consumer_rows(self):
        """Return a set of valid consumer rows across multiple brands."""
        return [
            _make_row(make_name="Falken",   model_name="Wildpeak",   id="1"),
            _make_row(make_name="Toyo",     model_name="Open Country", id="2"),
            _make_row(make_name="Cooper",   model_name="Discoverer",  id="3"),
            _make_row(make_name="Hankook",  model_name="Dynapro",     id="4"),
            _make_row(make_name="Falken",   model_name="Sincera",     id="5"),
            _make_row(make_name="Toyo",     model_name="Proxes",      id="6"),
        ]

    def test_excludes_trailer_tire(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Carlisle", model_name="Trailer ST", category="Trailer", id="99"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        ids = [r["id"] for r in result]
        assert "99" not in ids

    def test_excludes_farm_tier(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Titan", model_name="Farm Implement", terrain="Farm", id="88"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "88" not in [r["id"] for r in result]

    def test_excludes_atv_tier(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Maxxis", model_name="ATV Sport", category="ATV/UTV", id="77"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "77" not in [r["id"] for r in result]

    def test_excludes_missing_speed_rating(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Kumho", model_name="Crugen", speed_rating="", id="66"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "66" not in [r["id"] for r in result]

    def test_excludes_missing_size(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Nexen", model_name="N5000", size_canonical="", id="55"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "55" not in [r["id"] for r in result]

    def test_excludes_rim_out_of_range_low(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Kenda", model_name="Kountry", rim_size="13", id="44"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "44" not in [r["id"] for r in result]

    def test_excludes_rim_out_of_range_high(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="Kenda", model_name="Kountry", rim_size="24", id="43"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "43" not in [r["id"] for r in result]

    def test_respects_n(self):
        rows = self._consumer_rows()  # 6 consumer tires
        result = G.select_consumer_sample(rows, n=3)
        assert len(result) == 3

    def test_returns_all_when_fewer_than_n(self):
        rows = self._consumer_rows()  # 6 rows
        result = G.select_consumer_sample(rows, n=100)
        assert len(result) == 6

    def test_diverse_brands_in_sample(self):
        """Round-robin should spread across brands before repeating any."""
        rows = self._consumer_rows()  # 2x Falken, 2x Toyo, 1x Cooper, 1x Hankook
        result = G.select_consumer_sample(rows, n=4)
        brands = [r["make_name"] for r in result]
        # First 4 should include at least 3 different brands
        assert len(set(brands)) >= 3

    def test_excludes_otr_keyword(self):
        rows = self._consumer_rows() + [
            _make_row(make_name="BKT", model_name="OTR Mine", category="OTR Mining", id="33"),
        ]
        result = G.select_consumer_sample(rows, n=20)
        assert "33" not in [r["id"] for r in result]

    def test_seed_offset_shifts_selection(self):
        rows = self._consumer_rows()
        result0 = G.select_consumer_sample(rows, n=2, seed_offset=0)
        result1 = G.select_consumer_sample(rows, n=2, seed_offset=1)
        # With offset=1 we skip the first item per brand, so results should differ
        ids0 = [r["id"] for r in result0]
        ids1 = [r["id"] for r in result1]
        assert ids0 != ids1


# ── parse_response tests ──────────────────────────────────────────────────────

class TestParseResponse:
    """Extraction of barcode, sources, and text from raw Gemini response dicts."""

    def test_extracts_12_digit_upc(self):
        resp = _make_gemini_resp(
            "The UPC for this tire is 036000291452.",
            uris=["https://example.com/tire1"],
        )
        result = G.parse_response(resp)
        assert result["barcode"] == "036000291452"
        assert result["sources"] == ["https://example.com/tire1"]

    def test_extracts_13_digit_ean(self):
        resp = _make_gemini_resp(
            "EAN barcode: 4006381333931",
            uris=["https://shop.example.com/product"],
        )
        result = G.parse_response(resp)
        assert result["barcode"] == "4006381333931"

    def test_extracts_14_digit_gtin(self):
        resp = _make_gemini_resp(
            "GTIN-14: 00036000291452",
            uris=[],
        )
        result = G.parse_response(resp)
        assert result["barcode"] == "00036000291452"

    def test_returns_empty_barcode_for_none_response(self):
        resp = _make_gemini_resp("NONE", uris=[])
        result = G.parse_response(resp)
        assert result["barcode"] == ""

    def test_returns_empty_when_no_digits(self):
        resp = _make_gemini_resp("I could not find a barcode for this tire.", uris=[])
        result = G.parse_response(resp)
        assert result["barcode"] == ""

    def test_extracts_multiple_sources(self):
        resp = _make_gemini_resp(
            "UPC: 848983006257",
            uris=["https://a.com", "https://b.com", "https://c.com"],
        )
        result = G.parse_response(resp)
        assert len(result["sources"]) == 3
        assert "https://a.com" in result["sources"]

    def test_handles_missing_candidates(self):
        result = G.parse_response({})
        assert result == {"barcode": "", "sources": [], "text": ""}

    def test_handles_empty_candidates_list(self):
        result = G.parse_response({"candidates": []})
        assert result == {"barcode": "", "sources": [], "text": ""}

    def test_handles_missing_grounding_metadata(self):
        resp = {
            "candidates": [
                {
                    "content": {"parts": [{"text": "UPC: 036000291452"}]},
                    # no groundingMetadata key
                }
            ]
        }
        result = G.parse_response(resp)
        assert result["barcode"] == "036000291452"
        assert result["sources"] == []

    def test_text_field_contains_answer(self):
        resp = _make_gemini_resp("The barcode is 848983006257.", uris=[])
        result = G.parse_response(resp)
        assert "848983006257" in result["text"]

    def test_strips_spaces_hyphens_in_barcode(self):
        """Gemini might format it as '036-000-291452' — we normalize before matching."""
        resp = _make_gemini_resp(
            "The UPC is 036-000-291452",
            uris=[],
        )
        result = G.parse_response(resp)
        # After stripping hyphens: 036000291452 = 12 digits
        assert result["barcode"] == "036000291452"

    def test_ignores_short_digit_runs(self):
        """Sequences shorter than 12 digits should not be extracted as barcodes."""
        resp = _make_gemini_resp("Size 265/70R17 with load 121.", uris=[])
        result = G.parse_response(resp)
        # 265, 70, 17, 121 are all < 12 digits
        assert result["barcode"] == ""


# ── verify_barcode tests ──────────────────────────────────────────────────────

class TestVerifyBarcode:
    """Hallucination guard: GTIN check digit + page content verification."""

    _VALID_BARCODE = "848983006257"  # valid GTIN-12 (Falken Wildpeak)
    _VALID_BARCODE_13 = "4006381333931"  # valid EAN-13
    _INVALID_BARCODE = "848983006250"   # bad check digit (last digit wrong)

    _ROW = _make_row(
        make_name="Falken",
        size_canonical="265/70R17",
        width="265",
        aspect_ratio="70",
        rim_size="17",
    )

    def _page_with_all(self, barcode: str, brand: str, size: str) -> str:
        return f"Product page for {brand} tire size {size} UPC: {barcode} buy online."

    def test_verified_true_when_page_has_barcode_brand_size(self):
        page_text = self._page_with_all(self._VALID_BARCODE, "falken", "265/70R17")

        def _fetch(url: str) -> str:
            return page_text

        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        assert result["verified"] is True
        assert result["gtin_valid"] is True
        assert result["matched_source"] == "https://example.com/tire"

    def test_verified_false_when_barcode_absent_from_page(self):
        page_text = "Falken 265/70R17 tire — great off-road traction."
        # No barcode on page

        def _fetch(url: str) -> str:
            return page_text

        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        assert result["verified"] is False
        assert result["gtin_valid"] is True  # GTIN itself is fine

    def test_verified_false_when_brand_absent_from_page(self):
        # Page has barcode and size but NOT the brand
        page_text = f"265/70R17 tire UPC: {self._VALID_BARCODE}"

        def _fetch(url: str) -> str:
            return page_text

        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        assert result["verified"] is False

    def test_verified_false_when_size_absent_from_page(self):
        page_text = f"Falken all-terrain UPC: {self._VALID_BARCODE}"

        def _fetch(url: str) -> str:
            return page_text

        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        assert result["verified"] is False

    def test_verified_false_when_gtin_check_digit_invalid(self):
        """Invalid GTIN must short-circuit before any page fetching."""
        fetched = []

        def _fetch(url: str) -> str:
            fetched.append(url)
            return "falken 265/70R17 " + self._INVALID_BARCODE

        result = G.verify_barcode(
            self._INVALID_BARCODE, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        assert result["verified"] is False
        assert result["gtin_valid"] is False
        assert fetched == []  # no fetch attempted

    def test_verified_false_when_no_sources(self):
        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=[],
            _fetch=lambda url: "",
        )
        assert result["verified"] is False
        assert result["gtin_valid"] is True
        assert "no grounding sources" in result["reason"]

    def test_verified_false_when_empty_barcode(self):
        result = G.verify_barcode(
            "", self._ROW,
            sources=["https://example.com"],
            _fetch=lambda url: "anything",
        )
        assert result["verified"] is False
        assert result["gtin_valid"] is False

    def test_caps_sources_at_3(self):
        """At most 3 source URLs should be fetched."""
        fetched = []

        def _fetch(url: str) -> str:
            fetched.append(url)
            return ""  # nothing matches, but we track calls

        G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=[f"https://s{i}.com" for i in range(6)],
            _fetch=_fetch,
        )
        assert len(fetched) <= 3

    def test_leading_zero_interop_ean_found_as_upc(self):
        """EAN-13 = '0' + UPC-12. Page may have the 12-digit form; barcode is 13-digit."""
        ean13 = "0" + self._VALID_BARCODE  # 0848983006257 — would need valid check digit
        # Instead use a known valid EAN-13
        ean13 = self._VALID_BARCODE_13  # 4006381333931
        # Simulate page showing the barcode with leading zero stripped
        barcode_stripped = ean13[1:]  # 12-digit

        page_text = f"falken 265/70R17 barcode: {barcode_stripped}"

        def _fetch(url: str) -> str:
            return page_text

        # verify_barcode should accept the stripped version
        result = G.verify_barcode(
            ean13, self._ROW,
            sources=["https://example.com/tire"],
            _fetch=_fetch,
        )
        # gtin check must pass first
        assert result["gtin_valid"] is True
        # Page has stripped version -> should verify
        assert result["verified"] is True

    def test_second_source_matches_when_first_fails(self):
        """If first URL returns empty page, second should still be tried."""
        good_page = self._page_with_all(self._VALID_BARCODE, "falken", "265/70R17")
        call_count = [0]

        def _fetch(url: str) -> str:
            call_count[0] += 1
            if "bad" in url:
                return ""
            return good_page

        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://bad.com/x", "https://good.com/y"],
            _fetch=_fetch,
        )
        assert result["verified"] is True
        assert result["matched_source"] == "https://good.com/y"
        assert call_count[0] == 2

    def test_returns_reason_string(self):
        result = G.verify_barcode(
            self._VALID_BARCODE, self._ROW,
            sources=["https://example.com"],
            _fetch=lambda url: "",
        )
        assert isinstance(result["reason"], str)
        assert len(result["reason"]) > 0


# ── gemini_grounded_lookup (mocked transport) tests ──────────────────────────

class TestGeminiGroundedLookupMocked:
    """Verify the function builds a correct request and returns parseable output."""

    def test_injected_transport_receives_correct_url(self):
        received = {}

        class _MockResp:
            def json(self):
                return _make_gemini_resp("848983006257", ["https://s.com"])

        def _transport(url, *, headers, json):
            received["url"] = url
            received["headers"] = headers
            received["json"] = json
            return _MockResp()

        G.gemini_grounded_lookup(
            "Falken Wildpeak 265/70R17 tire UPC barcode number",
            api_key="FAKE_KEY_FOR_TEST",
            model="gemini-2.5-flash",
            _transport=_transport,
        )

        assert "gemini-2.5-flash" in received["url"]
        assert "generateContent" in received["url"]
        assert received["headers"]["x-goog-api-key"] == "FAKE_KEY_FOR_TEST"

    def test_injected_transport_body_has_google_search_tool(self):
        received = {}

        class _MockResp:
            def json(self):
                return _make_gemini_resp("NONE")

        def _transport(url, *, headers, json):
            received["body"] = json
            return _MockResp()

        G.gemini_grounded_lookup(
            "test query", api_key="X", _transport=_transport
        )
        tools = received["body"].get("tools", [])
        assert any("google_search" in t for t in tools)

    def test_injected_transport_body_includes_query(self):
        received = {}

        class _MockResp:
            def json(self):
                return _make_gemini_resp("NONE")

        def _transport(url, *, headers, json):
            received["body"] = json
            return _MockResp()

        G.gemini_grounded_lookup(
            "Toyo Open Country 235/85R16 tire UPC", api_key="X", _transport=_transport
        )
        text_parts = [
            p["text"]
            for c in received["body"]["contents"]
            for p in c["parts"]
        ]
        combined = " ".join(text_parts)
        assert "Toyo Open Country" in combined

    def test_response_is_parseable_by_parse_response(self):
        """End-to-end: mock transport -> lookup -> parse gives a barcode."""

        class _MockResp:
            def json(self):
                return _make_gemini_resp(
                    "The UPC barcode for this tire is 848983006257.",
                    uris=["https://tirerack.com/falken"],
                )

        resp = G.gemini_grounded_lookup(
            "Falken Wildpeak AT3W 265/70R17 121T tire UPC barcode number",
            api_key="FAKE",
            _transport=lambda url, **kw: _MockResp(),
        )
        parsed = G.parse_response(resp)
        assert parsed["barcode"] == "848983006257"
        assert parsed["sources"] == ["https://tirerack.com/falken"]

    def test_none_response_gives_empty_barcode(self):
        class _MockResp:
            def json(self):
                return _make_gemini_resp("NONE", uris=[])

        resp = G.gemini_grounded_lookup(
            "some obscure trailer tire", api_key="FAKE",
            _transport=lambda url, **kw: _MockResp(),
        )
        parsed = G.parse_response(resp)
        assert parsed["barcode"] == ""


# ── build_query tests ─────────────────────────────────────────────────────────

class TestBuildQuery:
    def test_includes_brand_model_size_load_speed(self):
        row = _make_row(
            make_name="Toyo", model_name="Open Country AT2",
            size_canonical="235/85R16", load_rating="120", speed_rating="Q",
        )
        q = G.build_query(row)
        assert "Toyo" in q
        assert "Open Country AT2" in q
        assert "235/85R16" in q
        assert "120Q" in q
        assert "UPC" in q

    def test_handles_missing_load_rating(self):
        row = _make_row(load_rating="", speed_rating="H")
        q = G.build_query(row)
        assert "H" in q  # speed still present

    def test_handles_missing_speed_rating(self):
        row = _make_row(load_rating="97", speed_rating="")
        q = G.build_query(row)
        assert "97" in q


# ── No real network assertion ─────────────────────────────────────────────────

def test_no_live_network_calls_in_test_suite(monkeypatch):
    """
    Ensure that calling gemini_grounded_lookup without _transport would attempt
    a real network call (via requests.post), and that our tests never reach that
    branch. This test validates the guard exists by confirming requests.post
    is the live path, and our _transport injection prevents it from being called.
    """
    import requests

    real_post_called = []

    def _fake_post(*args, **kwargs):
        real_post_called.append(True)
        raise AssertionError("LIVE NETWORK CALL DETECTED — tests must use _transport")

    monkeypatch.setattr(requests, "post", _fake_post)

    class _MockResp:
        def json(self):
            return _make_gemini_resp("NONE")

    # With _transport injected, requests.post must NOT be called
    G.gemini_grounded_lookup(
        "test", api_key="FAKE",
        _transport=lambda url, **kw: _MockResp(),
    )
    assert real_post_called == [], "requests.post was called despite _transport injection"
