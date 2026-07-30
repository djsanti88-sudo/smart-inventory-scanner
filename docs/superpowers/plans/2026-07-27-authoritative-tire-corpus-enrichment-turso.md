# Authoritative Tire Corpus Enrichment and Turso Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load every row and field from the boss-provided tire workbook into a provenance-preserving
tire catalog, make that workbook authoritative when it identifies the same tire, safely enrich
missing tire fields with GPT-5 mini only when source evidence exists, and sync the reviewed result to
Turso without touching retail-product data.

**Architecture:** Stage a product-centric boss catalog beside the legacy barcode-keyed `tires`
table in the current shared Turso database. Products, identifiers, and source records remain separate so rows without a barcode and
non-GTIN shop labels are representable without weakening the public-GTIN trust gate. Import and
optional AI enrichment run through separate gated tracks; a reviewed content-addressed manifest is
the only input accepted by the Turso apply command. Valid GTIN rows are projected into the existing
`tires` lookup path, while legacy `tire_part_numbers` behavior and the runtime hot path remain
unchanged in this phase.

**Tech Stack:** Node.js 24, JavaScript modules, ExcelJS 4.4, `csv-parse` 7, Vitest, SQLite,
`@libsql/client` 0.17, OpenAI Responses/Batch API with Structured Outputs, Turso/libSQL.

## Goal Options Considered

1. **Recommended: authoritative shop-source migration plus evidence-gated enrichment.** Load all
   3,543 boss rows first, preserve all raw identifiers, override matching corpus fields with explicit
   provenance, then enrich in measured waves.
2. **Narrow option: boss workbook only.** Faster and cheaper, but leaves the wider corpus's 49,395
   missing manufacturer part numbers untouched.
3. **Broad option: enrich all 78,243 corpus rows immediately.** Rejected as the first move because it
   creates a large review burden before the prompt, evidence rules, and source retrieval have proved
   identifier precision.

## Baseline Evidence (read-only audit, 2026-07-27)

- Local generated JSON: 78,243 barcode rows and 27,181 part-number index entries.
- Local SQLite: 78,437 tire rows. The JSON, SQLite, CSV, and metadata are not currently count-equal.
- Generated metadata says 76,173 rows, while `data/tire-knowledge/tire_corpus_flat.csv` has 76,376
  rows and a different SHA-256 than the metadata. Rebuilding from the flat CSV before reconciliation
  risks deleting later enrichments.
- Missing fields in generated JSON:
  - manufacturer part number: 49,395 (63.13%)
  - type: 62,441 (79.80%)
  - season: 56,096 (71.69%)
  - load range: 78,223 (99.97%)
  - size: 9
- 3,376 nonblank `type` values look like Markdown links or URLs, indicating field contamination
  rather than valid tire-type data.
- The five boss-workbook brands account for 4,807 current corpus rows; 2,956 lack a manufacturer
  part number.
- Boss workbook `Sheet1`: 3,543 unique item numbers, 2,776 populated barcode cells, 767 blank
  barcode cells, no duplicate item numbers, no duplicate populated barcode values.
- Boss workbook exact normalized barcode comparison:
  - 2,235 current-corpus hits
  - 1,189 of those hits currently lack a corpus manufacturer part number
  - 1,312 barcode hits exist but the boss item number is absent from the current part-number index
  - 883 barcode and part-number lookups agree on one product
  - 40 barcode and part-number lookups point to different products, demonstrating that part number
    alone is not a globally unique key
  - 12 exact-barcode hits disagree on size; boss source wins, but every disagreement is reported
  - 0 exact-barcode hits disagree on brand
- Of 2,776 boss barcode cells, 2,697 become valid GTINs after conservative normalization. Ten short
  numeric cells are recoverable by left-padding to a valid UPC-A. The remaining 79 must be preserved
  as exact Code 128/shop identifiers, not invented or coerced into GTINs.
- Sidecar schema defects:
  - `tire_identifiers.csv`: all 21,978 data rows have 3 cells under a 6-column header
  - `tire_sources.csv`: all 3 data rows have 3 cells under an 8-column header
  - `tire_products.csv`: header only, no data rows
  These files are not safe as normalized sources of truth.

## Success Criteria, Acceptance, and Proof

| Criterion | Required result | Proof |
|---|---|---|
| Boss coverage | 3,543/3,543 source rows staged and stored; all five input fields preserved | Create, then run `node scripts/tire-corpus/stage-boss-workbook.mjs --verify` |
| Identifier safety | 2,776 raw barcode cells preserved; 2,697 valid GTINs; 79 non-GTIN identifiers remain typed separately | Create, then run `npx vitest run scripts/tire-corpus/lib/identifierRules.test.mjs` |
| UPC/EAN equivalence | Every unit EAN-13/GTIN-14 that has a valid leading-zero UPC-A equivalent stores both aliases under one product UID; scanning either returns the same tire | Create, then run `npx vitest run scripts/tire-corpus/lib/identifierRules.test.mjs scripts/tire-corpus/manifestCompatibility.test.mjs -t "UPC/EAN aliases"` |
| Authoritative overwrite | On a unique canonical-public-GTIN match, every boss-provided nonblank field wins; omitted valid boss fields are retained | Create, then run `node scripts/tire-corpus/stage-boss-workbook.mjs --report-conflicts` |
| Missing-barcode support | All 767 boss rows without a barcode exist as product/source records and are not fabricated into barcode rows | Create, then run `node scripts/tire-corpus/stage-boss-workbook.mjs --verify-missing-identifiers` |
| Retail isolation | No retail table is queried for mutation and no retail row changes | Create, then run `node scripts/tire-corpus/apply-turso.mjs --dry-run --verify-retail-unchanged` |
| AI honesty | GPT may return null; no MPN/UPC is accepted unless the exact value occurs in supplied source evidence | Create, then run `npx vitest run scripts/tire-corpus/lib/openaiCandidateSchema.test.mjs` |
| AI precision gate | 0 incorrect promoted identifiers in a stratified human-reviewed 100-row pilot whose review hash is owner-confirmed | Create, then run `node scripts/tire-corpus/build-apply-manifest.mjs --verify-review-gate` |
| Idempotency | Re-applying the same manifest produces 0 inserts and 0 updates | Create, then run `node scripts/tire-corpus/apply-turso.mjs --dry-run --expect-noop` |
| Turso integrity | all writes occur in bounded transactions; post-apply counts and 50 deterministic probes match the approved manifest | Create, then run `node scripts/tire-corpus/apply-turso.mjs --verify-manifest` |
| Rollback | pre-apply export restores the exact affected rows and indexes locally and through the production libSQL client against a disposable remote DB | Create, then run `npx vitest run scripts/tire-corpus/apply-turso.test.mjs -t restore` and `node scripts/tire-corpus/apply-turso.mjs --rehearse-disposable-turso --inject-every-chunk-boundary` |
| Runtime proof | boss GTIN and exact-barcode conflict cases resolve through the existing tire lookup path | `npx playwright test --config playwright.corpus-import.config.ts` |

