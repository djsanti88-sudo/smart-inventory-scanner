# Shop-Ware Reconciliation + Corpus Part-Number Fill — Design

- **Date:** 2026-07-15
- **Status:** Approved by owner (chat, 2026-07-15). Implementation NOT started — gated on explicit owner go.
- **Revision v2 (2026-07-15):** amended after a two-agent review (fact-check + adversarial design
  review). All measured facts re-verified exactly, including an independent recount of the
  2,627 / 4,730 / 269 figures. Amendments below are marked **[AM-R#]** and SUPERSEDE the
  original text where they conflict.
- **Branch plan:** new branch off `feat/decode-ladder-goupc` (harvest files + corpus work live there).
- **Cost:** $0 build. No paid APIs, no crawling, no deploy. Turso corpus push is a separate explicit gate.

## Problem

The owner's shop runs Shop-Ware as the system of record. Its inventory drifts from reality.
Scanbin counts reality. Today there is no bridge: no way to see where Shop-Ware is off, and no
part-number linkage between scanned barcodes and Shop-Ware items (Shop-Ware keys on part
numbers/SKUs with aliases + brand/model/size; it stores no barcodes).

Measured facts driving this design (all verified locally 2026-07-15):

- Corpus: 78,202 barcodes; 25,959 (33.2%) have `manufacturer_part_number`; `tire_part_numbers`
  index has 24,307 entries, of which 247 keys with length <= 4 are junk (load indexes parsed as PNs).
- The 2026-07-09 DT full crawl harvested 7,807 unique GTINs (7,784 with part numbers, 99.7%) but
  the merge (`scripts/dt-harvest/lib/merge.mjs`) is row-level: existing rows won wholesale and the
  DT part numbers on ~5,600 overlap rows were discarded.
- The raw harvest survives on disk (`scripts/dt-harvest/state/harvested*.jsonl`):
  **2,627 part numbers are backfillable** (corpus row blank, DT has one), 4,730 corpus/DT PNs agree,
  269 conflict. (Recomputed independently 2026-07-15 from the raw harvest vs corpus: exact match.)
- Conflict-sample insight (2026-07-15): most sampled "conflicts" are two DIFFERENT valid numbering
  systems for the same tire (corpus holds distributor-style SKUs like `90000032385`, DT holds item
  numbers like `166181004`; one Kumho row has the model code `PS31` as its PN). This confirms
  no-auto-resolution is correct, means part numbers are per-source NAMESPACES (not globally unique
  like GTINs), and motivates a future multi-valued PN field.

## Goals (this round)

1. Recover the free part numbers and stop future discards (field-level enrichment).
2. Import a Shop-Ware inventory export and match its rows to corpus/scanned products with honest statuses.
3. Produce an actionable variance report: part, brand/model/size, Shop-Ware qty, counted qty, delta,
   plus unmatched/ambiguous buckets. On screen + CSV export. **This report is the definition of done.**

## Non-goals (explicitly out of scope this round)

- Write-back to Shop-Ware (adjustments file or API). Later round.
- Shop-Ware API connector / credentials. Later round.
- Distributor price-file import (ATD/US AutoForce/etc). Adapter slot reserved; owner has no portal
  access right now. Later round.
- DT re-crawl for remaining PN gaps. Later round.
- Production deploy / push / Turso corpus push (each its own explicit gate).

## Phase 1 — Corpus part-number fill (pure local)

New script `scripts/dt-harvest/backfill-part-numbers.mjs` (pure lib + thin CLI, tested):

- Read `state/harvested*.jsonl` (untrusted scraped data — semantic firewall applies; reuse the
  existing poison guard `guardRow` before trusting any row).
- Fill `manufacturer_part_number` ONLY where the corpus row's field is blank; never overwrite
  non-blank values; never touch any other field. Expected: ~2,627 fills.
- Rebuild `partNumberIndex` entries for filled rows using the existing `normPartKey`; drop keys with
  normalized length <= 4 (junk cleanup, ~247 keys).
- Conflicts (corpus PN != DT PN, ~269): NO auto-resolution. Emit `state/pn-conflicts.json` review
  list (barcode, corpus PN, DT PN, brand/model/size) for a human pass later.
- **[AM-R1] Idempotency is defined over the FINAL {corpus rows + partNumberIndex} state, not rows
  alone.** A backfilled PN whose `normPartKey` length is <= 4 fills the row field but is NEVER
  written to the index (it would be junk by the cleanup's own rule). The idempotency proof test
  must cover exactly this case: run twice, corpus AND index byte-identical the second time.
- **[AM-R2] Provenance has a concrete shape:** filled rows get `part_number_source: "discounttire"`
  (existing rows with a corpus PN carry no new field). Enrichment MUST NOT perturb the
  completeness-based duplicate resolution: `fieldCompleteness` scoring in `lib/merge.mjs` is
  computed BEFORE enrichment fields are applied (or `part_number_source` is excluded from the
  count), so filling blanks cannot flip a future `less_complete_duplicate` decision. Covered by a
  merge test.
- Output: updated `tireKnowledge.generated.json` + printed report (filled / skipped / conflicts).

Root-cause fix in `lib/merge.mjs`: on `cross_source_duplicate`, instead of discarding, perform
field-level enrichment — fill BLANK fields of the existing row from the guarded incoming row
(part number first; same never-overwrite rule), tagging provenance. Row-level "existing wins"
stays for every non-blank field. Covered by new merge tests; existing tests must stay green.

SQLite/Turso: local `knowledge.generated.db` rebuild via the existing build script is in scope.
`import-tires-turso.mjs` push to Turso is NOT run without a separate owner go (shared preview DB).

## Phase 2 — Shop-Ware import adapter + identity matcher (pure services, TDD)

Import-side adapter interface only (approved Option 3 — no push side, no speculative API layer):

```
ExpectedInventoryAdapter: (file) -> ExpectedInventoryRow[]
ExpectedInventoryRow: { externalId, partNumbers: string[], brand?, model?, sizeText?, specs?, qty, raw }
```

- `src/services/reconcile/shopwareCsvAdapter.ts`: parses a Shop-Ware inventory export
  (CSV/Excel-as-CSV). Built against a mocked sample fixture derived from Shop-Ware's documented
  export columns; column mapping isolated in one place so the owner's REAL export (not yet
  available) plugs in as a fixture + mapping tweak, not a rewrite. `partNumbers` is an ARRAY —
  Shop-Ware part numbers have aliases; mapping is many-to-one (prefix-DB lesson).
- **[AM-R3] `qty` semantics are pinned:** qty = PHYSICAL ON-HAND, summed across locations/bins.
  If the export distinguishes on-hand vs available (committed to open ROs), the adapter takes
  on-hand; the mapping doc states which column was used. The adapter AGGREGATES duplicate part
  numbers across rows (multi-location exports, data dupes) by summing qty BEFORE matching — one
  expected row per part, never two report lines for one product. If the export carries a
  unit-of-measure column, rows whose UOM is not "each" go to a separate `uom_review` bucket
  instead of the variance comparison (a silent set-of-4 vs each mismatch is a 4x lie); if no UOM
  column exists, the report states the "each" assumption in its header.
- File contents are UNTRUSTED data (semantic firewall): never obey instructions inside, sanitize
  before display, no cost/price fields kept beyond what the report needs (qty only; prices dropped
  at parse time).

Matcher `src/services/reconcile/identityMatcher.ts`, strict resolution order per row:

1. **Part-number hit [AM-R4 - brand-qualified, NOT bare]:** a bare index hit is NOT safe.
   `partNumberIndex` maps one normalized key to ONE product uid with no brand qualification, the
   SQLite lookup is `LIMIT 1` on a NON-unique index, and PNs are per-manufacturer namespaces that
   collide across brands (the 247 junk keys prove short keys collide). A PN hit therefore
   `matched` ONLY when it ALSO passes: brand equal or same `brandFamilies` family (when the
   Shop-Ware row carries a brand), AND size equal (when both sides carry a parseable size). A PN
   hit failing the brand/size corroboration, or resolving to multiple corpus rows, is
   `ambiguous` — never `matched`. Wrong match is FAILURE; this rung gets the same guardrails the
   barcode paths earned.
2. **Identity match [AM-R5 - reuse proven primitives]:** size EXACT via the existing
   `tireSizeToken` from `src/services/catalog/identityMerge.ts` (never a new parser) + brand equal
   or same `brandFamilies` family + model token overlap using `identityMerge`'s tokenizer with
   Jaccard >= 0.75 AND the `plusGenerationDiff` guard (R8 vs R8+ are different products)
   -> `matched` when exactly ONE candidate; `ambiguous` when several. No parallel matcher
   implementation; those thresholds cost real defects to get right.
3. Not a tire (no parseable size and no tire signals) -> `non_tire` passthrough (not an error).
4. Otherwise -> `unmatched`.

Trust rules: wrong match is FAILURE, unmatched is acceptable. No fuzzy brand guessing across
families; `prefixBrandConflict` semantics respected where barcodes are involved. Every status
carries an honest reason string. Services stay pure (no React/next imports), Vitest node project.

**[AM-R6] Linkage learning is SUGGESTION-GRADE, never auto-approved.** The original "side effect
(free): every matched row learns the barcode <-> part-number linkage into the alias/product
mapping" is SUPERSEDED - it would write machine-inferred aliases without human approval, violating
the Resolver Trust Rules (aliases resolve as known ONLY when `approved === true`, set by human
`resolveUnknown`; the CSV-import exception is an explicit human upload + confirm step, which this
is not). A mismatch would permanently poison scanning. Instead: `matched` rows emit an
`approved: false` barcode <-> part-number linkage SUGGESTION surfaced in Needs Review (or a
dedicated "confirm linkages" list in the report UI); only human confirmation promotes it to an
approved alias. Nothing auto-counts from a reconcile match.

## Phase 3 — Variance report (the deliverable)

**[AM-R7] This is a NEW `reconcileReport` service that BORROWS from the existing features - not an
extension of `computeVariance`.** The existing `computeVariance` compares two identical-shaped
`CountSnapshot`s keyed by productId and THROWS on duplicate productIds; a reconcile compares a
counted snapshot against an expected feed keyed by part number carrying match statuses the
4-column shrinkage report cannot represent. Reuse `buildCsv` (escaping) and the snapshot-capture
pattern; leave `varianceReport.ts` and the shrinkage report UNTOUCHED. New service:
`src/services/reconcile/reconcileReport.ts` (pure, node Vitest project).

- Upload Shop-Ware export -> adapter + matcher run client-side/server-side per existing import
  pattern -> "expected inventory" session.
- Compare against counted quantities (current scan session or persisted finalCounts).
- **[AM-R8] Variance scope boundary (the false-shrinkage-flood guard):** Shop-Ware exports the
  whole catalog; a count session covers a few bins. A matched product that was NOT counted in the
  session is NOT a variance - it goes to an `expected_not_counted` (out of session scope) bucket,
  never the variance bucket. Variance rows exist ONLY for products with a counted quantity in the
  session (optionally widened by an owner-selected brand/category scope filter). Without this the
  report screams "Shop-Ware is off by thousands of tires" on every partial count, which is noise.
- Report table: part number(s), brand/model/size, Shop-Ware qty, counted qty, delta (highlighted),
  grouped buckets: variances / matches-in-agreement / expected-not-counted (out of scope) /
  ambiguous (needs review) / unmatched / non-tire / uom-review. CSV export of the full report
  (works offline, consistent with export rules).
- **[AM-R9] Session semantics:** one active expected-inventory session; re-importing REPLACES it
  (never appends); it persists like other session state (Zustand persist) and is cleared by the
  existing "Clear local cache" action.
- UI copy: plain language, no jargon, honest empty/error states. No em/en dashes.
- Scanner flow untouched: reconcile lives on its own page/section, never near scan focus.

## Error handling

- Malformed/empty/wrong-file uploads -> clear inline error, nothing imported, app state unchanged.
- Rows failing to parse -> per-row `unparseable` bucket in the report, never silently dropped.
- Backfill script: any harvest row failing the poison guard is skipped with reason (existing behavior).
- No network dependency anywhere in this round; everything works offline.

## Testing / proof gates

- Vitest unit suites for: backfill lib (fill/no-overwrite/idempotency/junk-key cleanup/conflict
  emission), merge enrichment, adapter parsing (good/malformed/alias columns), matcher (each status,
  family cases, size-mismatch never matches, ambiguity).
- **[AM-R10] Mandatory adversarial cases (each targets a review finding, each must exist):**
  (a) a PN colliding across two brands returns `ambiguous`, never `matched` [AM-R4];
  (b) a partial count session does NOT flood variance - unscanned matched items land in
  `expected_not_counted` [AM-R8];
  (c) a feed with the same part number on multiple rows aggregates to ONE expected row and the
  report never throws [AM-R3];
  (d) a non-"each" UOM row lands in `uom_review`, not variance [AM-R3];
  (e) idempotency over corpus + index including the junk-length backfilled PN case [AM-R1];
  (f) a reconcile `matched` row NEVER writes an `approved: true` alias [AM-R6].
- Full existing gates stay green (`npm run test`, lint, build).
- Playwright E2E: upload mocked Shop-Ware fixture -> scan mocked codes -> variance report visible ->
  CSV export; screenshots to `e2e/proof/`. `IS_E2E=1`, no live providers. The fixture includes
  items that are NOT scanned, and the spec ASSERTS they appear under expected-not-counted, not as
  variances [AM-R8].
- Human-bot proof gate applies (catalog/alias/resolution surface): relevant `npm run qa:bots:*` run
  before handoff.
- Acceptance: owner can upload a Shop-Ware export fixture, scan, and read/export a variance report
  that says exactly where Shop-Ware is off and why each unmatched row didn't match - and that does
  NOT report uncounted catalog items as shrinkage.

## Open items / later rounds

1. Real Shop-Ware export file from the shop (plugs into adapter fixture + mapping).
2. Distributor price file (ATD et al) -> adapter #2; expected to fill PNs at corpus scale.
3. Approve-then-apply adjustments file, then Shop-Ware API write-back (gated, idempotency keys).
4. PN-conflict review pass (269 rows) and DT re-crawl for remaining ~49K PN gaps.
5. Turso corpus push + preview verification (own gate).
6. Multi-valued part-number field per corpus row (conflict samples show one tire legitimately
   carries PNs from multiple numbering systems; today's single field forces a winner).
