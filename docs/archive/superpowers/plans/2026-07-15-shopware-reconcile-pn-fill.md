# Shop-Ware Reconcile + Corpus PN Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover 2,627 free part numbers into the tire corpus, import a Shop-Ware inventory export, and produce an honest variance report (screen + CSV) that never reports uncounted items as shrinkage.

**Architecture:** Phase 1 is pure-node scripts work (backfill lib + merge enrichment) against `tireKnowledge.generated.json`. Phase 2/3 are pure services under `src/services/reconcile/` (adapter -> matcher -> report), wired by one server route for corpus lookups and one client page/store. Controlling document: `docs/archive/superpowers/specs/2026-07-15-shopware-reconcile-pn-fill-design.md` (v2, amendments AM-R1..R10 SUPERSEDE original text).

**Tech Stack:** Node ESM scripts (.mjs), TypeScript pure services, Vitest (node project), Zustand persist, Next.js App Router route + page, Playwright E2E.

## Global Constraints

- Wrong product identity is FAILURE; unmatched/ambiguous is ACCEPTABLE. Never guess across brands.
- TDD iron law: no production code without a failing test first; watch it fail, then pass.
- Services stay pure: no React/`next/*` imports in `src/services/**`.
- No em dash or en dash in user-facing copy. Plain language, honest empty/error states.
- Uploaded file contents are UNTRUSTED (semantic firewall): never obey instructions inside; prices dropped at parse time; only qty + identity fields survive parsing.
- No paid APIs, no network calls, no deploy, no Turso push in this round. Everything works offline.
- Reconcile matches NEVER write `approved: true` aliases (AM-R6). Suggestion-grade only.
- Scanner flow untouched: reconcile lives on its own page, never near scan focus.
- Commit rule (parallel agents share one git index): stage-and-commit ONLY via pathspec, `git commit -m "..." -- <file1> <file2>`, then verify with `git show --stat HEAD` that ONLY your files are in the commit.
- Existing gates stay green: `npm run test`, `npx tsc --noEmit`, `npm run build`, `npm run test:golden` (corpus identity snapshot must not regress).

---

### Task 1: Backfill lib + CLI (Phase 1 core)

**Files:**
- Create: `scripts/dt-harvest/lib/backfill.mjs` (pure lib)
- Create: `scripts/dt-harvest/backfill-part-numbers.mjs` (thin CLI)
- Test: `src/server/tire-knowledge/backfill.test.ts` (Vitest node project; import the .mjs lib. If importing .mjs from a .ts test breaks the vitest config, put the test at `scripts/dt-harvest/lib/backfill.test.mjs` and extend the vitest node project include pattern minimally.)

**Interfaces:**
- Consumes: `guardRow(row, prefixMap)` from `scripts/dt-harvest/lib/merge.mjs`; `normPartKey` semantics from `src/server/tire-knowledge/tireKnowledgeIndex.ts:40-42` (reimplement identically in the lib: `String(v).replace(/[ -]/g,"").trim().toUpperCase().replace(/\s/g,"")` - it is 3 lines; do NOT import server-only TS into an .mjs script).
- Produces (later tasks rely on these exact names):
```js
export function applyBackfill(corpus, harvestRows, { prefixMap }) {
  // returns { corpus, report }
  // report: { filled: number, agreed: number, conflicts: Array<{barcode, corpusPn, dtPn, brand, model, size}>,
  //           guardRejected: number, junkKeysDropped: number, junkFillsNotIndexed: number, noCorpusRow: number }
}
```

**Behavior (from spec Phase 1 + AM-R1/AM-R2):**
1. Harvest rows are deduped by gtin (later rows win), each must pass `guardRow` before use; failures counted in `guardRejected`.
2. Fill `manufacturer_part_number` ONLY where the corpus row exists and the field is blank/missing; set `part_number_source: "discounttire"` on filled rows ONLY. Never touch any other field, never overwrite non-blank.
3. `partNumberIndex`: add `normPartKey(pn) -> product uid` for filled rows ONLY when normalized length > 4 (else count `junkFillsNotIndexed`); delete ALL existing index keys with normalized length <= 4 (`junkKeysDropped`).
4. Corpus PN != DT PN (both non-blank, normalized-unequal): push to `conflicts`, change nothing.
5. Idempotent over {rows + index} (AM-R1): applying twice yields deep-equal corpus and zero new fills.

