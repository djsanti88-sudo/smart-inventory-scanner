# Tire DB — 100-Stage Summary (candidate-grade)

Built by the pure pipeline `src/services/tire/tireCatalog.ts` (unit-tested) from observations gathered by
`scripts/tire-discovery.ts` — **legal + bounded**: Firecrawl search+scrape (prepaid), robots.txt checked
per domain (disallowed paths skipped), **factual fields only** (size/load index/speed rating + part
number/UPC where literally present), source URL kept on every record. No login/paywall bypass. **No padding.**

## Record counts (the no-padding partition)
| category | count |
|----------|------:|
| verified scannable (verified status + UPC/GTIN) | **0** |
| candidate scannable (has a code, not verified) | **0** (2 such rows exist but are `hold`-status retailer data, counted below) |
| spec-only candidate (no scannable code) | **10** |
| conflicted | **0** |
| rejected / held (low trust) | **10** |
| **total** | **20** |

> Two records (Bridgestone Turanza, Sailun Terramax CVR) carry a retailer product code and are
> `scannable: candidate_scannable`, but their source is a single retailer page (trust 0.4 → `hold`),
> so they are counted under **rejected/held**, not candidate-scannable. The partition counts by status
> first, exactly to prevent padding.

## The honest headline
**Zero verified, scannable tire barcodes (UPC/GTIN) were obtainable from free/legal web sources.** This
confirms the source-discovery finding. The 10 manufacturer-sourced records are *verified-status by source
tier (0.8)* but **spec-only** — real brand/model/size/load/speed facts with manufacturer source URLs, but
no scannable barcode published on the page. The 10 retailer-sourced records are low-trust `hold`.

## Spend
- Metered cash: **$0** (no paid API used; Firecrawl is prepaid).
- Firecrawl: ~80 credits for discovery (cumulative ledger 94/500 incl. the 14 benchmark credits);
  per-domain well under the 50-page cap. See `reports/firecrawl-ledger.json`.

## Gates
- false-verified (verified + scannable but wrong/unproven): **0** ✓
- conflict rate: **0%** ✓ (≤10%)
- data quality: factual extraction validated (size matched to variant; load/speed taken only adjacent to
  a size; false-positive part numbers rejected) ✓
- usable-rate gate (≥85% verified+candidate of attempted): **NOT met for SCANNABLE records** — by design,
  because no free source provides tire barcodes. Spec-only candidates are real but not app-scannable.

## Outputs
- `data/tire-catalog/tire_catalog_100.csv` / `.jsonl` (all 20 records + provenance)
- `reports/tire-db/stage_100_counts.json`, `stage_100_discovery_log.json`, `stage_100_conflicts.csv`

## Decision
**STOP before the 500-stage** (NO-GO per source discovery): there is no safe free/bulk source of
scannable tire barcodes, and per-code paid APIs exceed the $30 cap and are forbidden for bulk by the
owner's `bulk_source_rule`. See `reports/tire-db/source_inventory.md` for what unblocks bulk stages.
