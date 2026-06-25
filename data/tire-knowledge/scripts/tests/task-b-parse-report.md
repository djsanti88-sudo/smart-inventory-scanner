# Task B Parse Report — upcitemdb_parse.py

## Status
COMPLETE — all 19 new tests pass; full suite 136/136 green.

## Files Created
- `scripts/upcitemdb_parse.py` — parser module
- `scripts/tests/test_upcitemdb_parse.py` — 19 tests, all offline/fixture-only

## Functions

### `extract_rows(html) -> list[(upc, name)]`
Regex-scans `rImage` divs for `href="/upc/<digits>"` + `<p>name</p>`. Deduplicates by UPC.

### `parse_name(name) -> dict`
Finds the tire-size token (standard, ZR, and floatation with optional LT prefix),
pre-strips Z from ZR before calling `validate.normalize_size`. Extracts load/speed from the
token immediately after the size. Classifies tire_type from explicit keyword search (All Terrain,
Mud Terrain, Highway Terrain, Touring) with fallback to trailing category (Light Truck/Passenger/
Trailer Tire). Extracts season keywords. Extracts MPN via regex in model text.
Returns `{}` if no size normalizes (filters out bike tires, gauges, etc.).

### `parse_page(html, brand) -> list[dict]`
Calls `extract_rows` + `parse_name` for each row; skips rows where `parse_name` returns `{}`.
Overrides brand with the canonical brand argument. Returns list of identity dicts with keys:
`brand, model, mpn, barcode, size_canonical, size_compact, load_index, speed_rating, tire_type, season, source_url`.

## Test Output
```
19 passed in 0.06s  (new suite)
136 passed in 0.20s (full suite)
```

## Example Parsed Rows (3 of 45)

```json
{
  "brand": "Fortune", "model": "ST01", "mpn": "ST01",
  "barcode": "840063601130", "size_canonical": "ST235/85R16",
  "size_compact": "2358516", "load_index": "125/121", "speed_rating": "M",
  "tire_type": "trailer", "season": "", "source_url": ""
}
{
  "brand": "Fortune", "model": "Tormenta A/T FSR308", "mpn": "FSR308",
  "barcode": "840139631771", "size_canonical": "245/70R17",
  "size_compact": "2457017", "load_index": "110", "speed_rating": "T",
  "tire_type": "all_terrain", "season": "", "source_url": ""
}
{
  "brand": "Fortune", "model": "Viento FSR702", "mpn": "FSR702",
  "barcode": "840139633270", "size_canonical": "235/40R18",
  "size_compact": "2354018", "load_index": "95", "speed_rating": "Y",
  "tire_type": "passenger", "season": "all_season", "source_url": ""
}
```

## Parsed / Skipped Counts (Fortune fixture)
- Total extracted UPCs: 45
- Successfully parsed: 45
- Skipped (no valid size): 0

The Fortune fixture contains only legitimate tire products (no bike tires, gauges, etc.),
so 0 rows are filtered. The bike-tire filter is confirmed working via the unit test
`test_parse_name_bike_tire_returns_empty` (name "Arisun Cutting Edge 20x2.1 BK" -> `{}`).

## Concerns / Limitations

1. **ZR tires**: `validate.normalize_size` does not accept `ZR` format (e.g. `235/40ZR18`).
   The parser strips Z to get `R` before normalizing. The canonical stored is `235/40R18`
   (not `235/40ZR18`). This is consistent with existing corpus behavior and is correct
   for dedup/matching purposes, but the original ZR designation is lost.

2. **model field includes model name + MPN token**: e.g. `"Tormenta A/T FSR308"`.
   The caller may want to strip the MPN from the model string downstream; current output
   preserves it for human readability and downstream matching.

3. **LT floatation canonical**: `normalize_size("LT37X13.50R20")` returns `"LT37/13.50R20"`
   (SIZE_RE match, not FLOT_RE). This is consistent with what `validate.py` produces for
   this input — no code change needed, but callers should be aware the canonical uses `/`
   not `x` for LT-floatation.

4. **Bike/non-tire filter**: relies on `validate.normalize_size` returning `None` for
   non-standard size tokens (e.g. `20x2.1`, `700x25`). The FLOT_RE in validate.py requires
   exactly 2-digit OD (`\d{2}`) so `20x2.1` does not match. Confirmed working.
