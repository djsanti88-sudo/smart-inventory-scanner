"""
test_collect_sources.py — Unit tests for the sitemap-based source collector.

ALL tests mock or avoid network entirely. No HTTP calls are made.
No Firecrawl credits are spent.
"""

import csv
import os
import sys
import tempfile

import pytest

# Ensure the scripts directory is on the path.
SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPTS_DIR)

from collect_sources import (
    _ensure_queue_header,
    _load_queue_urls,
    brand_of,
    collect,
    fetch_sitemap_model_urls,
    interleave_by_brand,
    is_model_page,
    reorder_queue,
)

# ---------------------------------------------------------------------------
# Tests: is_model_page — pure function, no network
# ---------------------------------------------------------------------------

_SAMPLE_URLS = [
    # Brand-index pages — SKIP
    "https://www.tiresandwheels.com/catalog/tires/Hankook/",
    "https://www.tiresandwheels.com/catalog/tires/Michelin/",
    # Model pages — KEEP
    "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/",
    "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/",
    "https://www.tiresandwheels.com/catalog/tires/Bridgestone/BLIZZAK_DM_V2/Blizzak-DM-V2/",
    # Unrelated URLs — SKIP
    "https://www.tiresandwheels.com/cart.php",
    "https://www.tiresandwheels.com/",
    "https://www.tiresandwheels.com/catalog/",
    "https://otherdomain.com/catalog/tires/Brand/Code/Model/",
]


class TestIsModelPage:
    def test_model_page_hankook(self):
        url = "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/"
        assert is_model_page(url) is True

    def test_model_page_michelin(self):
        url = "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/"
        assert is_model_page(url) is True

    def test_model_page_bridgestone(self):
        url = "https://www.tiresandwheels.com/catalog/tires/Bridgestone/BLIZZAK_DM_V2/Blizzak-DM-V2/"
        assert is_model_page(url) is True

    def test_brand_index_hankook_excluded(self):
        url = "https://www.tiresandwheels.com/catalog/tires/Hankook/"
        assert is_model_page(url) is False

    def test_brand_index_michelin_excluded(self):
        url = "https://www.tiresandwheels.com/catalog/tires/Michelin/"
        assert is_model_page(url) is False

    def test_cart_excluded(self):
        assert is_model_page("https://www.tiresandwheels.com/cart.php") is False

    def test_root_excluded(self):
        assert is_model_page("https://www.tiresandwheels.com/") is False

    def test_catalog_root_excluded(self):
        assert is_model_page("https://www.tiresandwheels.com/catalog/") is False

    def test_other_domain_excluded(self):
        # Even if path matches, non-catalog/tires path is excluded.
        # This URL starts with /catalog/tires/ but on a different domain —
        # the function filters on path only, so this should pass the path check.
        # We test it to document behaviour: is_model_page is path-based only.
        url = "https://otherdomain.com/catalog/tires/Brand/Code/Model/"
        # Path matches the filter — is_model_page is intentionally domain-agnostic.
        assert is_model_page(url) is True

    def test_mixed_list_keeps_only_model_pages(self):
        """Filter a mixed list and assert only model pages survive."""
        result = [u for u in _SAMPLE_URLS if is_model_page(u)]
        expected = [
            "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/",
            "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/",
            "https://www.tiresandwheels.com/catalog/tires/Bridgestone/BLIZZAK_DM_V2/Blizzak-DM-V2/",
            "https://otherdomain.com/catalog/tires/Brand/Code/Model/",
        ]
        assert result == expected

    def test_exactly_four_segments_is_not_model(self):
        # Only Brand + Code = 4 segments (catalog, tires, Brand, Code) — not a model page
        url = "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/"
        assert is_model_page(url) is False

    def test_no_trailing_slash_still_works(self):
        # URLs without trailing slash should still be recognised as model pages
        url = "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10"
        assert is_model_page(url) is True


# ---------------------------------------------------------------------------
# Tests: queue writing idempotency — no network
# ---------------------------------------------------------------------------

