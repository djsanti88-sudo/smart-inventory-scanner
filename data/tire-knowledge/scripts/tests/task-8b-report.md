# Task 8b Report — Sitemap-Based Source Collection

## Files Changed
- `scripts/collect_sources.py` — Complete rewrite. Removed Firecrawl map strategy; replaced with sitemap-index parsing. Key additions: `is_model_page(url)` pure filter, `fetch_sitemap_model_urls()`, `collect()` with idempotent CSV queue writer. Queue file renamed from `tire_sources_queue.csv` (old) to `tire_model_queue.csv` (new schema: `model_url,status,added_at`).
- `scripts/tests/test_collect_sources.py` — New test file (21 tests, all green).

## Test Output
```
21 passed in 0.08s
```
All network calls mocked. Zero credits spent during tests. Test classes:
- `TestIsModelPage` (12 tests) — pure function, no network
- `TestQueueIdempotency` (5 tests) — temp dir, no network
- `TestCollectMocked` (4 tests) — monkeypatched `_get_url`, no network

## Live Run Results
```
sitemaps:         1   (tirecatalog_prt1.xml.gz)
model_urls_found: 1375
new_queued:       1375
```

## Credits
- **Credits spent: 0**
- **Remaining credits: 158** (unchanged before and after run)

## Concerns
- Only 1 catalog sitemap part found (`tirecatalog_prt1.xml.gz`). The brief noted there may be `prt2`, `prt3`, etc. The sitemap index only listed one as of this run. The code already handles multiple parts generically — if more appear later, they will be picked up automatically on the next run.
- 1375 model URLs is slightly below the ~1437 estimate derived from the gzip (the sitemap contained 1437 `<loc>` entries total, but ~62 of those are brand-index pages that the filter correctly drops).
- TLS verification is bypassed for `www.tiresandwheels.com` specifically due to their incomplete cert chain. Scoped tightly to that host; all other hosts use verified TLS. Barcodes are GTIN-validated downstream per semantic-firewall rules.