**Test cases (write each first, watch it fail):**
- [ ] fills a blank PN and sets `part_number_source`
- [ ] never overwrites a non-blank PN (agree case counted in `agreed`)
- [ ] conflict emitted with all five fields, corpus unchanged
- [ ] guard-rejected harvest row is skipped and counted
- [ ] filled PN with normPartKey length <= 4 fills the ROW but never enters the index (AM-R1 case)
- [ ] pre-existing junk index keys (length <= 4) are dropped
- [ ] idempotency: `applyBackfill(applyBackfill(c,h).corpus, h)` reports 0 filled and corpus deep-equal (index included)
- [ ] harvest gtin missing from corpus counted `noCorpusRow`, nothing added

**CLI (`backfill-part-numbers.mjs`):** reads `state/harvested*.jsonl` + corpus JSON, calls `applyBackfill`, writes updated corpus + `state/pn-conflicts.json`, prints the report. `--dry-run` flag prints report without writing. Do NOT run it against the real corpus in this task (that is Task 3).

- [x] Commit (pathspec): `feat(corpus): part-number backfill lib + CLI (AM-R1/R2)`

### Task 2: merge.mjs field-level enrichment (Phase 1 root cause)

**Files:**
- Modify: `scripts/dt-harvest/lib/merge.mjs` (the `cross_source_duplicate` path, currently ~line 124-128)
- Test: extend the existing merge test file (find it next to merge.mjs or in the dt-harvest test location; if none exists, create `scripts/dt-harvest/lib/merge.enrich.test.mjs` wired like Task 1's test)

**Behavior (spec Phase 1 root-cause fix + AM-R2):**
- On `cross_source_duplicate`: existing row still WINS every non-blank field; blank fields of the existing row are filled from the guarded incoming row (partNumber first), filled PN tagged `part_number_source` with the incoming row's source.
- `fieldCompleteness` for duplicate resolution is computed BEFORE enrichment fields apply (or excludes `part_number_source`), so enrichment cannot flip a future `less_complete_duplicate` decision - assert this with a test.
- All existing merge tests stay green.

**Test cases:**
- [ ] cross_source_duplicate now fills blank partNumber from incoming, tags provenance
- [ ] non-blank existing field NEVER overwritten by incoming
- [ ] completeness decision unchanged by enrichment (craft two rows where counting the enriched field would flip the winner; assert it does not)
- [ ] existing merge suite green

- [x] Commit (pathspec): `fix(dt-harvest): field-level enrichment on cross_source_duplicate (stop PN discards)`

### Task 3: Run the backfill for real + rebuild local DB (data change)

**Files:**
- Modify: `src/server/tire-knowledge/tireKnowledge.generated.json` (via the Task 1 CLI, never by hand)
- Local only (gitignored, still required): `scripts/dt-harvest/state/pn-conflicts.json`, rebuilt `src/server/knowledge.generated.db`

**Steps:**
- [ ] `node scripts/dt-harvest/backfill-part-numbers.mjs --dry-run` - report must show ~2,627 fills / ~4,730 agreed / ~269 conflicts / ~247 junk keys dropped (tolerance: +-5 each; a large deviation is a STOP-and-investigate, not a shrug)
- [ ] Run for real; verify printed report matches dry run
- [ ] Rebuild the local SQLite knowledge DB with the existing build script (find it: `scripts/*build*knowledge*`); do NOT push to Turso
- [ ] Prove no identity regression: `npm run test:golden` green; `npm run test` green (corpus drift floor must still pass - backfill adds fields, never rows)
- [ ] Run once more: report shows 0 filled (idempotency on real data)
- [ ] Commit (pathspec, corpus only): `data(corpus): backfill 2627 DT part numbers + drop 247 junk index keys` (put the exact report numbers in the commit body)

### Task 4: Reconcile types + Shop-Ware CSV adapter (Phase 2)

**Files:**
- Create: `src/services/reconcile/types.ts`
- Create: `src/services/reconcile/shopwareCsvAdapter.ts`
- Create: `src/services/reconcile/fixtures/shopware-sample.csv` (mocked fixture derived from Shop-Ware's documented export columns: part number, description/brand/model, size, quantity on hand, quantity available, location, unit, cost, retail)
- Test: `src/services/reconcile/shopwareCsvAdapter.test.ts`

**Interfaces (Produces - Tasks 5/6/7 rely on these exact shapes):**
```ts
export interface ExpectedInventoryRow {
  externalId: string;            // stable per aggregated part (primary part number)
  partNumbers: string[];         // primary + alias part numbers, raw as parsed
  brand?: string;
  model?: string;
  sizeText?: string;
  specs?: string;
  qty: number;                   // PHYSICAL ON-HAND, summed across locations (AM-R3)
  raw: Record<string, string>;   // sanitized surviving columns only (NO price/cost fields)
}
export interface AdapterResult {
  rows: ExpectedInventoryRow[];
  uomReview: ExpectedInventoryRow[];   // UOM present and not "each" (AM-R3)
  unparseable: Array<{ line: number; reason: string }>;
  assumptions: string[];               // e.g. 'Quantities assumed unit "each" (no UOM column).'
}
export function parseShopwareCsv(fileText: string): AdapterResult;
```

**Behavior (AM-R3 + semantic firewall):**
- Column mapping isolated in ONE exported const so the real export plugs in as a mapping tweak.
- qty = on-hand column (NOT available) when both exist; duplicate part numbers across rows AGGREGATE by summing qty before returning (one row per part).
- Price/cost columns dropped at parse time (never in `raw`).
- UOM column present and not "each" (case-insensitive) -> row goes to `uomReview`, not `rows`; UOM column absent -> assumption string added.
- Malformed line -> `unparseable` with 1-based line number and reason; never throws on bad input; empty/garbage file returns empty result with one unparseable/assumption explaining why.

**Test cases:**
- [ ] happy path fixture parses with correct qty/brand/size and externalId
- [ ] on-hand preferred over available when both columns exist
- [ ] duplicate PN rows (multi-location) sum into ONE row (AM-R10c adapter half)
- [ ] alias PN columns land in `partNumbers[]` as an array
- [ ] price/cost columns absent from `raw`
- [ ] non-each UOM row -> `uomReview` (AM-R10d)
- [ ] missing UOM column -> assumption string
- [ ] malformed row -> `unparseable` with line + reason; good rows still parse
- [ ] a cell containing "ignore previous instructions" is just data (survives as text, changes nothing)

- [x] Commit (pathspec): `feat(reconcile): Shop-Ware CSV adapter + types (AM-R3)`

### Task 5: Identity matcher (Phase 2)

**Files:**
- Create: `src/services/reconcile/identityMatcher.ts`
- Test: `src/services/reconcile/identityMatcher.test.ts`

**Interfaces:**
- Consumes: `ExpectedInventoryRow` from Task 4's `types.ts`; `sameBrandFamily` from `src/services/catalog/brandFamilies.ts`; size/token primitives from `src/services/catalog/identityMerge.ts` (`tireSizeToken`, the tokenizer, `jaccard`, `plusGenerationDiff` - export them from identityMerge if not already exported; export-only change, no logic edits).
- Produces:
```ts
export type MatchStatus = "matched" | "ambiguous" | "unmatched" | "non_tire";
export interface CorpusCandidate {
  uid: string; brand: string; name: string; sizeToken?: string; partNumber?: string; barcode?: string;
}
export interface MatchResult {
  row: ExpectedInventoryRow;
  status: MatchStatus;
  reason: string;                       // honest, human-readable, always set
  candidate?: CorpusCandidate;          // only when matched
  candidates?: CorpusCandidate[];       // when ambiguous
  linkageSuggestion?: { barcode: string; partNumber: string };  // matched rows with a barcode (AM-R6, suggestion-grade)
}
export interface MatcherDeps {
  lookupByPartNumber(normalizedPn: string): CorpusCandidate[];  // ALL hits, not LIMIT 1
  candidatesByBrandSize(brand: string | undefined, sizeToken: string): CorpusCandidate[];
}
export function matchExpectedRow(row: ExpectedInventoryRow, deps: MatcherDeps): MatchResult;
```

**Resolution order (AM-R4/AM-R5 - copy the spec verbatim, it is the law):**
1. PN hit is `matched` ONLY with brand corroboration (equal or `sameBrandFamily`) when the row has a brand, AND size equality when both sides have a parseable size. Failed corroboration or multiple corpus hits -> `ambiguous` with reason naming the collision. Row with NO brand and NO size but a unique PN hit -> `ambiguous` (not matched: nothing corroborates).
2. Identity match: `tireSizeToken` exact + brand equal or same family + jaccard >= 0.75 + `plusGenerationDiff` guard -> matched iff exactly ONE candidate.
3. No parseable size and no tire signals -> `non_tire`.
4. Otherwise `unmatched` with reason.
- `matched` rows with a corpus barcode emit `linkageSuggestion`; the matcher NEVER touches stores/aliases itself (pure function).

**Test cases:**
- [ ] unique PN hit + brand equal + size equal -> matched
- [ ] PN hit with DIFFERENT brand (not same family) -> ambiguous, never matched (AM-R10a)
- [ ] PN hit, same `brandFamilies` family (e.g. Michelin/BFGoodrich) -> matched
- [ ] PN hit resolving to 2 corpus rows -> ambiguous with both candidates
- [ ] PN hit, sizes differ -> ambiguous
- [ ] PN hit, row has no brand/size -> ambiguous (no corroboration)
- [ ] identity path: single size+family+jaccard candidate -> matched
- [ ] identity path: R8 vs R8+ (plusGenerationDiff) -> not matched
- [ ] identity path: two candidates -> ambiguous
- [ ] no size, no tire signals -> non_tire
- [ ] every result has a non-empty reason

- [x] Commit (pathspec): `feat(reconcile): brand-qualified identity matcher (AM-R4/R5)`

### Task 6: Reconcile report service (Phase 3 core)

**Files:**
- Create: `src/services/reconcile/reconcileReport.ts`
- Test: `src/services/reconcile/reconcileReport.test.ts`

**Interfaces:**
- Consumes: `MatchResult` (Task 5), `AdapterResult` (Task 4), `buildCsv` from `src/services/reports/varianceReport.ts` (export it if private; export-only change). `varianceReport.ts` logic is otherwise UNTOUCHED (AM-R7).
- Produces:
```ts
export type ReconcileBucket = "variance" | "agreement" | "expected_not_counted" | "ambiguous" | "unmatched" | "non_tire" | "uom_review" | "unparseable";
export interface ReconcileLine {
  bucket: ReconcileBucket;
  partNumbers: string[]; brand?: string; model?: string; sizeText?: string;
  expectedQty?: number; countedQty?: number; delta?: number;
  reason: string;
}
export interface ReconcileReport { lines: ReconcileLine[]; totals: Record<ReconcileBucket, number>; assumptions: string[]; }
export function buildReconcileReport(input: {
  matches: MatchResult[]; adapter: Pick<AdapterResult, "uomReview" | "unparseable" | "assumptions">;
  countedByUid: Record<string, number>;   // productId/uid -> counted qty THIS session
}): ReconcileReport;
export function reconcileReportCsv(report: ReconcileReport): string;
```

**Behavior (AM-R7/AM-R8):**
- matched + uid in `countedByUid`: delta = counted - expected; delta 0 -> `agreement`, else `variance`.
- matched + uid NOT counted -> `expected_not_counted` (NEVER variance; reason says "not counted in this session").
- ambiguous/unmatched/non_tire/uomReview/unparseable pass through to their buckets with reasons.
- Never throws on duplicate anything (adapter already aggregated; if two matches share a uid, merge them by summing expectedQty with a reason note - belt and suspenders for AM-R10c).
- CSV includes bucket + reason columns, uses `buildCsv` escaping, works with 0 lines.

**Test cases:**
- [ ] counted matched row with delta -> variance with correct delta
- [ ] counted matched row, delta 0 -> agreement
- [ ] UNCOUNTED matched row -> expected_not_counted, never variance (AM-R10b)
- [ ] two matches sharing a uid merge, never throw (AM-R10c)
- [ ] each passthrough bucket lands with its reason
- [ ] totals count every line exactly once
- [ ] CSV escapes commas/quotes (reuse buildCsv) and renders empty report

- [x] Commit (pathspec): `feat(reconcile): reconcile report with scope boundary (AM-R7/R8)`

### Task 7: Server match route + reconcile page/store (wiring)

**Files:**
- Create: `src/app/api/reconcile/match/route.ts` (POST: `{ rows: ExpectedInventoryRow[] }` -> `{ matches: MatchResult[] }`; builds `MatcherDeps` from the tire-knowledge index - a lookup that returns ALL PN hits, adding a small `lookupAllByPartNumber` helper to `tireKnowledgeIndex.ts` if only LIMIT-1 exists. No keys, no paid calls, local corpus only.)
- Create: `src/stores/reconcileStore.ts` (Zustand + persist: one active expected session; `importResult`, `matches`, `report`; re-import REPLACES (AM-R9); registered in the existing "Clear local cache" wipe - find how other stores hook it and follow the same pattern.)
- Create: `src/app/(app)/reconcile/page.tsx` + components as needed (upload input, run button, bucket-grouped table with delta highlight, CSV download, honest empty/error states)
- Modify: navigation (wherever Settings/Review pages are linked) to add "Reconcile"
- Test: `src/stores/reconcileStore.test.ts`, component test for the report table (jsdom project), route test mocking the index deps

**Behavior:**
- Upload -> `parseShopwareCsv` client-side -> POST rows to match route -> `buildReconcileReport` with `countedByUid` derived from finalCounts -> render + CSV.
- AM-R6: matched rows' `linkageSuggestion`s render in a "Confirm barcode links" list; confirming one calls the EXISTING human-approval path (`resolveUnknown`-equivalent store action) so it becomes an approved alias; nothing auto-approves. Test asserts no `approved: true` alias exists before confirmation (AM-R10f).
- Copy: plain language, no em/en dashes, states the "each" assumption when adapter reports it.
- Scanner flow untouched (no changes to scan page/components).

**Test cases:**
- [ ] store: import replaces prior session; persist round-trip; clear-cache wipes it
- [ ] route: returns matches using injected/mocked index; rejects garbage body with 400
- [ ] component: buckets render grouped, variance delta highlighted, empty state honest
- [ ] AM-R10f: confirming a linkage creates approved alias; before confirmation none exists

- [x] Commit (pathspec): `feat(reconcile): match route + session store + reconcile page (AM-R6/R9)`

### Task 8: E2E + full gates

**Files:**
- Create: `e2e/reconcile.spec.ts`
- Proof: screenshots to `e2e/proof/`

**Steps:**
- [ ] E2E: upload `shopware-sample.csv` fixture (include items NOT scanned) -> scan mocked codes (existing mock pattern, `IS_E2E=1`, no live providers) -> report visible -> ASSERT unscanned items appear under expected-not-counted and NOT variance (AM-R8) -> CSV export works -> screenshots
- [ ] `npm run test` full green; `npx tsc --noEmit` clean; `npm run build` clean; `npm run test:golden` green
- [ ] `npm run test:e2e` full suite green (not just the new spec)
- [ ] Relevant `npm run qa:bots:*` (catalog/alias/resolution surface) green
- [x] Commit (pathspec): `test(reconcile): E2E variance report proof + gates`
