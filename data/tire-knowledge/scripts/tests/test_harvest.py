"""
test_harvest.py — Unit tests for harvest_tiresandwheels.extract_product_urls,
extract_products, split_load_speed, and map_type_season.
No network calls. No Firecrawl credits.
"""

import os
import sys

# Make sure scripts/ is on the path
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from harvest_tiresandwheels import (
    extract_product_urls,
    extract_products,
    split_load_speed,
    map_type_season,
)

# Path to the saved real fixture
_FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "model_page_sample.md")
with open(_FIXTURE_PATH, encoding="utf-8") as _f:
    _FIXTURE_MD = _f.read()


# ---------------------------------------------------------------------------
# Inline markdown samples
# ---------------------------------------------------------------------------

SAMPLE_MARKDOWN = """
# Hankook Dynapro ATm RF10

Here are the available sizes:

- [265/70R17](https://www.tiresandwheels.com/product/tire/EC100001/Hankook/1234567890123_Dynapro-ATm_0884798018888_265+70R17)
- [275/65R18](https://www.tiresandwheels.com/product/tire/EC100002/Hankook/1234567890124_Dynapro-ATm_0884798018895_275+65R18)

Some noise links:
- https://www.tiresandwheels.com/catalog/tires/Hankook/SC328/Dynapro-ATm-RF10/
- https://otherdomain.com/product/tire/EC100003/whatever

And a duplicate of the first:
- [265/70R17 again](https://www.tiresandwheels.com/product/tire/EC100001/Hankook/1234567890123_Dynapro-ATm_0884798018888_265+70R17)
"""

SAMPLE_MARKDOWN_THREE = """
Products:
https://www.tiresandwheels.com/product/tire/EC200001/Falken/28034300/Wildpeak-A/T3W_848983006257_265+70R17
https://www.tiresandwheels.com/product/tire/EC200002/Falken/28034300/Wildpeak-A/T3W_848983006455_LT265+70R17
https://www.tiresandwheels.com/product/tire/EC200003/Falken/28034300/Wildpeak-A/T3W_848983006493_285+70R17

Noise: https://www.tiresandwheels.com/catalog/tires/Falken/whatever
"""

SAMPLE_MARKDOWN_EMPTY = """
No product links here.
https://www.tiresandwheels.com/catalog/tires/Brand/SC001/Model/
https://otherdomain.com/product/tire/something
"""


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_extracts_two_product_urls_and_deduplicates():
    """Two unique product URLs, one duplicate — should return exactly 2."""
    urls = extract_product_urls(SAMPLE_MARKDOWN)
    assert len(urls) == 2, f"Expected 2, got {len(urls)}: {urls}"
    assert all("tiresandwheels.com/product/tire/" in u for u in urls)


def test_first_url_is_correct():
    urls = extract_product_urls(SAMPLE_MARKDOWN)
    assert "EC100001" in urls[0]


def test_second_url_is_correct():
    urls = extract_product_urls(SAMPLE_MARKDOWN)
    assert "EC100002" in urls[1]


def test_extracts_three_product_urls():
    """Three distinct product URLs — should return exactly 3."""
    urls = extract_product_urls(SAMPLE_MARKDOWN_THREE)
    assert len(urls) == 3, f"Expected 3, got {len(urls)}: {urls}"


def test_catalog_urls_are_excluded():
    """Catalog-style URLs (/catalog/tires/...) must NOT appear in output."""
    urls = extract_product_urls(SAMPLE_MARKDOWN)
    assert all("/catalog/" not in u for u in urls)


def test_other_domains_are_excluded():
    """URLs from other domains must not appear."""
    urls = extract_product_urls(SAMPLE_MARKDOWN)
    assert all("tiresandwheels.com" in u for u in urls)


def test_empty_markdown_returns_empty_list():
    """Markdown with no product URLs returns an empty list."""
    urls = extract_product_urls(SAMPLE_MARKDOWN_EMPTY)
    assert urls == [], f"Expected [], got {urls}"


def test_dedup_preserves_order():
    """Deduplication keeps first-seen order."""
    urls = extract_product_urls(SAMPLE_MARKDOWN_THREE)
    assert "EC200001" in urls[0]
    assert "EC200002" in urls[1]
    assert "EC200003" in urls[2]


def test_returns_list():
    """Return type is always a list."""
    result = extract_product_urls("")
    assert isinstance(result, list)


# ---------------------------------------------------------------------------
# split_load_speed unit tests
# ---------------------------------------------------------------------------

def test_split_load_speed_single():
    """109W -> load=109, speed=W"""
    load, speed = split_load_speed("109W")
    assert load == "109", f"Expected '109', got '{load}'"
    assert speed == "W", f"Expected 'W', got '{speed}'"


def test_split_load_speed_dual():
    """121/118S -> load=121/118, speed=S"""
    load, speed = split_load_speed("121/118S")
    assert load == "121/118", f"Expected '121/118', got '{load}'"
    assert speed == "S", f"Expected 'S', got '{speed}'"


def test_split_load_speed_single_letter_q():
    """116Q -> load=116, speed=Q"""
    load, speed = split_load_speed("116Q")
    assert load == "116", f"Expected '116', got '{load}'"
    assert speed == "Q", f"Expected 'Q', got '{speed}'"