## Out of Scope

- Retail corpus, retail Turso tables, Firebase inventory counts, production deployment, and Vercel.
- Treating GPT output as verification or allowing model memory to invent identifiers.
- Production Turso reads or writes before explicit owner approval.
- Changing the global runtime lookup path before the staged catalog has passed its proof gates.

## Global Constraints

- Wrong product identity is failure. Unknown is acceptable.
- A barcode exact match outranks a part-number match. Part number, brand, model, and size are
  corroboration/discovery signals, never globally unique attachment keys.
- The boss workbook is authoritative only for its nonblank fields. It does not blank out richer
  existing fields that it does not contain.
- Preserve raw values and normalized values separately. Never discard leading zeroes.
- For a valid unit EAN-13 beginning with `0` (or equivalent zero-padded unit GTIN-14), derive and
  store the valid 12-digit UPC-A as an explicit alias on the same product UID. Store the original
  EAN/GTIN too. EAN-13 values without the required leading zero, EAN-8, and nonzero-indicator
  GTIN-14 case packs do not receive fabricated UPC-A aliases.
- Non-GTIN Code 128/shop labels never enter the public-GTIN compatibility table.
- GPT-5 mini performs extraction and normalization from supplied evidence. It does not browse,
  search, or answer identifier questions from memory.
- Every AI identifier candidate carries source URL, evidence snippet, prompt version, model snapshot,
  input hash, and validation status.
- No paid API call, live Turso access, production mutation, deploy, push, or retail-data mutation
  occurs without its own explicit owner approval.
- OpenAI cost reports use token usage as a computed floor; true spend comes from the provider
  console. External retrieval fees, if any, are budgeted separately before use.
- Do not edit `tireKnowledge.generated.json` by hand.

## Source Precedence

1. Owner-approved boss workbook exact field (`boss_shop_authoritative`, priority 100).
2. Physical-label capture or owner-confirmed review (`physical_confirmed`, priority 95).
3. Manufacturer/distributor page with exact value in retrieved evidence (`primary_web`, priority 80).
4. Two independent agreeing sources (`two_source_consensus`, priority 70).
5. Single barcode database (`single_database`, priority 50).
6. GPT extraction candidate without promotion (`ai_candidate`, priority 20).

Only levels 1-4 may overwrite an existing nonblank identity field. Level 5 may fill a blank as
review-required. Level 6 never writes a production identity field.

## Implementation Files to Touch

- Create `scripts/tire-corpus/schema-v2.sql`: product, identifier, field-history, source, local
  candidate, and resumable apply-ledger tables.
- Create `scripts/tire-corpus/lib/bossWorkbook.mjs`: ExcelJS workbook parsing and row validation.
- Create `scripts/tire-corpus/lib/identifierRules.mjs`: GTIN, Code 128/shop-label, item-number, and
  part-number normalization.
- Create `scripts/tire-corpus/lib/sourcePrecedence.mjs`: field-level merge decision engine.
- Create `scripts/tire-corpus/lib/openaiCandidateSchema.mjs`: Structured Output schema and deterministic validator.
- Create `scripts/tire-corpus/audit-local.mjs`: reconciles JSON, SQLite, flat CSV, metadata, and workbook.
- Create `scripts/tire-corpus/stage-boss-workbook.mjs`: writes a local staging SQLite DB and reviewed diff files.
- Create `scripts/tire-corpus/build-evidence-packets.mjs`: produces source-hashed evidence excerpts.
- Create `scripts/tire-corpus/build-enrichment-batch.mjs`: produces bounded JSONL Batch API input.
- Create `scripts/tire-corpus/submit-enrichment-batch.mjs`: idempotent submit/poll/reconcile runner
  with a durable remote-batch ledger.
- Create `scripts/tire-corpus/ingest-enrichment-results.mjs`: validates API output into candidate rows.
- Create `scripts/tire-corpus/build-apply-manifest.mjs`: emits the only production-eligible manifest.
- Create `scripts/tire-corpus/apply-turso.mjs`: default read-only diff, explicit `--apply`, and `--restore`.
- Create `scripts/tire-corpus/lib/compatibilityProjection.mjs`: fail-closed mapping from approved
  catalog records into legacy `tires` columns.
- Create `scripts/tire-corpus/lib/writerFence.mjs`: shared lease/fencing compare-and-swap helper for
  every tire writer.
- Modify `scripts/dt-harvest/lib/tursoUpsert.mjs` and `scripts/import-tires-turso.mjs` so every live
  tire writer uses the same lease/fencing protocol; hard-disable `scripts/pilot-apply-turso.mjs`
  against production during migration.
- Modify `scripts/pilot-apply-turso.mjs` to fail closed against production while the migration lease
  or fencing protocol is active.
- Create focused `*.test.mjs` files beside each module.
- Create `playwright.corpus-import.config.ts` and `e2e/corpus-import-proof.spec.ts`.
- Update `docs/COMMANDS.md`, `docs/ARCHITECTURE.md`, `PROGRESS.md`, and the plan ledger at phase close.

