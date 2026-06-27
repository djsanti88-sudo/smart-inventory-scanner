# Retail Barcode Harvest Plan (Barcode Lookup)

> SEPARATE from tires. Retail data lives in its own directory, its own corpus, and (later)
> its own cloud collection / category. It is NEVER merged into the tire catalog (`catalogEntries`).

## Goal
Build a broad, multi-category RETAIL barcode catalog (grocery, CPG, electronics, health/beauty,
tools, toys, office, pet, home, sports, etc.) from the Barcode Lookup API, mirroring the disciplined
pipeline we used for tires: harvest -> GTIN-validate -> dedup -> store -> (later) load to cloud.

## Source characteristics (measured)
- DB size: hundreds of millions of products (~1B claimed). Horizontal, all retail categories.
- Endpoint: `https://api.barcodelookup.com/v3/products?search=<term>&page=<n>&key=<key>`
- 10 products/page, deep pagination confirmed (no shallow ceiling).
- Hard rate cap: **100 requests/minute** (we respect it; no evasion, no key rotation).
- Latency ~260-450 ms/call. Max legit throughput ~1,000 products/min.
- Data per product: barcode, formats, MPN, model, ASIN, title, Google category, brand,
  manufacturer, ingredients, nutrition, dimensions/weight, description, images, 13 store prices.

## Method
1. **Breadth-first** round-robin over ~100 broad retail search terms across all categories
   (excludes tires). Advance each term's page each cycle so coverage stays diverse if the quota is small.
2. For every product: keep only a **GTIN-checksum-valid** barcode; **dedup** by barcode.
3. Append clean rows to `retail_corpus.csv` (own schema). Persist `seen_barcodes` + progress for resume.
4. Throttle to <=100 req/min. On HTTP 429: if rate-limit -> back off 60s and retry; if quota/plan
   exceeded -> STOP gracefully (this empirically reveals the free-sample size).
5. Run until the free quota is exhausted = maximum extraction from the sample key.

## Storage (separate from tires) — FULL records, nothing dropped
- `data/retail-knowledge/retail_corpus.jsonl` — the COMPLETE product JSON per item, one per line
  (all 30+ fields: barcode, formats, mpn, model, asin, title, category, brand, manufacturer,
  ingredients, nutrition, color/size/material, dimensions/weight, description, features, **images
  (URLs)**, **stores (13 price rows)**, reviews, last_update). We keep everything even though we
  won't surface all of it on the site. Image BINARIES are referenced by URL here; downloading the
  actual image files is a separate optional pass (huge storage) — flagged, not done by default.
- `data/retail-knowledge/outputs/` — seen-barcodes, per-term progress, harvest log.
- Cloud (later): a SEPARATE collection or a `category:"retail"` partition — never `catalogEntries` (tires).

## Owner caveats (flagged, not blocking)
- This uses a **free sample key**. Bulk harvesting may exceed the trial's intended *evaluation* scope,
  and storing/redistributing the data has **licensing implications** under Barcode Lookup's Terms.
  Owner has directed maximal use of the granted key within its rate limit; ToS/licensing is the
  owner's call before any commercial/production use of the harvested data.
- We do NOT circumvent the rate limit, rotate keys, or evade detection.

## After the harvest
Dedup + QA (GTIN, dup, schema) -> review counts -> decide on cloud load to the retail category.
