# Task 10 Report — Enrichment fields from model-page markdown

## Changes

### `scripts/harvest_tiresandwheels.py`

Added three new pure functions and updated `harvest()`:

- **`split_load_speed(token)`** — splits a load+speed token (e.g. "109W", "121/118S",
  "116Q") into `(load_index, speed_rating)`. Returns `("", "")` on no match. Never raises.

- **`map_type_season(type_cell)`** — splits a type cell like "Performance/Summer" or
  "Highway/All Season" into `(tire_type, season)`. Season tokens are recognized
  case-insensitively; the remainder is mapped to snake_case using a known-phrase table
  (performance, all_terrain, mud_terrain, highway, touring, highway_terrain) or falls back
  to snake_case from the raw text. Never raises.

- **`extract_products(markdown)`** — scans each `|`-delimited table row containing a
  `/product/tire/` URL, identifies cells by pattern (not by hard-coded index), and returns
  a list of dicts with `{url, size, load_index, speed_rating, tire_type, season}`.
  Deduplicates by URL. Missing fields default to `""`. A row is never dropped for missing
  enrichment.

- **`extract_product_urls(markdown)`** — restored to original broad regex scan (works in
  any markdown context: tables, list items, prose). This preserves backward compatibility
  with all existing tests and callers.

- **`harvest()`** — after `parse_url(url)` builds the identity, the four enrichment fields
  (`load_index`, `speed_rating`, `tire_type`, `season`) are merged from `extract_products`
  output matched by URL. The URL/`parse_url` result remains authoritative for
  barcode/size/mpn/sku/brand/model. Routing and drop logic are **unchanged**.

## Test output

```
scripts/tests/test_harvest.py: 26 passed
Full suite (scripts/tests/): 113 passed in 0.16s
```

## Example extracted rows

```python
{'url': 'https://www.tiresandwheels.com/product/tire/EC244957/Falken/28063845/Azenis-FK510-SUV_848983017772_255+55R18',
 'size': '255/55R18', 'load_index': '109', 'speed_rating': 'W',
 'tire_type': 'performance', 'season': 'summer'}

{'url': 'https://www.tiresandwheels.com/product/tire/EC244959/Falken/28065949/Azenis-FK510-SUV_848983017758_255+50R19',
 'size': '255/50R19', 'load_index': '107', 'speed_rating': 'Y',
 'tire_type': 'performance', 'season': 'summer'}
```

## Routing / drop guarantee

No rows are dropped or rejected for missing enrichment fields.
`write_outputs.route()` and `validate.is_trusted_identity()` are unchanged.
Trust is still decided by barcode + (MPN or SKU) + brand + model + size.
`load_index`, `speed_rating`, `tire_type`, `season` are best-effort and simply
increase `field_completeness_score` when filled.

## Firecrawl credits

Zero credits used. All parsing is from already-scraped markdown. Tests use a
saved fixture (`scripts/tests/fixtures/model_page_sample.md`). No network calls.