## Risks and Failure Modes

- **Silent corpus loss:** JSON, SQLite, flat CSV, metadata, and likely live Turso have diverged. The
  plan blocks corpus regeneration, but the boss import uses a target-key live snapshot so unrelated
  drift does not prevent scoped authoritative updates.
- **Wrong identifier attachment:** 411 normalized MPNs map to multiple product UIDs. Exact barcode
  remains the attachment key; MPN-only results remain candidates.
- **Identifier corruption by Excel:** numeric cells can lose leading zeroes. Raw and normalized
  identifiers are stored separately, and left-padding is allowed only when the UPC-A checksum passes.
- **Global leakage of shop labels:** the 79 non-GTIN identifiers may be shop-specific. They remain
  inactive or business-scoped until the owner confirms their namespace.
- **Boss-source overreach:** only nonblank fields actually present in the workbook overwrite current
  values. Missing workbook fields never clear richer corpus data.
- **AI hallucination:** GPT cannot promote an identifier, browse, or use memory as evidence. An exact
  value must occur in supplied source text and pass deterministic validation plus review.
- **Partial Turso apply:** every write is manifest-hashed, key-scoped, exported before mutation, and
  followed by deterministic re-probes. Each chunk commits its progress ledger entry atomically, so
  interruption resumes or compensates safely. Restore is rehearsed locally and against a disposable
  remote Turso database through the production client before any real apply.
- **Retail collateral damage:** generated SQL is table-allowlisted; schema and deterministic retail
  partitions are hashed before/after, and the manifest rejects any retail action.
- **Unbounded paid work:** enrichment is split into separately approved waves with hard row and token
  caps. Retrieval-provider charges require their own observable-unit preflight.

## Cost, Spend, and Token Budget

- Local audit, parsing, staging, diffing, tests, and manifest generation: no paid API cost.
- GPT-5 mini pilot: maximum 100 rows, 1,200 input tokens and 250 output tokens per row.
- Five-brand wave: row count is frozen from the staged diff after boss overrides; it receives a
  separate approval and token cap.
- Full-corpus ceiling at today's audited 49,395 missing MPN rows: approximately $79.03 synchronous
  or $39.52 through Batch at the stated per-row caps and currently published token rates.
- The estimate excludes retrieval fees and is not a wallet balance. Closeout language is:
  `computed floor $X; true spend = provider console`.

## Delivery Tracks

- **Track A, deterministic boss import:** Tasks 1-5 and 8-11. Execute Task 9 locally/disposably
  first, pass Tasks 10-11 against the exact manifest, then return to Task 9 for the separately
  approved production catalog apply and final legacy-`tires` activation. It can complete without an
  AI call and delivers all 3,543 boss rows to Turso with valid GTIN compatibility projection.
- **Track B, evidence retrieval and GPT enrichment:** Tasks 6-7. It starts only after Track A's local
  staging proof and a separate owner approval for any paid/network work. Track B is not allowed to
  delay the deterministic boss import.

---

### Task 1: Freeze and reconcile all current tire sources

**Files:**
- Create: `scripts/tire-corpus/audit-local.mjs`
- Create: `scripts/tire-corpus/audit-local.test.mjs`

**Interfaces:**
- Consumes: generated JSON, generated SQLite, flat CSV, generated metadata, boss workbook.
- Produces: `reports/tire-corpus/<run-id>/baseline.json` with hashes, counts, missingness, global
  drift warnings, and the exact affected identifier set.

**Workbook CLI contract:**

```powershell
node scripts/tire-corpus/audit-local.mjs `
  --workbook "C:\Users\djsan\Downloads\Bar Codes - Fortune, Falken, Nexen, Blackhawk, Arisun.xlsx" `
  --expect-sha256 AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404
```

- [ ] Write fixtures proving count/hash disagreement causes a blocking verdict.
- [ ] Implement a read-only audit that never imports `.env.local`.
- [ ] Fail closed when `--workbook` is absent, unreadable, or its content hash differs.
- [ ] Add explicit checks for JSON-vs-SQLite-vs-flat-vs-meta count drift, missing-field rates,
  duplicate normalized MPNs, invalid field enums, and malformed sidecar CSV widths.
- [ ] Run:

```powershell
node scripts/tire-corpus/audit-local.mjs `
  --workbook "C:\Users\djsan\Downloads\Bar Codes - Fortune, Falken, Nexen, Blackhawk, Arisun.xlsx" `
  --expect-sha256 AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404
npx vitest run scripts/tire-corpus/audit-local.test.mjs
```

- [ ] Global source drift is a blocking warning for corpus regeneration, but it does not block the
  boss import. The boss import uses only a target-key snapshot of identifiers present in the workbook.
- [ ] After explicit owner approval for production read access, export every affected key from every
  table the manifest may write: legacy `tires`, diagnostic `tire_part_numbers`, catalog source,
  product, identifier, field-history, apply/chunk ledger, and writer-lease/fencing rows. Include
  explicit expected-absence tombstones, row hashes, and exact affected schema/index objects. Bind the
  complete snapshot hash to the manifest and never print credentials.
- [ ] Keep the broader JSON/SQLite/CSV/meta reconciliation as a separate repair ledger item. No
  generator runs until every payload-only row is accounted for.

### Task 2: Add a product-centric staging schema

**Files:**
- Create: `scripts/tire-corpus/schema-v2.sql`
- Create: `scripts/tire-corpus/schema-v2.test.mjs`

