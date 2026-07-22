# Phase 2 - Tire Barcode Database (PLAN ONLY - NOT APPROVED TO EXECUTE)

> This document is planning only. No scraping, no database build, no large Firecrawl jobs, no
> Supabase/Postgres, no production tire catalog. Execution starts ONLY after the owner says
> "approve Phase 2", and even then starts with a small cost pilot (100 or 500), not 5,000.

## 0. The key insight from Phase 1 (drives the whole cost model)

Phase 1 measured the real decode engine. The decisive finding for tires:

- Retail products that ARE in barcode databases (go-upc/upcitemdb) resolve on the **fast path in
  ~85-101ms for 0 Firecrawl credits**.
- A product that is NOT in those databases (e.g. the Faire item) requires the **open-web fallback =
  ~7 Firecrawl credits** (1 search + up to 6 parallel scrapes) and ~14s.
- **Tires are almost never in consumer barcode DBs by UPC.** So a naive "decode 5,000 tire barcodes
  one at a time" would hit the fallback ~every time => ~7 credits each => **~35,000 Firecrawl credits
  for 5,000 tires**. That is the expensive way and we will NOT do it.

**Smart strategy instead: brand/model CATALOG-PAGE harvesting, not per-barcode search.** One scrape of
a manufacturer/distributor catalog or product page often lists many SKUs + UPC/MPN at once, so the cost
amortizes across many records (target: well under 1 credit per record, vs 7). The pilot's #1 job is to
measure this real per-record cost before any scale commitment.

## 1. Data strategy

1. Build the catalog **brand-by-brand**, shop's most-used brands first (section 6).
2. Per brand: discover the brand's line-up (models) -> for each model, the size matrix (section width /
   aspect / rim) -> capture UPC/GTIN/MPN + specs from a page that shows the **exact code**.
3. Prefer **bulk pages** (catalog/spec/where-to-buy pages listing many SKUs) over one-product-per-scrape.
4. Every record carries its source URL + evidence snippet + confidence; nothing is "trusted" without
   exact-code evidence (same rule as the live decoder).
5. Deduplicate by normalized barcode; never overwrite a verified record without stronger evidence.
6. The result preloads the app's shared catalog so in-store tire scans resolve on the FAST path
   (0 credits, instant) - the whole point.

## 2. Cost pilot plan (measure before scaling)

Run ONE pilot, then decide. Pilot options:

- **Option A - 100 tire records.** Bounded worst-case spend, fastest signal. **Recommended start.**
- **Option B - 500 tire records.** More statistically stable rates, ~5x the pilot spend.

