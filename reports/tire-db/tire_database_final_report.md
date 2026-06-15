# Tire Database — Final Report

## Outcome
- **Source discovery: complete** (`source_inventory.md` + `.json`) — the blocking gate before any tire generation.
- **100-stage: complete (candidate-grade)** — 20 real, source-backed records; **0 verified-scannable**.
- **500-stage: NO-GO** (stopped before spending).
- **5000-stage: NO-GO** (stopped before spending).

## Why the bulk stages stopped (honest blocker)
There is **no safe, free, or bulk source of scannable tire barcodes (UPC/GTIN)** available this run.
The sources that carry tire barcodes in bulk are **paid/licensed** (Tireweb ~240k, TiresAddict),
**per-code paid over the $30 cap** (Go-UPC $74.95/mo, Barcode Lookup), or require an **owner-provided
file/API key** (UPCitemdb free = 100/day, needs signup). Manufacturer/retailer pages either don't publish
barcodes or restrict automated extraction (ToS/anti-bot 403s confirmed). Tire *specs* are public facts
gatherable via Firecrawl, but yield **spec-only candidates**, not scannable records. Scaling spec-only
rows to 500/5000 would be padding, which the owner forbade.

## 100-stage record counts (no-padding partition)
| category | count |
|----------|------:|
| verified scannable | 0 |
| candidate scannable (active) | 0 |
| spec-only candidate | 10 |
| conflicted | 0 |
| rejected / held | 10 |
| total | 20 |

## False-verified count
**0.** No record was marked as a verified scannable barcode without an actual verified barcode.

## Verification / confidence summary
Source-tier base confidence (manufacturer 0.8, distributor/vendor 0.6, retailer 0.4, field 0.7) +0.1 per
additional agreeing source (max +0.2) +0.1 field confirmation, −0.3 conflict; thresholds ≥0.8 verified,
0.5–0.79 candidate, <0.5 hold. 10 manufacturer-sourced records reached verified *status* but are spec-only
(no barcode); 10 retailer-sourced records are `hold`.

## Conflict summary
0 conflicts (`stage_100_conflicts.csv`).

## Spend
- Cash: **$0** for the entire tire build (no paid API used). Total task cash spend is $0.02 (benchmark only).
- Firecrawl: ~80 credits for discovery; cumulative ledger **94 / 500**; per-domain ≤8 (cap 50).

## Data + reports
- `data/tire-catalog/tire_catalog_100.csv` / `.jsonl`
- `reports/tire-db/source_inventory.{md,json}`, `stage_100_summary.md`, `stage_100_counts.json`,
  `stage_100_discovery_log.json`, `stage_100_conflicts.csv`, `stage_500_summary.md`, `stage_5000_summary.md`
- Pipeline: `src/services/tire/tireCatalog.ts` (+ 11 unit tests), discovery: `scripts/tire-discovery.ts`

## Import-ready output
Only records carrying a scannable code are app-importable; spec-only/conflicted are not. From the
100-stage that is a small set of retailer product codes (candidate, not verified barcodes) —
demonstrated in the integration check. The pipeline's `toImportCsv` produces the import-ready CSV the
moment a real bulk source is supplied.

## Exact next recommended step
Provide a **shop/vendor tire CSV** (free, carries scannable codes) or license a **bulk tire database**
(Tireweb Library / TiresAddict); the pipeline will ingest it directly and the 500/5000 stages become
feasible. Short of that, let the shop **scan live** so `field_scan` becomes the catalog's primary source.