**Interfaces:**
- Produces:
  - `tire_catalog_source_records(source_record_id, source_kind, source_file_name,
    source_file_sha256, sheet_name, source_row, authority_level, raw_json, ingested_at)`
  - `tire_catalog_products(product_uid, brand, model, size, size_compact, load_index,
    speed_rating, load_range, type, season, manufacturer_part_number, source_item_number,
    source_description, authoritative_source_record_id, updated_at)`
  - `tire_catalog_identifiers(identifier_type, identifier_value, normalized_value, product_uid,
    canonical_public_gtin, namespace, business_id, verification_status, source_record_id,
    is_primary, created_at)`
  - `tire_catalog_field_history(product_uid, field_name, value, normalized_value,
    source_record_id, authority_level, active_from_manifest, superseded_by_manifest)`
  - `tire_enrichment_candidates(candidate_id, product_uid, field_name, proposed_value, source_url,
    evidence_snippet, model, prompt_version, input_hash, confidence, status, created_at)`
  - `tire_enrichment_batch_runs(request_hash, approved_wave_sha256, evidence_sha256,
    input_file_id, remote_batch_id, state, reserved_usd, result_file_id, result_sha256,
    error_file_id, error_sha256, submitted_count, completed_count, failed_count,
    last_reconciled_at)`
  - `tire_catalog_writer_lease(lease_name PRIMARY KEY, holder_id, fencing_token, expires_at,
    updated_at)`
  - `tire_catalog_apply_ledger(manifest_hash, status, next_chunk, database_change_token,
    applied_at, row_count, rollback_export_hash)`
  - `tire_catalog_apply_chunks(manifest_hash, chunk_number, before_image_hash,
    post_image_hash, committed_at)`

- [ ] Write a migration test against an empty SQLite DB and a legacy-schema clone.
- [ ] Add unique constraints on source-file row identity.
- [ ] For public unit-level GTINs, compute the same zero-padding equivalence closure as
  `lookupCandidates` and enforce one owner through `canonical_public_gtin`. Import the canonical
  primitives from `src/services/upc/gtin.ts`; do not fork a second GTIN algorithm.
- [ ] Keep nonzero-indicator GTIN-14 case packs distinct from unit-level UPC/EAN ownership.
- [ ] For MPN/distributor SKU/shop Code 128 values, use
  `(namespace, business_id, identifier_type, normalized_value, product_uid)` rather than global
  value uniqueness.
- [ ] Shop labels enter namespace `boss_file_unactivated` with no runtime trust. Activation requires
  a business ID and an approved alias decision.
- [ ] Add foreign keys from identifiers/candidates to products and source records.
- [ ] Add foreign keys from field history to both products and source records, and from apply chunks
  to their parent apply-ledger manifest. Enable and verify foreign-key enforcement in every local and
  Turso migration/apply/restore transaction.
- [ ] Add a foreign key from `tire_catalog_products.authoritative_source_record_id` to its source
  record, using migration ordering/deferral that never permits a committed orphan.
- [ ] Enforce at most one unsuperseded field-history value per `(product_uid, field_name)` with a
  partial unique index (or equivalent transaction-safe constraint). Any detected active-value
  conflict makes compatibility projection fail closed.
- [ ] Add rejection tests proving orphan identifiers, candidates, field-history rows, and apply
  chunks or authoritative product-source pointers cannot be created, including during rollback.
- [ ] Test concurrent chunks and restore paths cannot leave two active values for one product field.
- [ ] Define a shared compare-and-swap lease contract: acquisition atomically increments the fencing
  token when the prior lease is absent, expired, or held by the same owner; renewal/release requires
  `(lease_name, holder_id, fencing_token)`; every write transaction rechecks the current unexpired
  token before mutation. Test stale holders cannot write, renew, release, resume, or restore.
- [ ] Prove a product with no identifier can exist.
- [ ] Prove one product can carry UPC, EAN, GTIN-14, manufacturer part number, distributor SKU, and
  shop Code 128 identifiers without collision.
- [ ] Prove two products may share an MPN candidate while equivalent UPC/EAN/GTIN unit identifiers
  may not have two owners.
- [ ] Prove the active product projection is rebuildable from immutable field history.
- [ ] Prove the schema does not create or alter any retail table.

### Task 3: Parse the boss workbook without losing identifiers

**Files:**
- Create: `scripts/tire-corpus/lib/bossWorkbook.mjs`
- Create: `scripts/tire-corpus/lib/bossWorkbook.test.mjs`
- Create: `scripts/tire-corpus/lib/identifierRules.mjs`
- Create: `scripts/tire-corpus/lib/identifierRules.test.mjs`

**Interfaces:**

| Workbook column | Canonical meaning |
|---|---|
| `Item number` | boss source item number; proposed manufacturer part number only where source semantics and review confirm it |
| `Size` | normalized tire size plus preserved raw size |
| `Item name` | source description; deterministic brand/model parsing remains separately reviewable |
| `Brand` | canonical brand plus normalized brand |
| `Bar Code` | preserved raw identifier, then classified as public GTIN, shop Code 128, or missing |

```js
/**
 * @returns {Promise<{sourceHash: string, rows: BossWorkbookRow[]}>}
 */
export async function parseBossWorkbook(path) {
  return {
    sourceHash: "",
    rows: [{
      sourceRow: 2,
      itemNumberRaw: "",
      sizeRaw: "",
      itemNameRaw: "",
      brandRaw: "",
      barcodeRaw: "",
    }],
  };
}

/**
 * @returns {{
 *   raw: string,
 *   normalized: string,
 *   type: "upc" | "ean" | "gtin14" | "shop_code128" | "missing",
 *   checkDigitValid: boolean,
 *   normalization: "unchanged" | "left_pad_upca" | "none"
 * }}
 */
export function classifyIdentifier(raw) {
  return {
    raw: "",
    normalized: "",
    type: "missing",
    checkDigitValid: false,
    normalization: "none",
  };
}

/**
 * Returns only checksum-valid unit-level encodings for the same canonical product.
 * Never converts EAN-8 or a nonzero-indicator GTIN-14 case pack into UPC-A.
 *
 * @returns {{canonicalPublicGtin: string, aliases: Array<{
 *   type: "upc" | "ean" | "gtin14",
 *   value: string,
 *   derivation: "source" | "leading_zero_equivalence"
 * }>}}
 */
export function deriveUnitGtinAliases(raw) {
  return { canonicalPublicGtin: "", aliases: [] };
}
```