The pilot MUST measure (per the owner's list):
1. Firecrawl credits per record (catalog-page approach vs per-barcode).
2. Gemini Flash usage per record. 3. OpenAI mini fallback usage per record.
4. Cache hit rate. 5. Resolution rate. 6. Duplicate rate. 7. Average confidence score.
8. Manual-review rate. 9. Average time per record.
10. Projected cost for 1,000 / 5,000 / 10,000 from the measured per-record cost.

Pilot budget guard: same hard Firecrawl cap pattern as Phase 1 (stop at a set credit ceiling), cache
every success, never loop.

## 3. Source strategy

Priority order (highest exact-code reliability first):
1. **Manufacturer sites** (e.g. toyotires.com, falkentire.com) - authoritative specs; UPC sometimes.
2. **Distributor/B2B pages** (Tire distributors, ATD/NTW-style catalogs) - often carry UPC/MPN per SKU.
3. **Major retailer product pages** (TireRack, Discount Tire, SimpleTire, Walmart) - UPC/MPN + specs.
4. **Marketplace pages** only when they clearly show the exact code (eBay/Amazon listings vary).
5. **Existing barcode DBs** (go-upc/upcitemdb) - cheap fast-path when present (rare for tires).
6. **Firecrawl search** to discover the above when a direct URL isn't known.
7. **Gemini Flash** to enrich/normalize specs from scraped text; **OpenAI mini** only as fallback verify.

Rules (inherited from the live decoder): prefer product/catalog URLs over search/cart/login (the
`urlPreferenceScore` we already ship); require exact UPC/GTIN/MPN on the page; store source + snippet;
SSRF guard on every URL; confidence-score every record; dedupe by normalized barcode.

## 4. Schema recommendation (`TireCatalogRecord`)

`barcode, upc, gtin, brand, model, tireSize, sectionWidth, aspectRatio, rimDiameter, loadIndex,
speedRating, plyRating, season, category, sidewall, productName, manufacturerPartNumber, sku,
sourceUrl, sourceDomain, evidenceSnippet, confidenceScore, verificationStatus, firstSeenAt,
lastVerifiedAt, providerUsed, firecrawlCreditsEstimated, aiCostEstimated, notes`

- Store BOTH the raw scraped text snippet (evidence) and the normalized fields (parsed specs).
- `verificationStatus`: verified (exact code on a trusted page) | pending (parsed, needs review) |
  rejected. Mirrors the live decoder's evidence model.
- Tire size is the natural secondary key (e.g. `225/45R17 94V`) - index it for size-based lookups.
- Persist as local JSON/SQLite for the pilot. A shared cloud DB (Supabase/Postgres) is a SEPARATE,
  later approval - the pilot does not need it.

## 5. Caching strategy (CacheProvider pattern)

Layered, so a record is paid for at most once:
1. **Existing decode cache** (`decodeCache.ts`) - immediate in-process reuse (already shipped).
2. **Local persistent batch cache** - keyed records survive across pilot runs (a re-run re-pays nothing).
3. **Optional Redis/Upstash adapter** behind a `CacheProvider` interface, used only if `REDIS_URL` is
   present. NOT required for Phase 1 or the pilot.

Cache keys: normalized barcode; source-URL hash; `brand+model+size` search query; Firecrawl search
result; AI enrichment result. Prevents repeated Firecrawl, Gemini, OpenAI, and page-read spend.

## 6. Brand priority (corrected; confirm with owner)

Shop's most-used (Tier 1), with two spelling corrections to confirm:
1. Fortune  2. Blackhawk  3. **Falken** (corrected from "Falcon" - Falken is the tire brand)
4. Toyo  5. **Nitto** (corrected from "Needles" - assumed; please confirm)  6. Nexen  7. Dunlop

Common U.S. market (Tier 2, after Tier 1): Michelin, Goodyear, Bridgestone, Firestone, Continental,
General, Pirelli, Yokohama, Hankook, Kumho, Cooper, BFGoodrich, Uniroyal, Kelly, Mastercraft, Sumitomo,
Maxxis, Hercules, Sailun, Laufenn, Ironman, GT Radial, Multi-Mile. (Not claimed complete; the pilot
will surface gaps and the final priority is set from real shop scan data.)

## 7. Estimated cost per 1,000 (from Phase 1 data - ESTIMATE, refine with the pilot)

Phase 1 measured ~7 Firecrawl credits per fallback-resolved product (per-barcode search). Two paths:

| approach | credits / record | per 1,000 | per 5,000 | per 10,000 |
|----------|-----------------:|----------:|----------:|-----------:|
| naive per-barcode search (worst case) | ~7 | ~7,000 | ~35,000 | ~70,000 |
| smart catalog-page harvest (target) | <1 (TBD by pilot) | <1,000 | <5,000 | <10,000 |

The spread between these is exactly why the pilot exists. AI: Gemini Flash is primary/cheap; OpenAI mini
fallback only. Exact $ needs Firecrawl's plan rate + token accounting - the pilot will produce real
numbers. Caching makes every figure a ONE-TIME cost.

## 8. Recommended pilot size

**Start with Option A (100 records)**, on Tier-1 brands (Fortune, Blackhawk, Falken, Toyo, Nitto,
Nexen, Dunlop). Reasoning: bounds worst-case spend to roughly 100-700 credits while measuring the real
per-record cost of the catalog-page approach, the resolution/dup/confidence/manual-review rates, and the
cache hit rate. If the per-record cost and quality look good, expand the same pipeline to 500, then scale.

## 9. Recommended full target

**Target 5,000 first, with a measured path to 10,000.** Reasoning: the U.S. consumer tire market has on
the order of 10,000-15,000 active SKUs across all brands and sizes, but a shop actually scans a long-tail-
light subset - the top ~25 brands in popular sizes. ~5,000 well-chosen records (Tier 1 in full + Tier 2
in popular sizes) should cover the large majority of real in-store scans. Build 5,000, then measure the
**miss rate against real scans** (the app already logs needs-review); expand toward 10,000 only for the
specific gaps that real misses reveal, rather than chasing the long tail blindly. 10,000+ only if the
shop carries unusually broad inventory or the measured miss-rate stays high.

## 10. Next owner decision

After reviewing Phase 1: say **"approve Phase 2"** to authorize the **100-record pilot** (Option A) on
Tier-1 brands, OR adjust pilot size/brands. Nothing in Phase 2 runs until then.
