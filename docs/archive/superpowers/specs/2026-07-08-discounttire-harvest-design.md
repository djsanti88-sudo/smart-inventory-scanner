# Discount Tire Catalog Harvest — Design

Date: 2026-07-08
Status: Owner-approved (this session). Separate sub-project from the decode ladder build.
Owner decisions: FULL catalog scope; engine = local Playwright (not Firecrawl) configured to
do Firecrawl's job; one-time backfill + weekly top-up; ToS risk explicitly accepted by owner
(private internal DB, polite pacing, no republishing).

## Goal

Grow the private tire knowledge corpus (currently 76,173 tires) with Discount Tire's full
catalog: barcode/GTIN, brand, model, size, load index, speed rating, part number, image URL,
and any structured attributes their product pages expose. Every harvested row carries
provenance `source: "discounttire"`.

## Why Discount Tire

- Their product pages carry structured data incl. GTIN (proven live: the Blizzak identity in
  the Fetch V2.3 run came from a DiscountTire page).
- Tires are the owner's strongest category requirement, and DT is a top-coverage US source.

## Architecture (cheapest-first)

1. **URL discovery (free):** parse `discounttire.com` sitemap XML for tire product URLs.
   Plain fetch; sitemaps are rarely bot-gated. Store the URL list with a seen-set so weekly
   top-ups only process NEW urls.
2. **Page fetch (free, local):** Playwright headless Chromium doing Firecrawl's job locally:
   realistic UA/viewport/locale, JS rendering, waits for the product JSON-LD to exist,
   captures rendered HTML. Politeness: 1 page at a time, 2-4s randomized delay, exponential
   backoff on 403/429, hard stop if block rate over a rolling 50 pages exceeds 30%
   (telemetry from batch one - if DT's bot wall defeats local Playwright we know within
   ~100 pages and the owner decides the fallback, e.g. Firecrawl credits, BEFORE waste).
3. **Parse (deterministic):** JSON-LD `Product` blocks + embedded state -> typed TireRow
   { gtin, brand, model, size, loadIndex, speedRating, partNumber, imageUrl, sourceUrl,
   fetchedAt }. NO AI anywhere in this pipeline.
4. **Poison guard (before corpus insert):** GTIN check-digit must validate; brand must not
   conflict with the catalog-derived prefix map (same firewall class that would have caught
   the Westlake/Blizzak error); duplicate GTIN keeps the higher-completeness row and never
   silently overwrites a row from a different source.
5. **Merge:** append/merge into `src/server/tire-knowledge/tireKnowledge.generated.json`,
   then `npm run build:knowledge-db`. Raw page HTML is NOT stored (large); the parsed row +
   sourceUrl + fetchedAt is the audit trail.
6. **Weekly top-up:** scheduled job driven by a LOWER-TIER (haiku) background agent: fetch
   new sitemap URLs + retry codes that hit Needs Review as tire-shaped misses during the
   week. Same caps and guards.

## Semantic firewall / safety

- Scraped page content is UNTRUSTED data: parsed fields only, instructions inside pages are
  never obeyed; parser is pure and fuzz-tested with hostile HTML.
- No secrets touch this pipeline; no external service receives our data (outbound = DT only).
- Runs are resumable and rate-capped; the crawler NEVER runs against any other host without
  a new owner decision (allowlist = discounttire.com + its sitemap CDN exactly).

## Cost

Compute-only (local Playwright). $0 API. Estimated wall time for full catalog at ~3s/page:
tens of hours, run in background batches. Firecrawl remains an owner-gated fallback if the
block rate trips the stop.

## Cadence

One-time full backfill (batched, resumable), then weekly top-up via scheduled lower-tier
agent. Corpus rebuild + spot-check report after every batch.

## Out of scope

- Republishing or exposing DT data externally (private corpus only).
- Any non-DT host.
- Price-based features (price MAY be parsed but is not used by decode).