- [ ] Test numeric Excel cells, text cells with leading zeroes, blanks, formulas, duplicate keys, and
  malformed headers.
- [ ] Allow left-padding only when it produces a valid 12-digit UPC-A and record that transformation.
- [ ] For every valid unit EAN-13 beginning with `0`, materialize both the source EAN-13 and its
  12-digit UPC-A alias under the same canonical public GTIN/product UID. Apply the equivalent rule
  to zero-padded unit GTIN-14 values, deduplicate aliases, and preserve derivation provenance.
- [ ] Prove the source EAN and derived UPC independently pass their applicable shape/checksum rules.
- [ ] Prove EAN-13 without a leading zero, EAN-8, invalid checksums, and GTIN-14 case packs never
  generate a UPC-A alias.
- [ ] Never coerce the remaining 79 short identifiers into GTINs.
- [ ] Treat `Sheet1` as the curated product source. Retain `Sheet2` as source evidence, not a second
  product feed, because its duplicated columns and repeated item numbers describe barcode setup.
- [ ] Verify exact audit totals: 3,543 rows, 767 missing barcode cells, 2,697 valid normalized GTINs,
  and 79 typed non-GTIN identifiers.
- [ ] Derive identifier-less product UIDs from a persistent source namespace plus normalized boss
  item number. Keep source-file SHA-256, sheet, and row as source-record provenance, not identity.
- [ ] Prove a corrected/reissued workbook with a different file hash updates the same barcode-less
  product instead of creating a duplicate.

### Task 4: Stage all boss rows and generate the authoritative diff

**Files:**
- Create: `scripts/tire-corpus/lib/sourcePrecedence.mjs`
- Create: `scripts/tire-corpus/lib/sourcePrecedence.test.mjs`
- Create: `scripts/tire-corpus/stage-boss-workbook.mjs`
- Create: `scripts/tire-corpus/stage-boss-workbook.test.mjs`

**Interfaces:**

```js
/**
 * @returns {{
 *   action: "insert" | "overwrite" | "retain" | "conflict",
 *   value: string,
 *   reason: string
 * }}
 */
export function decideFieldMerge({ field, current, incoming, currentPriority, incomingPriority }) {
  return {
    action: "retain",
    value: "",
    reason: "",
  };
}
```

- [ ] Automatically reconcile only by a unique canonical public GTIN.
- [ ] A non-GTIN match may attach or overwrite only when namespace, business ID, normalized value,
  and an owner-approved alias all agree. Otherwise create an isolated source/product candidate.
- [ ] Use item number, brand, model, and size only to discover candidates when no exact identifier exists.
- [ ] On a unique canonical-public-GTIN hit, overwrite boss-provided nonblank fields and record
  before/after values.
- [ ] Classify every retained existing field against field-specific validators before merge. Move
  invalid values, including URL/Markdown-contaminated `type`, to immutable history and treat the
  active value as missing; never project contaminated values as richer data.
- [ ] Preserve existing fields that the workbook does not supply only when they pass validation.
- [ ] Represent all 767 missing-barcode rows as products plus source records.
- [ ] Route the 40 barcode-vs-part-index conflicts through exact-barcode precedence and record the
  losing part-index association for repair.
- [ ] Produce:
  - `staging.sqlite`
  - `boss-import-summary.json`
  - `boss-overwrites.csv`
  - `boss-conflicts.csv`
  - `boss-needs-identifier.csv`
- [ ] Dry-run twice and prove byte-identical reports.
- [ ] Inject a fixed `--run-timestamp` in determinism tests; sort report keys/rows and exclude
  volatile timestamps from content-addressed payloads.

### Task 5: Quarantine ambiguous part-number mappings in the new catalog

**Files:**
- Create: `scripts/tire-corpus/lib/partNumberIndex.mjs`
- Create: `scripts/tire-corpus/lib/partNumberIndex.test.mjs`

**Interfaces:**
- Produces a collision-safe candidate relation inside `tire_catalog_identifiers`:
  `(identifier_type, normalized_value, product_uid, source_record_id)`.

- [ ] Add failing tests for the 411 normalized MPN values currently attached to multiple product UIDs.
- [ ] Keep exact MPN as discovery. Require brand and size corroboration before suggesting one candidate.
- [ ] Do not change or backfill legacy `tire_part_numbers` in this phase.
- [ ] Exclude ambiguous MPNs from the legacy compatibility projection.
- [ ] Prove `NX10383` cannot resolve to a Michelin product merely because both reduce to `10383`.

### Task 6: Build bounded evidence packets

**Files:**
- Create: `scripts/tire-corpus/build-evidence-packets.mjs`
- Create: `scripts/tire-corpus/build-evidence-packets.test.mjs`

**Interfaces:**
- Consumes staged unresolved rows, existing `source_url` values in the flat corpus, saved Discount
  Tire harvest artifacts, and owner-approved retrieved pages.
- Produces local `evidence-packets.jsonl` entries containing product UID, requested field, source URL,
  exact bounded excerpt, content hash, source tier, and retrieval timestamp.

- [ ] Prefer already-saved local evidence and deterministic extraction at zero API cost.
- [ ] Reject packets whose source identity contradicts the staged brand or size.
- [ ] Treat live retrieval as a separate network/cost gate. Freeze provider pricing, caps, robots/ToS
  constraints, and observable billed units before the first call.
- [ ] Live retrieval requires `--max-rows`, `--max-bytes-per-page`, `--timeout-ms`,
  `--allowed-domain`, `--approved-wave-sha256`, and a provider-specific reserved-cost cap.
- [ ] Reject loopback, link-local, private-network, non-HTTP(S), redirect-outside-allowlist, and
  over-size URLs before fetch.
- [ ] Never send the full boss workbook or unrelated business fields to a provider.
- [ ] Prove every packet excerpt can be traced byte-for-byte to a saved source artifact.

