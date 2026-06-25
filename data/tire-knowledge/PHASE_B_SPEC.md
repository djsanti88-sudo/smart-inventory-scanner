# Phase B Spec — Beyond tiresandwheels (probe-first, two-tier)

**Date:** 2026-06-23
**Sandbox:** `C:\Users\djsan\inventory\data\tire-knowledge` (write only here)
**Status:** APPROVED DESIGN — awaiting spec review before plan.
**Context:** tiresandwheels is fully harvested (~21.8k rows, all 62 of its brands). Phase B finds NEW barcode sources to (a) grow cheaply and (b) get the shop's niche brands not on tiresandwheels.

---

## 1. Goal & hard constraints

- **Grow the verified barcode corpus as much as possible** from sources OTHER than tiresandwheels.
- **Bulk efficiency floor (HARD):** never harvest bulk below **8 rows/credit**. If a source can't clear it, don't use it.
- **Niche brands** (Blackhawk, Fortune, Arisun — not on tiresandwheels) get a **separate hard-capped 100-credit sub-budget**, allowed at any efficiency.
- **Amazon is last resort** for niche (≈1 row/credit); if used, restrict to a curated **most-sold sizes** list only.
- All output flows through the existing pipeline: GTIN check-digit validate, dedup vs ledger, enrich (load/speed/type/season), route trusted/backlog/rejected, audit. Never invent data; preserve leading zeros; no row dropped for missing enrichment.
- Every Firecrawl call goes through the existing credit firewall (caps + kill switch + fail-closed).

## 2. The core insight

tiresandwheels gave ~8–28 rows/credit because **one fetch returned many products WITH their barcodes** (a listing table). To clear the floor elsewhere we need the same shape: **many GTINs per fetch.** Many e-commerce sites embed `gtin12`/`gtin13` in product **JSON-LD / microdata** even when it is not shown on screen. That is the thing to probe for.

## 3. Tier 1 — Bulk growth (≥8 rows/credit)

**3a. Probe phase (budget ~10–15 credits, ABORTS early if a clear winner emerges):**
- Candidate sites: SimpleTire, Tire Rack, TireBuyer, Discount Tire, Priority Tire, 1010tires (extend as needed).
- For each: fetch ONE representative listing/category page AND one product page as **raw HTML** (Firecrawl `scrape --format rawHtml`), then grep the embedded JSON-LD/microdata for `gtin`, `gtin12`, `gtin13`, `mpn`, `productID`, `sku`.
- Record per site: GTINs present? how many products per fetch? → **estimated rows/credit**.

**3b. Commit phase:**
- For any site clearing **≥8 rows/credit**, build a small source adapter (its own `parse_<site>.py` + collector) feeding the existing pipeline, and harvest with the bulk budget.
- If NO site clears the floor → **STOP, report findings, spend nothing further on bulk.** (Do not force it.)

## 4. Tier 2 — Niche brands (Blackhawk / Fortune / Arisun), 100-credit hard cap

Try in this order, stop when satisfied or cap hit:
1. **Manufacturer / distributor EAN catalogs** — hunt for published PDF/Excel catalogs with EAN/UPC (Firecrawl `parse`, hundreds of rows/credit). Best case for niche.
2. **Barcode-API lookup by brand+MPN** — scrape SimpleTire listing pages (cheap, dense) for brand+MPN+model+size, then resolve UPC via a free/cheap barcode API (UPCitemDB / Go-UPC). Firecrawl-cheap; depends on API coverage (unproven for tires — validate on a small sample first).
3. **Amazon, last resort only** — restrict to a curated **most-sold sizes** list (e.g. 225/65R17, 235/65R17, 265/70R17, LT265/70R17, 275/60R20, 265/65R17, 225/60R17, 235/55R18, 245/45R18 …) so each ~1:1 credit buys a size that actually sells. Reuse existing `process_amazon.py` / `asins_to_harvest.txt` patterns.
- The 100-credit cap is enforced and cannot be exceeded.

## 5. Components (new, all small + isolated)

- `phaseb_probe.py` — runs the Tier-1 raw-HTML probes, extracts GTIN density, prints a rows/credit table per site. (Tiny, throwaway-ish discovery tool.)
- `parse_<site>.py` — ONE per committed bulk source: page/JSON-LD → identity dict `{brand,model,mpn,barcode,size_canonical,size_compact,source_url,+enrichment}`.
- `harvest_<site>.py` (or a generic structured-data harvester parameterized per site) → reuses `write_outputs`, `ledger`, `audit_corpus`, firewall.
- Niche: `catalog_parse.py` (Firecrawl parse of catalogs) and/or `barcode_api_lookup.py` (MPN→UPC), gated by the 100-credit cap.

## 6. Proof gates

- **Probe gate:** each candidate reports measured rows/credit; only ≥8 proceed to bulk.
- **Adapter gate (per committed source):** unit-test the parser on a saved fixture; first live batch must produce valid GTINs (0 bad), exact schema, 0 dup, audit PASS, and **measured rows/credit ≥ 8** or it's pulled.
- **Niche gate:** sample-validate API coverage before bulk lookups; cap enforced.
- Full deterministic QA (`verify_corpus_full.py`) re-run after Phase B.

## 7. Out of scope / non-negotiable

No tiresandwheels re-harvest (done). No bulk source below 8 rows/credit. No niche spend beyond 100 credits. No app-code edits, no deploy, no git commits. Treat all scraped/API data as untrusted (semantic firewall); UPC truth = GTIN check + cross-source agreement, never an AI/model guess.

## 8. Open items (resolved during probes)

- Which candidate site(s) actually expose GTINs in JSON-LD — empirical (probe).
- Whether barcode APIs have tire UPC coverage keyed by MPN — empirical (small sample).
- Final "most-sold sizes" list for the Amazon last-resort — confirm with owner if that branch is reached.
