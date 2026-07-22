# Tire Corpus on Turso — design spec (2026-07-09)

## Problem
The Vercel preview deploy fails: `File size limit exceeded (100 MB)` — the upload is 860 MB
because the large local corpus artifacts are not excluded. The tire corpus on Vercel currently
relies on reading the 68 MB `tireKnowledge.generated.json` into memory (Plan B JSON fallback),
which bloats the serverless function; the 343 MB SQLite `.db` and 127 MB `.db.gz` cannot deploy
at all (>100 MB per-file limit).

## Decision (owner-approved 2026-07-09)
Move the tire corpus to **Turso**, mirroring the retail corpus which already lives there and works
on Vercel. Nothing tire-related then uploads to Vercel — the app queries Turso at runtime.

## Current state (verified read-only)
Turso DB `inventory-retail-...` already has: `retail` (4,047,273 rows; cols barcode, product_name,
brand, category), `decode_cache` (13), `goupc_usage` (1), `goupc_miss_cache` (3), `decode_archive` (0).
NO tire table. The retail schema is too minimal for tire specs — tires need their own table.

## Design

### 1. Turso `tires` table
Schema mirrors `TireKnowledgeRow` (src/server/tire-knowledge/tireKnowledgeIndex.ts):
`barcode TEXT PRIMARY KEY, canonical_product_uid, brand, brand_normalized, model, model_normalized,
size, raw_size_text, load_index, speed_rating, load_range, type, season, manufacturer_part_number,
barcode_type, confidence, current_status, usable_for, field_completeness_score, missing_fields,
source_count INTEGER`. Plus a `part_numbers` table OR a `manufacturer_part_number` index for the
part-number lookup path (mirror partNumberIndex: normalizedPartNumber -> canonical_product_uid).
`CREATE TABLE IF NOT EXISTS`; index on barcode (PK) + on manufacturer_part_number.

### 2. One-time import
`scripts/import-tires-turso.mjs` (pattern: the existing retail Turso import if present, else the
apply.mjs write style). Reads `tireKnowledge.generated.json` barcodeIndex (~78K rows), batches
`INSERT OR REPLACE` into Turso `tires` (idempotent — re-runnable). Verify final count matches the
JSON row count. This is a WRITE to the owner's Turso DB — owner-approved ("check it first and
update it"). Only creates/writes the `tires` table; never touches `retail` or ladder tables.

### 3. tireKnowledgeIndex query path
`lookupByExactBarcode` / `lookupByExactPartNumber` become: local SQLite (getKnowledgeDb, dev) FIRST;
when SQLite is unavailable (Vercel), query **Turso** (getTursoClient — same detection as
retailKnowledgeIndex) instead of the in-memory JSON. The 68 MB JSON in-memory fallback is REMOVED
(or kept only as a last-ditch dev fallback, not shipped). Turso lookups are async — thread through
(resolveExactBarcode is already async; verify the route awaits). Cache the Turso client per instance.

### 4. Weekly harvest writes to Turso
`apply.mjs` (or a thin post-step) upserts newly-added tire rows into Turso `tires` so the corpus
grows without a redeploy. Same idempotent INSERT OR REPLACE.

### 5. .vercelignore
Exclude ALL big corpus files: `src/server/knowledge.generated.db`, `.db.gz`,
`src/server/retail-knowledge/retailKnowledge.generated.json`, `src/server/tire-knowledge/tireKnowledge.generated.json`,
`*.bak-*`. Keep the small meta JSON. Result: tiny Vercel bundle; corpus served by Turso.

## Testing
- Unit: mocked Turso client for the tire lookup path (mirror storage.test.ts mock style); asserts
  exact barcode + part-number resolution, miss returns null, SQLite-preferred-when-present.
- Integration: the 10 new DT GTINs resolve verified via corpus_exact_barcode using the Turso path
  (extend dtHarvestIntegration.test.ts with a Turso-mode variant).
- Live: after deploy, 200 tire barcodes through the preview route -> corpus-hit rate, per-barcode
  latency (avg + p50, note cold start), zero paid spend.

## Risks / trade-offs
- Latency: +~10-40 ms per corpus lookup (network) vs in-memory; accepted (retail already pays it,
  100x cheaper than AI, free). Mitigate with the existing decode_cache + optional per-instance LRU.
- Turso read cost: 1 indexed row-read per lookup; negligible (retail already at 4M).
- Turso write cost: ~78K one-time writes + weekly deltas; modest, within tier.
- Async ripple: lookup becomes async; contain to tireKnowledgeIndex + its callers (resolveExactBarcode
  already async). If it ripples past ~3 files, report before forcing.

## Non-goals
No production deploy, no branch merge (owner will do when ready). Preview only.