### Task 7: Build the GPT-5 mini enrichment lane

**Files:**
- Create: `scripts/tire-corpus/lib/openaiCandidateSchema.mjs`
- Create: `scripts/tire-corpus/lib/openaiCandidateSchema.test.mjs`
- Create: `scripts/tire-corpus/build-enrichment-batch.mjs`
- Create: `scripts/tire-corpus/submit-enrichment-batch.mjs`
- Create: `scripts/tire-corpus/submit-enrichment-batch.test.mjs`
- Create: `scripts/tire-corpus/ingest-enrichment-results.mjs`

**Interfaces:**

```js
export const candidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "field",
    "proposed_value",
    "source_url",
    "evidence_snippet",
    "confidence",
    "decision",
  ],
  properties: {
    field: { const: "manufacturer_part_number" },
    proposed_value: { type: ["string", "null"] },
    source_url: { type: ["string", "null"] },
    evidence_snippet: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    decision: { enum: ["candidate", "not_found", "conflict"] },
  },
};

export function validateCandidate(candidate, suppliedEvidence) {
  return { acceptedForReview: false, reasons: [] };
}
```

- [ ] Assign every JSONL request a deterministic unique `custom_id` derived from product UID,
  requested field, evidence hash, and prompt version. Reject duplicate IDs before upload.
- [ ] Join output and error rows back to staged products only by exact `custom_id`; never depend on
  Batch output order. Prove a shuffled output file produces the same candidate mapping.

- [ ] Use pinned snapshot `gpt-5-mini-2025-08-07`, Structured Outputs,
  temperature-equivalent deterministic settings, and a fixed prompt version.
- [ ] Do deterministic parsing first. GPT receives only unresolved rows and supplied source excerpts.
- [ ] Do not enable web search inside the model request.
- [ ] Reject any proposed identifier that is absent verbatim from the supplied evidence.
- [ ] Reject values equal to the barcode, size token, load index, or known conflicting MPN.
- [ ] Store candidates only. Promotion is a separate reviewed-manifest step.
- [ ] Batch building defaults to dry-run and requires `--max-rows`,
  `--max-input-tokens-per-row`, `--max-output-tokens`, `--max-reserved-usd`,
  `--approved-wave-sha256`, and `--approved-evidence-sha256`.
- [ ] Bind one canonical request hash to approved-wave hash, evidence hash, input file ID, remote
  batch ID, reserved spend, state, output/error file IDs and hashes, and submitted/completed/failed
  request counts in
  `tire_enrichment_batch_runs`. A unique request hash may have at most one remote batch ID.
- [ ] Make submit/poll/reconcile idempotent. Persist `submitting` before the network call, include
  the request hash in remote metadata, and reconcile remote batches/files before any retry.
  An ambiguous timeout blocks automatic resubmission until reconciliation proves no remote batch
  exists; never "try again" blindly after a paid submission may have succeeded.
- [ ] Test crashes before upload, after upload, after batch creation, during polling, and after
  result download; prove every restart resumes the same paid job without duplicate submission.
- [ ] Reconcile `completed`, `failed`, `expired`, and `cancelled` terminal batches, including partial
  output plus a separate error file. Candidate ingest is blocked unless every submitted `custom_id`
  appears exactly once across output and error records and
  `completed_count + failed_count == submitted_count`; missing/duplicate IDs remain a blocking
  reconciliation incident, never an implicit `not_found`.
- [ ] Reserve aborted, timed-out, or expired work at the configured worst-case ceiling until the
  provider console reconciles it.
- [ ] Run an offline fixture battery with correct, missing, ambiguous, and prompt-injection source text.
- [ ] Pilot sequence:
  1. 100 stratified rows across the five boss brands.
  2. Remaining boss rows missing structured fields.
  3. Remaining five-brand corpus gaps.
  The full-corpus long tail is a separate future plan, not an automatic wave.

**Budget guard:** The current GPT-5 mini model card labels $0.25/M input and $2/M output as Batch
pricing, while the Batch FAQ describes Batch as 50% below synchronous pricing. Until the pricing
page and provider console are reconciled immediately before an approved run, reserve the conservative
double-rate synchronous ceiling: at 1,200 input and 250 output tokens per row, about $1.60 per 1,000
attempted rows, $79.03 for 49,395 synchronous rows, or $39.52 through Batch. This excludes retrieval
fees and treats ambiguous/aborted submissions at the full reserved ceiling.

### Task 8: Build the reviewed content-addressed apply manifest

**Files:**
- Create: `scripts/tire-corpus/build-apply-manifest.mjs`
- Create: `scripts/tire-corpus/build-apply-manifest.test.mjs`

**Interfaces:**
- Consumes reviewed boss diffs and, only when Track B is approved, reviewed AI candidate CSV.
- Produces canonical UTF-8 `apply-manifest.jsonl` plus SHA-256, counts by action/source/field, and
  rollback keys. Canonicalization fixes property order, line endings, number encoding, and rejects
  duplicate JSON keys.

- [ ] Boss-authoritative rows are eligible immediately after deterministic validation.
- [ ] AI candidates require reviewer status `approved`, passing evidence validation, reviewer
  identity/timestamp, and an immutable review-artifact SHA-256.
- [ ] Promotion of an approved extraction writes a field-history value attributed to the independently
  stored evidence source and its authority tier, with reviewer approval. The model candidate remains
  provenance for the extraction workflow and is never itself the authority.
- [ ] Require `--owner-approved-review-sha256`; bind it with source hashes, evidence hash, candidate
  hash, schema version, tool-version hash, pre-catalog baseline hash, expected
  post-catalog/pre-activation hash, and expected unchanged legacy-target hash inside the manifest.
- [ ] Manifest generation fails on duplicate identifier ownership, missing source rows, unreviewed
  AI candidates, retail-table actions, or drift within the target-key snapshot/staged boss counts.
  Known unrelated global JSON/SQLite/CSV/meta drift remains a regeneration blocker, not a manifest blocker.
