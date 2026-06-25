# Task 8 Report — Source Collection via Firecrawl Map

**Date:** 2026-06-22
**Status:** DONE_WITH_CONCERNS

---

## Files Created/Modified

- **Created:** `scripts/collect_sources.py` — source collection module with `collect()` function
- **Modified:** `tire_sources.csv` — 3 new rows appended (queued product URLs)
- **Modified:** `run-log.md` — robots/ToS result + map call results logged

---

## Step 1: Robots.txt Result

**Result: ALLOWED**

- Fetched via Python stdlib `urllib` (zero Firecrawl credits)
- Full content:
  ```
  Sitemap: https://www.tiresandwheels.com/sitemap_index.xml
  User-agent: *
  Allow: /
  Disallow: /cart.php
  Disallow: /my-account
  ```
- `/product/tire/` paths are NOT disallowed. Proceeding with map call was correct.

---

## Step 2: Map Command Used

```
firecrawl map https://www.tiresandwheels.com
```

Called via `firecrawl_client.call(["map", "https://www.tiresandwheels.com"], expected_max_credits=5, run_state)`.

Output format: plain text, one URL per line. Confirmed by `firecrawl map --help`.

---

## Raw Output Sample (first 5 product/tire/ URLs)

Only 3 product/tire/ URLs appeared in the 101 mapped:

1. `https://www.tiresandwheels.com/product/tire/EC583169/Otani/S142J/SA2100_35x12.50R20?srsltid=AfmBOoqTJPbONZVH9Td6iTXkfb2gT1gwocR5zu4tDgmewY7KLHMQf86O`
2. `https://www.tiresandwheels.com/product/tire/EC369446/Nexen/18170NXK_N5000+Platinum_191563009552_265+65R17?srsltid=AfmBOorOd-BV8Uki_Fp-HjDnYdZwBdMoZHcelcvZJe0W1dLEym9-oaI5`
3. `https://www.tiresandwheels.com/product/tire/EC9094/Nitto/180360/NT555R_205+55R14?srsltid=AfmBOoqLXM1AnzuoKj2w9jKn6sAbqkK_BJT5Yn6USElHbBgvcQAbWmdu`

---

## collect() Return Value

```python
{
    "mapped_total": 101,
    "product_urls": 3,
    "new_queued": 3,
    "credits_spent": 1
}
```

---

## Parse Success Rate

Tested all 3 queued URLs against `parse_tiresandwheels_url.parse_url()`:

| URL (truncated) | parse_url() result |
|---|---|
| Otani/S142J/SA2100_35x12.50R20 | FAIL — no barcode digit sequence in slug |
| Nexen/18170NXK_N5000+Platinum_191563009552_265+65R17 | PASS — barcode: 191563009552, size: 265/65R17 |
| Nitto/180360/NT555R_205+55R14 | FAIL — no barcode digit sequence in slug |

**Parse success rate: 1/3 = 33.3%** — BELOW the 95% target.

---

## Credit Accounting

| Metric | Value |
|---|---|
| Credits before run | 160 |
| Credits spent (map call) | 1 |
| Credits remaining after run | 159 |
| PER_RUN_CAP | 15 |
| TOTAL_CAP | 50 |
| total_credits_spent (in policy) | 1 |

---

## Concerns

1. **Low product URL yield:** `firecrawl map` returned only 3 `/product/tire/` URLs out of 101 total.
   The site's full product catalog is not enumerable via the map endpoint alone.

2. **Parse rate below target:** 33.3% < 95%. Two of three queued URLs lack the `_BARCODE_SIZE`
   tail pattern that `parse_url()` requires. These appear to be edge-case listings (non-standard
   size format) or products without a barcode embedded in the URL slug.

3. **Queue file schema mismatch:** `tire_sources.csv` retained the old 8-column header
   (`canonical_product_uid,...`) because it contains `source_url` as a column, which the
   `_ensure_queue_header()` guard accepts. The 3 new rows were appended in the new 3-column
   format (source_url, status, added_at). Downstream readers using DictReader will misalign
   the columns on these new rows. Recommend resetting the file header in a cleanup task.

---

## Recommended Next Step (Task 9)

Use the sitemap directly instead of (or before) `firecrawl map`:
- `https://www.tiresandwheels.com/sitemap_index.xml` lists product sitemaps.
- Fetch the XML (free, urllib) to enumerate all product URLs with proper barcode slugs.
- Alternatively: `firecrawl map https://www.tiresandwheels.com --sitemap only` may yield
  more product URLs (costs ~1-2 credits, within cap).
- The seed corpus (100 URLs from fixture) already has the correct URL format with barcodes;
  more URLs in that format exist on the site and are reachable via sitemap.