def test_split_load_speed_bad_token():
    """Unrecognised token -> ('', '')"""
    load, speed = split_load_speed("badtoken")
    assert load == "", f"Expected '', got '{load}'"
    assert speed == "", f"Expected '', got '{speed}'"


def test_split_load_speed_empty():
    """Empty string -> ('', '')"""
    assert split_load_speed("") == ("", "")


# ---------------------------------------------------------------------------
# map_type_season unit tests
# ---------------------------------------------------------------------------

def test_map_type_season_performance_summer():
    """Performance/Summer -> tire_type=performance, season=summer"""
    tire_type, season = map_type_season("Performance/Summer")
    assert tire_type == "performance", f"Got tire_type='{tire_type}'"
    assert season == "summer", f"Got season='{season}'"


def test_map_type_season_all_terrain():
    """All Terrain (no season) -> tire_type=all_terrain, season=''"""
    tire_type, season = map_type_season("All Terrain")
    assert tire_type == "all_terrain", f"Got tire_type='{tire_type}'"
    assert season == "", f"Got season='{season}'"


def test_map_type_season_highway_all_season():
    """Highway/All Season -> tire_type=highway, season=all_season"""
    tire_type, season = map_type_season("Highway/All Season")
    assert tire_type == "highway", f"Got tire_type='{tire_type}'"
    assert season == "all_season", f"Got season='{season}'"


def test_map_type_season_empty():
    """Empty string -> ('', '')"""
    assert map_type_season("") == ("", "")


def test_map_type_season_never_raises():
    """map_type_season must never raise on arbitrary input."""
    for val in [None, 123, "???", "/", "Summer", "Winter"]:
        try:
            result = map_type_season(val)  # type: ignore[arg-type]
            assert isinstance(result, tuple) and len(result) == 2
        except Exception as exc:
            assert False, f"map_type_season raised on {val!r}: {exc}"


# ---------------------------------------------------------------------------
# extract_products fixture tests (real model_page_sample.md)
# ---------------------------------------------------------------------------

def test_fixture_extract_products_returns_enough_rows():
    """Fixture must yield >= 5 product dicts."""
    products = extract_products(_FIXTURE_MD)
    assert len(products) >= 5, f"Expected >= 5 rows, got {len(products)}"


def test_fixture_all_rows_have_url():
    """Every product dict from the fixture must have a non-empty url."""
    products = extract_products(_FIXTURE_MD)
    for p in products:
        assert p["url"], f"Row missing url: {p}"


def test_fixture_known_row_load_speed():
    """
    The row for EC244957 (255/55R18, 109W) should have
    load_index='109' and speed_rating='W'.
    """
    products = extract_products(_FIXTURE_MD)
    match = [p for p in products if "EC244957" in p["url"]]
    assert match, "EC244957 row not found in fixture"
    row = match[0]
    assert row["load_index"] == "109", f"Expected '109', got '{row['load_index']}'"
    assert row["speed_rating"] == "W", f"Expected 'W', got '{row['speed_rating']}'"


def test_fixture_known_row_type_season():
    """
    The rows in the fixture all have type 'Performance/Summer' ->
    season='summer', tire_type='performance'.
    """
    products = extract_products(_FIXTURE_MD)
    # At least one row must have summer + performance
    summer_perf = [p for p in products if p["season"] == "summer" and p["tire_type"] == "performance"]
    assert summer_perf, "No row with season=summer + tire_type=performance found"


def test_fixture_deduplication():
    """extract_products must deduplicate by URL."""
    products = extract_products(_FIXTURE_MD)
    urls = [p["url"] for p in products]
    assert len(urls) == len(set(urls)), "Duplicate URLs found in extract_products output"


def test_fixture_backward_compat_extract_product_urls():
    """
    extract_product_urls must find at least as many URLs as extract_products
    on the fixture (the fixture is table-only, so both should agree on set membership).
    """
    urls_old = set(extract_product_urls(_FIXTURE_MD))
    urls_new = {p["url"] for p in extract_products(_FIXTURE_MD)}
    # Every URL found by extract_products must also appear in extract_product_urls
    missing = urls_new - urls_old
    assert not missing, (
        f"extract_product_urls missed URLs that extract_products found: {missing}"
    )


# ---------------------------------------------------------------------------
# Synthetic no-drop test: row with no type cell still yields a product dict
# ---------------------------------------------------------------------------

_SYNTHETIC_NO_TYPE_TABLE = """\
| Header1 | Tire Size | Service | Load Range | UTQG |
| --- | --- | --- | --- | --- |
| [28063845](https://www.tiresandwheels.com/product/tire/EC999001/Brand/SKU1/Model_000000000001_255+55R18) | 255/55R18 | 109W | XL | 300 |
"""


def test_synthetic_no_type_cell_still_returns_row():
    """A table row with no type cell must still yield a product dict (no drop)."""
    products = extract_products(_SYNTHETIC_NO_TYPE_TABLE)
    assert len(products) == 1, f"Expected 1 product, got {len(products)}: {products}"
    row = products[0]
    assert "EC999001" in row["url"], "URL not captured"
    assert row["size"] == "255/55R18", f"Size not captured: {row['size']}"
    # type and season should be blank — not an error
    assert row["tire_type"] == "", f"Expected empty tire_type, got '{row['tire_type']}'"
    assert row["season"] == "", f"Expected empty season, got '{row['season']}'"