- [ ] Freeze expected insert/update/no-op counts and 50 deterministic probe cases.

### Task 9: Apply to Turso with transactions and rollback

**Files:**
- Create: `scripts/tire-corpus/apply-turso.mjs`
- Create: `scripts/tire-corpus/apply-turso.test.mjs`
- Create: `scripts/tire-corpus/lib/compatibilityProjection.mjs`
- Create: `scripts/tire-corpus/lib/compatibilityProjection.test.mjs`
- Create: `scripts/tire-corpus/lib/writerFence.mjs`
- Create: `scripts/tire-corpus/lib/writerFence.test.mjs`
- Modify: `scripts/dt-harvest/lib/tursoUpsert.mjs`
- Modify: `scripts/import-tires-turso.mjs`
- Modify: `scripts/pilot-apply-turso.mjs` to fail closed against production unless it participates in
  the same approved lease/fencing protocol.

**Interfaces:**
- Default: read-only diff.
- `--apply-catalog --manifest <path> --expect-sha256 <hash>`: scoped inert catalog write; does not
  modify legacy runtime tables.
- `--activate-legacy --manifest <path> --expect-sha256 <hash> --proof-bundle <path>`: final scoped
  compatibility write after all local runtime/browser proof gates pass.
- `--restore <rollback-export>`: scoped restore of affected keys.

**Legacy compatibility mapping (fail closed):**

| Catalog value | Legacy `tires` column | Eligibility/mapping |
|---|---|---|
| canonical public GTIN | `barcode` | valid check digit, unit-level equivalence owner is unique |
| product UID | `canonical_product_uid` | stable catalog UID |
| brand/model and normalized forms | `brand`, `brand_normalized`, `model`, `model_normalized` | active field value passes validator |
| normalized and raw size | `size`, `raw_size_text` | active field value passes validator |
| load/speed/range/type/season | same-named columns | invalid or contaminated values project as null |
| manufacturer part number | `manufacturer_part_number` | approved active value; ambiguous MPN excluded from legacy index |
| identifier type | `barcode_type` | exactly `upc`, `ean`, or `gtin14` |
| authority trust | `confidence`, `current_status`, `usable_for` | closed mapping only: boss/physical/primary/two-source authority to an existing trusted tier; any unknown value rejects the row |
| computed catalog metrics | `field_completeness_score`, `missing_fields`, `source_count` | deterministically recomputed from active validated fields and source records |

- [ ] `--apply-catalog` rejects unless the manifest hash and pre-catalog baseline hash match.
  `--activate-legacy` rejects unless the expected post-catalog/pre-activation catalog hash matches
  and legacy target rows remain at their manifest-bound pre-activation hash. Both reject any retail
  action or unexpected schema/lease/fencing state.
- [ ] Split production mutation into an inert catalog-table apply and a final legacy-`tires`
  activation. The activation command rejects unless its proof bundle contains passing compatibility
  unit, golden, corpus-drift, and Playwright results for the exact manifest/tool/schema hashes.
- [ ] Keep the current shared Turso database in this phase so the runtime hot path and credentials
  remain unchanged. Require a closed statement builder with an exact tire-table allowlist, hash
  `sqlite_schema`, and hash deterministic retail partitions before and after. A dedicated tire
  database is a separate future runtime migration, not part of this import.
- [ ] Export every affected production row and index entry before writing. Record explicit
  previously-absent tombstones for new rows and exact DDL/index before-images.
- [ ] Apply source records, products, approved identifiers, and approved field values in bounded
  inert catalog transactions. Keep unapproved/rejected AI candidates local. Write compatibility rows
  only in the separately gated legacy activation transaction after Tasks 10-11 pass.
- [ ] Define a typed compatibility-projection interface with an explicit legacy-column mapping.
  A row is eligible only when its check digit is valid, `canonical_public_gtin` has exactly one
  owner, authority is approved, no active conflict exists, and confidence/status map to known
  legacy values. Reject unknown trust tiers; never fall back to the runtime's default `0.92`.
- [ ] Unit-test every projection rejection reason and prove no non-GTIN, ambiguous owner,
  contaminated active field, or unknown confidence/status can enter legacy `tires`.
- [ ] Project one legacy `tires` lookup row for each approved explicit unit UPC/EAN alias, with the
  same `canonical_product_uid` and identical active tire fields. Do not project case-pack aliases.
  The manifest freezes source-row versus derived-alias counts so activation and rollback cover both.
- [ ] Ban `INSERT OR REPLACE`. Use explicit `INSERT ... ON CONFLICT DO UPDATE SET` with per-field
  authority predicates and before-image assertions.
- [ ] Commit each chunk's rows, before-image hash, post-image hash, progress number, and database
  change token atomically. Add interruption tests after every boundary and prove resume-or-compensate.
- [ ] Use a lease plus monotonically increasing fencing token, checked inside every write transaction.
  Update the weekly harvester and bulk importer to acquire it; hard-disable historical pilot writes
  during apply/restore. If any writer cannot participate, pause it operationally and prove it is
  disabled before the manifest is approved.
- [ ] Boss nonblank fields may overwrite according to priority. A reviewed evidence extraction may
  write only as a value attributed to its independently validated evidence source and authority
  tier; unreviewed model candidates may not write.
- [ ] Do not write non-GTIN identifiers into legacy `tires`.
- [ ] Re-query all affected keys, compare to manifest, then record the manifest hash in the apply ledger.
- [ ] Re-run default dry-run and prove 0 pending changes.
- [ ] Rehearse `--restore` against a local clone before requesting live apply approval.
- [ ] Before production approval, run the exact `@libsql/client` apply flow against a disposable
  Turso database/branch: inject interruption after every chunk boundary, resume, restore, and run
  restore a second time to prove idempotency and fencing under real network semantics.
- [ ] Restore deletes apply-created rows, restores updated rows, reverts created schema objects when
  appropriate, is idempotent, and refuses to overwrite a key changed concurrently after apply.

