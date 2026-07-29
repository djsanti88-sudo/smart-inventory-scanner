# Agent 4 — Corpus Provenance (rev 4)

> Read `00-orchestration.md` and master plan Task 13 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/04-corpus-provenance`.

**Scope:** master-plan **Task 13 (F-16)** — refresh the tire-corpus provenance **METADATA ONLY** so its
hash/date/key-count describe the payload that ALREADY ships. Reproducibility fix, NOT a runtime regression.

**Files you OWN:**
- `src/server/tire-knowledge/tireKnowledge.generated.meta.json`
- a NEW metadata-only updater `scripts/refresh-tire-meta.mjs` (pattern it on `scripts/tmp-fix-source-count.mjs`)
  + its exact NEW guard test `scripts/refresh-tire-meta.test.mjs`
- `src/server/tire-knowledge/corpusDrift.test.ts` (READ to understand the enrichment allowance; edit only if
  its provenance expectations must move — never weaken the payload>manifest allowance)

**DANGER — the whole point of the rev-2 fix (external review, 2026-07-29):** the FULL generator
(`npm run build:tire-knowledge`) rebuilds the generated PAYLOAD from an OLDER source snapshot and would
DISCARD later enrichment, shrinking the corpus (78,437 → ~76,173 keys). **DO NOT run the payload generator.
DO NOT hand-edit generated payload JSON/DB.** Update ONLY the `.meta.json` to describe the existing payload.

**How (rev 3 — SEPARATE lineage, do NOT conflate):** the CURRENT on-disk source CSV (`bab179f1...`) is a THIRD
snapshot that never produced the payload — do NOT hash it. The updater READS the existing payload
`tireKnowledge.generated.json` (for `payload_sha256`, `payload_barcode_count`=78437, and the payload's own
internal `generated_at`) and COPIES the base-source fields forward from the existing meta (`base_source_sha256`
= the recorded `4390ed58...`, `base_source_row_count`=76208 — never recomputed). It writes ONLY the meta file,
keeping all existing field names, UPDATING `barcode_index_count` to 78437, `part_number_index_count` to 27364,
and `identity_index_count` to 72321, repointing
top-level `generated_at` to the payload's internal value, and ADDING the 6 lineage fields (`payload_sha256`,
`payload_barcode_count`, `base_source_sha256`, `base_source_row_count`, `payload_generated_at`,
`metadata_refreshed_at`). The updater accepts explicit paths so its guard test runs only on temporary fixture
copies. Guard test: payload SHA-256 byte-for-byte UNCHANGED; all three legacy counts match the payload indexes;
`base_source_sha256` still the recorded value (not the on-disk CSV hash); `metadata_refreshed_at` !=
`payload_generated_at` (no conflation). Only after that test passes may the executor run the updater once
against the real meta path and inspect that only the meta file changed.

**Internal order:** single task; the executor verifies source lineage/hash before running the updater.

**Proof gates:** `node --test scripts/refresh-tire-meta.test.mjs`, `npm run test:corpus-drift` (or
`npx vitest run src/server/tire-knowledge/corpusDrift.test.ts`), and `npm run test:golden`. All green.

**Definition of done:** meta.json describes the actual shipped payload; payload UNCHANGED (no enrichment lost);
drift + golden green. Merge into `audit-fixes`.