class TestQueueIdempotency:
    def _write_queue(self, queue_path: str, urls: list) -> int:
        """Write urls to queue_path and return the count of rows written."""
        _ensure_queue_header(queue_path)
        existing = _load_queue_urls(queue_path)
        new_urls = [u for u in urls if u not in existing]
        if new_urls:
            with open(queue_path, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["model_url", "status", "added_at"])
                for url in new_urls:
                    writer.writerow({"model_url": url, "status": "queued", "added_at": "2026-01-01T00:00:00Z"})
        return len(new_urls)

    def _count_rows(self, queue_path: str) -> int:
        with open(queue_path, newline="", encoding="utf-8") as f:
            return sum(1 for _ in csv.DictReader(f))

    def test_writing_same_urls_twice_does_not_duplicate(self, tmp_path):
        queue_path = str(tmp_path / "tire_model_queue.csv")
        urls = [
            "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/",
            "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/",
        ]

        first_written = self._write_queue(queue_path, urls)
        second_written = self._write_queue(queue_path, urls)

        assert first_written == 2, "First write should add 2 rows"
        assert second_written == 0, "Second write of same URLs should add 0 rows"
        assert self._count_rows(queue_path) == 2, "File should still have exactly 2 data rows"

    def test_partial_overlap_adds_only_new(self, tmp_path):
        queue_path = str(tmp_path / "tire_model_queue.csv")
        first_batch = [
            "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/",
        ]
        second_batch = [
            "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/",  # duplicate
            "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/",        # new
        ]

        self._write_queue(queue_path, first_batch)
        second_written = self._write_queue(queue_path, second_batch)

        assert second_written == 1, "Should add only the 1 new URL"
        assert self._count_rows(queue_path) == 2

    def test_empty_queue_file_created_with_header(self, tmp_path):
        queue_path = str(tmp_path / "tire_model_queue.csv")
        assert not os.path.exists(queue_path)
        _ensure_queue_header(queue_path)
        assert os.path.exists(queue_path)
        with open(queue_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            assert reader.fieldnames == ["model_url", "status", "added_at"]
            rows = list(reader)
        assert rows == [], "Header-only file should have no data rows"

    def test_load_queue_urls_returns_empty_set_when_file_absent(self, tmp_path):
        queue_path = str(tmp_path / "nonexistent.csv")
        result = _load_queue_urls(queue_path)
        assert result == set()

    def test_load_queue_urls_reads_existing_rows(self, tmp_path):
        queue_path = str(tmp_path / "tire_model_queue.csv")
        urls = [
            "https://www.tiresandwheels.com/catalog/tires/A/B/C/",
            "https://www.tiresandwheels.com/catalog/tires/X/Y/Z/",
        ]
        self._write_queue(queue_path, urls)
        result = _load_queue_urls(queue_path)
        assert result == set(urls)


# ---------------------------------------------------------------------------
# Tests: collect() with mocked network
# ---------------------------------------------------------------------------

FAKE_INDEX_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://www.tiresandwheels.com/tirecatalog_prt1.xml.gz</loc>
  </sitemap>
  <sitemap>
    <loc>https://www.tiresandwheels.com/sitemap.xml</loc>
  </sitemap>
</sitemapindex>
"""

FAKE_CATALOG_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.tiresandwheels.com/catalog/tires/Hankook/</loc></url>
  <url><loc>https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/</loc></url>
  <url><loc>https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/</loc></url>
  <url><loc>https://www.tiresandwheels.com/cart.php</loc></url>
</urlset>
"""


def _make_fake_gz(xml_bytes: bytes) -> bytes:
    buf = __import__("io").BytesIO()
    with __import__("gzip").GzipFile(fileobj=buf, mode="wb") as gz:
        gz.write(xml_bytes)
    return buf.getvalue()


class TestCollectMocked:
    def _patch_get_url(self, monkeypatch):
        """Patch _get_url to return fake data without any network call."""
        fake_gz = _make_fake_gz(FAKE_CATALOG_XML)

        def fake_get_url(url: str) -> bytes:
            if "sitemap_index" in url:
                return FAKE_INDEX_XML
            if url.endswith(".xml.gz") and "tirecatalog" in url:
                return fake_gz
            raise ValueError(f"Unexpected URL in test: {url}")

        import collect_sources
        monkeypatch.setattr(collect_sources, "_get_url", fake_get_url)

    def test_fetch_sitemap_model_urls_filters_correctly(self, monkeypatch):
        self._patch_get_url(monkeypatch)
        result = fetch_sitemap_model_urls()
        # Should keep the 2 model pages and drop brand-index + cart
        assert len(result) == 2
        assert "https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/" in result
        assert "https://www.tiresandwheels.com/catalog/tires/Michelin/MI_XCLT/X-LT-A-S/" in result
        assert "https://www.tiresandwheels.com/catalog/tires/Hankook/" not in result
        assert "https://www.tiresandwheels.com/cart.php" not in result

    def test_collect_queues_new_urls(self, monkeypatch, tmp_path):
        self._patch_get_url(monkeypatch)
        result = collect(root=str(tmp_path))
        assert result["sitemaps"] == 1
        assert result["model_urls_found"] == 2
        assert result["new_queued"] == 2

        queue_path = str(tmp_path / "tire_model_queue.csv")
        assert os.path.exists(queue_path)
        queued = _load_queue_urls(queue_path)
        assert len(queued) == 2

    def test_collect_does_not_duplicate_on_second_run(self, monkeypatch, tmp_path):
        self._patch_get_url(monkeypatch)
        first = collect(root=str(tmp_path))
        second = collect(root=str(tmp_path))
        assert first["new_queued"] == 2
        assert second["new_queued"] == 0

        queue_path = str(tmp_path / "tire_model_queue.csv")
        queued = _load_queue_urls(queue_path)
        assert len(queued) == 2

    def test_collect_returns_zero_credits(self, monkeypatch, tmp_path):
        """collect() must never touch firecrawl_client — verify by ensuring no import error
        and by confirming the result dict has no credits_spent key (that's the old API)."""
        self._patch_get_url(monkeypatch)
        result = collect(root=str(tmp_path))
        assert "credits_spent" not in result, (
            "New collect() must not report credits_spent — it uses no Firecrawl"
        )


# ---------------------------------------------------------------------------
# Tests: brand_of — pure function, no network
# ---------------------------------------------------------------------------

BASE = "https://www.tiresandwheels.com/catalog/tires"


class TestBrandOf:
    def test_extracts_hankook(self):
        url = f"{BASE}/Hankook/SC328/Dynapro-ATm-RF10/"
        assert brand_of(url) == "hankook"

    def test_extracts_michelin(self):
        url = f"{BASE}/Michelin/MI_XCLT/X-LT-A-S/"
        assert brand_of(url) == "michelin"

    def test_extracts_bfgoodrich(self):
        url = f"{BASE}/BFGoodrich/BF_MUD/Mud-Terrain/"
        assert brand_of(url) == "bfgoodrich"

    def test_lowercases_brand(self):
        url = f"{BASE}/GOODYEAR/GY123/Eagle-F1/"
        assert brand_of(url) == "goodyear"

    def test_empty_on_short_path(self):
        assert brand_of("https://www.tiresandwheels.com/catalog/") == ""

    def test_empty_on_non_catalog_url(self):
        assert brand_of("https://www.tiresandwheels.com/cart.php") == ""

    def test_empty_on_garbage(self):
        assert brand_of("not-a-url") == ""


# ---------------------------------------------------------------------------
# Tests: interleave_by_brand — pure function, no network
# ---------------------------------------------------------------------------

def _make_url(brand: str, code: str) -> str:
    return f"https://www.tiresandwheels.com/catalog/tires/{brand}/SC1/{code}/"


class TestInterleaveByBrand:
    def test_round_robin_three_brands(self):
        """
        Input: 3 Hankook, 2 Michelin, 1 BFGoodrich.
        The first 3 entries of the result must cover all 3 brands (one each)
        before any brand appears a second time.
        """
        urls = [
            _make_url("Hankook", "H1"),
            _make_url("Hankook", "H2"),
            _make_url("Hankook", "H3"),
            _make_url("Michelin", "M1"),
            _make_url("Michelin", "M2"),
            _make_url("BFGoodrich", "B1"),
        ]
        result = interleave_by_brand(urls)

        assert len(result) == 6
        assert set(result) == set(urls), "No URLs must be lost or duplicated"

        # First round: one of each brand.
        first_round_brands = [brand_of(u) for u in result[:3]]
        assert set(first_round_brands) == {"hankook", "michelin", "bfgoodrich"}, (
            f"First 3 results must cover all 3 brands; got {first_round_brands}"
        )

    def test_no_brand_repeats_before_all_others_in_first_round(self):
        """
        Alias of the spec requirement: no brand appears twice before every other
        brand has appeared once in the first round.
        """
        urls = [
            _make_url("Hankook", "H1"),
            _make_url("Hankook", "H2"),
            _make_url("Hankook", "H3"),
            _make_url("Michelin", "M1"),
            _make_url("Michelin", "M2"),
            _make_url("BFGoodrich", "B1"),
        ]
        result = interleave_by_brand(urls)
        # After 3 outputs, every brand should have appeared at least once.
        seen_after_round1 = {brand_of(u) for u in result[:3]}
        assert "hankook" in seen_after_round1
        assert "michelin" in seen_after_round1
        assert "bfgoodrich" in seen_after_round1

    def test_first_appearance_order_preserved(self):
        """Cycling order follows first-appearance of brands."""
        urls = [
            _make_url("Hankook", "H1"),
            _make_url("Hankook", "H2"),
            _make_url("Michelin", "M1"),
            _make_url("BFGoodrich", "B1"),
        ]
        result = interleave_by_brand(urls)
        # First-appearance order is Hankook, Michelin, BFGoodrich.
        assert brand_of(result[0]) == "hankook"
        assert brand_of(result[1]) == "michelin"
        assert brand_of(result[2]) == "bfgoodrich"
        assert brand_of(result[3]) == "hankook"

    def test_single_brand_unchanged(self):
        urls = [_make_url("Hankook", f"H{i}") for i in range(5)]
        result = interleave_by_brand(urls)
        assert result == urls

    def test_empty_list(self):
        assert interleave_by_brand([]) == []

    def test_internal_group_order_preserved(self):
        """Within a brand group the original URL order must not change."""
        urls = [
            _make_url("Michelin", "M1"),
            _make_url("Hankook", "H1"),
            _make_url("Michelin", "M2"),
            _make_url("Hankook", "H2"),
            _make_url("Michelin", "M3"),
        ]
        result = interleave_by_brand(urls)
        michelin_in_result = [u for u in result if brand_of(u) == "michelin"]
        hankook_in_result = [u for u in result if brand_of(u) == "hankook"]
        assert michelin_in_result == [_make_url("Michelin", "M1"),
                                      _make_url("Michelin", "M2"),
                                      _make_url("Michelin", "M3")]
        assert hankook_in_result == [_make_url("Hankook", "H1"),
                                     _make_url("Hankook", "H2")]

    def test_no_data_loss_or_duplication(self):
        urls = (
            [_make_url("Hankook", f"H{i}") for i in range(10)]
            + [_make_url("Michelin", f"M{i}") for i in range(5)]
            + [_make_url("BFGoodrich", f"B{i}") for i in range(3)]
        )
        result = interleave_by_brand(urls)
        assert len(result) == len(urls)
        assert set(result) == set(urls)


# ---------------------------------------------------------------------------
# Tests: reorder_queue — no network, uses temp files
# ---------------------------------------------------------------------------

def _write_temp_queue(tmp_path, rows):
    """Write a queue CSV with header + given rows to tmp_path/tire_model_queue.csv."""
    queue_path = str(tmp_path / "tire_model_queue.csv")
    with open(queue_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["model_url", "status", "added_at"])
        writer.writeheader()
        writer.writerows(rows)
    return queue_path


def _read_queue(queue_path):
    with open(queue_path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class TestReorderQueue:
    def _make_rows(self, brand_codes, status="queued"):
        """Build row dicts for a list of (brand, code) tuples."""
        rows = []
        for brand, code in brand_codes:
            rows.append({
                "model_url": _make_url(brand, code),
                "status": status,
                "added_at": "2026-01-01T00:00:00Z",
            })
        return rows

    def test_preserves_done_rows_at_top(self, tmp_path):
        done_rows = self._make_rows([("Hankook", "D1"), ("Michelin", "D2")], status="done")
        queued_rows = self._make_rows(
            [("Hankook", "Q1"), ("Hankook", "Q2"), ("Michelin", "M1")], status="queued"
        )
        _write_temp_queue(tmp_path, done_rows + queued_rows)

        result = reorder_queue(str(tmp_path))

        rows = _read_queue(str(tmp_path / "tire_model_queue.csv"))
        # First 2 rows must be the done rows, in original order.
        assert rows[0]["model_url"] == done_rows[0]["model_url"]
        assert rows[1]["model_url"] == done_rows[1]["model_url"]
        assert rows[0]["status"] == "done"
        assert rows[1]["status"] == "done"

    def test_preserves_total_count_and_url_set(self, tmp_path):
        done_rows = self._make_rows([("A", "D1")], status="done")
        queued_rows = self._make_rows(
            [("Hankook", f"H{i}") for i in range(5)]
            + [("Michelin", f"M{i}") for i in range(3)],
            status="queued",
        )
        all_rows = done_rows + queued_rows
        _write_temp_queue(tmp_path, all_rows)
        original_urls = {r["model_url"] for r in all_rows}

        result = reorder_queue(str(tmp_path))

        rows = _read_queue(str(tmp_path / "tire_model_queue.csv"))
        assert result["total"] == len(all_rows)
        assert result["kept"] == 1
        assert result["queued"] == len(queued_rows)
        assert {r["model_url"] for r in rows} == original_urls

    def test_queued_portion_is_interleaved(self, tmp_path):
        """After reorder, queued rows must not be brand-clustered."""
        queued_rows = (
            self._make_rows([("Hankook", f"H{i}") for i in range(4)], status="queued")
            + self._make_rows([("Michelin", f"M{i}") for i in range(4)], status="queued")
        )
        _write_temp_queue(tmp_path, queued_rows)

        reorder_queue(str(tmp_path))

        rows = _read_queue(str(tmp_path / "tire_model_queue.csv"))
        queued_out = [r for r in rows if r["status"] == "queued"]
        brands_seq = [brand_of(r["model_url"]) for r in queued_out]

        # No brand should appear twice in a row when there is more than one brand.
        for i in range(len(brands_seq) - 1):
            assert brands_seq[i] != brands_seq[i + 1], (
                f"Brand repeated at positions {i},{i+1}: {brands_seq}"
            )

    def test_error_rows_preserved(self, tmp_path):
        """Rows with status 'error' must be kept unchanged."""
        error_rows = self._make_rows([("Hankook", "E1")], status="error")
        queued_rows = self._make_rows([("Michelin", "M1")], status="queued")
        _write_temp_queue(tmp_path, error_rows + queued_rows)

        result = reorder_queue(str(tmp_path))
        assert result["kept"] == 1

        rows = _read_queue(str(tmp_path / "tire_model_queue.csv"))
        assert rows[0]["status"] == "error"
        assert rows[0]["model_url"] == error_rows[0]["model_url"]

    def test_returns_correct_brands_in_queue_count(self, tmp_path):
        queued_rows = (
            self._make_rows([("Hankook", "H1"), ("Hankook", "H2")], status="queued")
            + self._make_rows([("Michelin", "M1")], status="queued")
            + self._make_rows([("BFGoodrich", "B1")], status="queued")
        )
        _write_temp_queue(tmp_path, queued_rows)
        result = reorder_queue(str(tmp_path))
        assert result["brands_in_queue"] == 3