### Task 10: Verify the existing runtime compatibility projection

**Files:**
- Modify only if a failing proof requires it: `src/server/tire-knowledge/TireKnowledgeProvider.test.ts`
- Create: `scripts/tire-corpus/manifestCompatibility.test.mjs`
- Create: `scripts/tire-corpus/manifestGolden.test.mjs`
- Create: `scripts/tire-corpus/manifestDrift.test.mjs`

- [ ] Write tests for boss valid-GTIN hits and exact-barcode conflict cases using the exact
  compatibility projection produced by the approved manifest before any production activation.
- [ ] Add paired scans for every UPC/EAN alias class and assert both encodings resolve to the same
  `canonical_product_uid`, brand, model, size, and manufacturer part number through SQLite, Turso,
  and JSON fallback paths.
- [ ] Generate content-addressed manifest fixtures containing the projected compatibility DB,
  expected golden decode rows, expected row/key counts, and schema/tool/manifest hashes.
- [ ] Make the three dedicated manifest tests reject fixtures whose embedded hashes do not match the
  exact activation manifest. Do not claim the repository's existing hardcoded golden/drift fixtures
  prove the new manifest.
- [ ] Keep the current SQLite to Turso to JSON hot path unchanged.
- [ ] Preserve public-GTIN verification semantics.
- [ ] Do not activate the 79 Code 128/shop identifiers in runtime until the owner chooses global
  versus business-scoped trust.
- [ ] Prove the 767 rows without an identifier are preserved by SQL/admin report; do not claim they
  are scan-resolvable.
- [ ] Run:

```powershell
npx vitest run scripts/tire-corpus/manifestCompatibility.test.mjs scripts/tire-corpus/manifestGolden.test.mjs scripts/tire-corpus/manifestDrift.test.mjs
npx vitest run src/server/tire-knowledge/TireKnowledgeProvider.test.ts
npm run test:golden
npm run test:corpus-drift
```

- [ ] Emit content-addressed compatibility/golden/drift proof records for the Task 9 activation
  proof bundle.

### Task 11: End-to-end proof and documentation

**Files:**
- Create: `playwright.corpus-import.config.ts`
- Create: `e2e/corpus-import-proof.spec.ts`
- Modify: `src/server/knowledgeDb.ts`
- Modify: `src/server/knowledgeDb.test.ts`
- Modify: `docs/COMMANDS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `PROGRESS.md`

- [ ] Add a no-paid local corpus Playwright config with live AI disabled, no Turso credentials, and
  a fixture compatibility DB. Do not set `IS_E2E=1`, because that disables the tire-corpus rung.
- [ ] Add a test-only `TIRE_KNOWLEDGE_DB_PATH` override in `knowledgeDb.ts` that is accepted only
  when `NODE_ENV !== "production"` and `IS_CORPUS_IMPORT_E2E=1`; otherwise fail closed or use the
  fixed generated DB path. Unit-test the production rejection. Never move or overwrite the owner's
  real `knowledge.generated.db`.
- [ ] Point the corpus-import Playwright config at an isolated fixture DB through that guarded override.
- [ ] Add browser scenarios for a boss GTIN hit and the authoritative 12-size-conflict sample.
- [ ] Add a browser scenario that scans an EAN-13 and its derived UPC-A separately and proves both
  display the same tire identity while preserving the actual scanned code on each scan event.
- [ ] Assert that no provider fetch is attempted during browser proof.
- [ ] Prove non-GTIN and missing-barcode preservation in the staging/Turso SQL report, not by
  pretending an identifierless product can resolve from a scan.
- [ ] Prove every scan still appears and counts.
- [ ] Run focused tests, then:

```powershell
npm run proof:local
npm run test:golden
npm run test:corpus-drift
npx playwright test --config playwright.corpus-import.config.ts
npm run proof:full
```

- [ ] Attach staging counts, manifest hash, rollback rehearsal, Turso post-apply probes, and browser
  screenshots to the closeout report.
- [ ] Emit the content-addressed Playwright proof into the Task 9 activation proof bundle. Only after
  this gate passes may the owner separately approve `--activate-legacy` against production.
- [ ] Report token usage and: `computed floor $X; true spend = provider console`.

## Open Questions Requiring Owner Decisions

1. Are the 79 non-GTIN Code 128 values global manufacturer/distributor identifiers, or shop-specific
   labels? Recommended default: store in an unactivated source namespace, never in global runtime
   lookup, then activate only as a business-scoped approved alias after confirmation.
2. When the boss workbook conflicts with an existing nonblank manufacturer part number on the same
   exact barcode, should the old value be retained as an alias/history entry? Recommended: yes,
   overwrite the canonical field but never discard the old value.
3. After the five boss brands are complete, should a new plan cover all remaining missing corpus part
   numbers or stop after the highest-volume brands? Recommended: measure retrieval coverage and
   reviewed precision first, then decide whether the long tail is worth a separate plan.
4. Does “all fields” mean preserving all boss workbook fields plus existing richer corpus fields
   (recommended), or clearing fields absent from the workbook? Recommended: preserve richer fields;
   blanks in the workbook never erase data.
5. Should a later project move tires to a dedicated Turso database? Recommended for long-term
   isolation, but keep the shared database for this import so the current runtime stays unchanged;
   use the strict table allowlist, writer fencing, and retail before/after hashes in Task 9.

## Rollback Story

- Every source file is content-addressed by SHA-256.
- Staging and manifest generation are local and repeatable.
- Live apply exports only affected rows and index entries before mutation.
- The apply ledger records manifest and rollback hashes.
- Restore is key-scoped and rehearsed on a local clone plus a disposable remote Turso database.
- No retail table, scan count, or unrelated Turso table is included in either apply or restore.

## Execution Gate

This plan authorizes no paid call or production access by itself. Execution starts with local-only
Track A staging. Production Turso export, GPT-5 mini pilot, Turso apply, runtime deployment, git push, and
production promotion each retain their explicit owner gate.
