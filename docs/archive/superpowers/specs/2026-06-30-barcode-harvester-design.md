# Barcode Harvester Agent — Design Spec

**Date:** 2026-06-30
**Status:** Approved
**Goal:** A reusable Playwright-based agent that scrapes tire barcode data from retailer websites, deduplicates against the existing 76K corpus, and outputs net-new barcodes in the corpus CSV format for ingestion by `build-tire-knowledge.mjs`.

## Architecture

```
scripts/
  barcode-harvester/
    engine.mjs              — core Playwright engine
    sites/
      discount-tire.json    — site config (catalog URLs, selectors, pacing)
      discount-tire.mjs     — custom extractor (SPA interaction)
    output/                 — timestamped CSVs per run
```

### Core Engine (`engine.mjs`)

Responsibilities:
- Parse CLI args (`--site <name>`, `--dry-run`, `--max-pages <n>`, `--resume`)
- Load the existing barcode index from `tireKnowledge.generated.json` into a Set for O(1) dedup
- Load the site config (JSON) and optional custom extractor (.mjs)
- Launch Playwright (headless Chromium)
- Phase 1: **Discover** product URLs from catalog/listing pages
- Phase 2: **Extract** barcode + specs from each product page
- Skip any barcode already in the corpus (dedup at scrape time)
- Validate barcodes with GS1 mod-10 check digit (reuse `corpusRules.mjs`)
- Output new barcodes to a timestamped CSV in `output/`
- Log a summary: total pages visited, new barcodes found, skipped (duplicate), skipped (invalid), errors

### Site Config (JSON)

Each site config defines the crawl strategy declaratively:

```json
{
  "name": "discount-tire",
  "baseUrl": "https://www.discounttire.com",
  "catalog": {
    "strategy": "brand-list",
    "brandListUrl": "/tires-catalog",
    "brandLinkSelector": "a[href*='/tires/']",
    "productLinkSelector": "a[href*='/buy-tires/']",
    "paginationSelector": "button[aria-label='Next']",
    "maxPagesPerBrand": 50
  },
  "product": {
    "barcodeSelector": "[data-testid='gtin'], .product-gtin, .upc-code",
    "brandSelector": ".product-brand, h1",
    "modelSelector": ".product-model, h1",
    "sizeSelector": ".tire-size, .product-size",
    "specsSelector": ".product-specs, .tire-details"
  },
  "pacing": {
    "interPageDelayMs": 2000,
    "interBrandDelayMs": 5000,
    "maxConcurrent": 1,
    "maxConsecutiveErrors": 10,
    "respectRobotsTxt": true
  },
  "extractor": "discount-tire.mjs"
}
```

When CSS selectors aren't enough (SPAs, dynamic content, modals), the `extractor` field points to a custom `.mjs` file.

### Custom Extractor (`.mjs`)

A module that exports two async functions:

```js
// sites/discount-tire.mjs
export async function discoverProducts(page, config) {
  // Navigate the SPA catalog, handle vehicle fitment prompts,
  // scroll through dynamic lists, collect product URLs
  // Returns: string[] of product page URLs
}

export async function extractProduct(page, url, config) {
  // Navigate to a product page, wait for dynamic content,
  // extract barcode + specs from the rendered DOM
  // Returns: { barcode, barcodeType, brand, model, size, loadIndex, speedRating, ... } | null
}
```

The engine calls the extractor when present, falling back to CSS selectors from the JSON config when no extractor exists (for simpler sites).

### Output Format

The harvester outputs a CSV matching the `tire_corpus_seed.csv` schema:

```
canonical_product_uid,brand,brand_normalized,model,model_normalized,size,raw_size_text,load_index,speed_rating,load_range,type,season,barcode,barcode_type,manufacturer_part_number,confidence,current_status,usable_for,field_completeness_score,missing_fields,source_count
```

Key field values for scraped data:
- `confidence`: `verified_1src_strong` (single authoritative retail source)
- `current_status`: `active_retail`
- `usable_for`: `auto_count_candidate`
- `canonical_product_uid`: generated from `brand_model_size` (normalized, deduped)
- `source_count`: `1` (single source)

### Deduplication

Before visiting any product page, the engine loads:
1. The existing `tireKnowledge.generated.json` barcode index (76K+ barcodes)
2. Any previously harvested CSVs in `output/` (to avoid re-scraping across runs)

Both are merged into a single `knownBarcodes: Set<string>`. When a product page yields a barcode that's already in the set, the engine skips extraction and logs "SKIP (known): <barcode>".

### Check Digit Validation

Every scraped barcode is validated using `corpusRules.mjs:validCheckDigit()` before being written to the output CSV. Invalid barcodes are logged and skipped — never written to the corpus.

### Pacing and Safety

- **Serial crawling** — one page at a time, never parallel
- **2-second delay** between product pages
- **5-second delay** between brand categories
- **robots.txt** — checked on first request; if product pages are disallowed, log a warning and stop
- **Max consecutive errors** — if 10 pages fail in a row, stop the run (bot detection likely triggered)
- **User-Agent** — realistic browser UA (Playwright's default Chromium UA)
- **No login/auth** — only scrape publicly accessible pages
- **Resume support** — `--resume` flag skips URLs already in the current run's output CSV

### CLI Interface

```
node scripts/barcode-harvester/engine.mjs --site discount-tire
  --dry-run           # Discover URLs but don't visit product pages
  --max-pages 100     # Limit total product pages visited
  --resume            # Skip URLs already in the latest output CSV
  --headless false    # Show browser (for debugging)
```

### Integration with Existing Pipeline

After a harvest run:

1. Copy the output CSV to the seed directory or a dedicated harvest directory
2. Run `node scripts/build-tire-knowledge.mjs` — it reads all CSVs, deduplicates by barcode, and rebuilds the JSON index
3. Run `node scripts/build-knowledge-db.mjs` — rebuilds the SQLite DB from the updated JSON
4. The `build-tire-knowledge.mjs` generator already handles: check digit validation, confidence filtering, duplicate barcodes, and schema enforcement. No changes needed to the existing pipeline.

### Estimated Yield per Site

| Site | Estimated SKUs | Overlap with 76K corpus | Net new barcodes |
|------|---------------|------------------------|------------------|
| Discount Tire | 5,000-8,000 | ~60-70% | 1,500-3,000 |
| Tire Rack | 8,000-12,000 | ~70-80% | 1,500-3,500 |
| Walmart Tires | 3,000-5,000 | ~50-60% | 1,500-2,500 |

### Future Sites (Config-Only)

Adding a new site requires:
1. A JSON config file in `sites/` with the catalog structure and CSS selectors
2. Optionally a `.mjs` extractor if the site is a SPA or needs interaction
3. Run: `node scripts/barcode-harvester/engine.mjs --site <name>`

No changes to the engine.

### What This Does NOT Do

- Does not call any paid APIs (Firecrawl, AI providers)
- Does not modify the existing corpus or knowledge index directly
- Does not deploy anything
- Does not scrape non-public pages or bypass authentication
- Does not run in production — it's a local development/ops tool

### Testing

- Unit tests for the CSV output format (validates against `corpusRules.mjs`)
- A `--dry-run` mode that discovers product URLs without visiting them
- A `--max-pages 5` mode for quick smoke testing
- The existing `corpusRules.test.mjs` already tests check digit validation and row classification
