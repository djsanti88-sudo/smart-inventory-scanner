# QA Fix Plan - 2026-07-15 (approved by owner)

Execute in THIS worktree: `C:/tmp/wt-qafix`, branch `fix/qa-report-2026-07-15` (based on 74fabc8).
Do NOT work in `C:/Users/djsan/inventory` - a parallel session is actively committing there.
`npm install` is already done here.

Root causes were established by an 18-agent investigation (9 investigators + 9 adversarial
verifiers), all findings verified against code. Full detail:
`C:/Users/djsan/AppData/Local/Temp/claude/C--Users-djsan-inventory/e0cf902b-6d67-4910-b553-96b9a23bf78d/tasks/w61jtg8r8.output`
(64k tokens - read per-issue sections as needed). Summary + owner decisions in project memory:
`C:/Users/djsan/.claude/projects/C--Users-djsan-inventory/memory/qa-report-rootcause-2026-07-15.md`

## Hard rules
- TDD: failing regression test FIRST for every fix, then code, then green.
- One commit per fix (conventional commits). NO push, NO deploy, NO live/paid API calls.
- Turso/production data changes are GATED: produce a before/after diff for the owner, do not sync.
- Subagents (if used): always pass explicit model, sonnet default - never Fable.
- Never weaken resolver trust rules: "known" ONLY from approved alias / verified identifier;
  wrong identity is worse than unknown. Automated tests never call live providers.
- Gates at the end: full `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, targeted Playwright.

## Owner decisions (already made - do not re-ask)
- Issue 1 persistence: no-login/local runtime = platform-equivalent persistence behind an EXPLICIT
  local-mode flag (not just userId==null). Keep business stripping + scanPersist.test.ts
  FORBIDDEN_KEYS contract for the future real signed-in customer role.
- Issue 8 CSV re-import: refresh descriptive fields only, honest UI copy. No quantity add.
- Issue 7 PN typos: BUILD the review-only near-match suggestion (distance<=1, single candidate,
  never auto-counts).
- Issue 4 snapshot: tester was on a Vercel preview -> treat as likely stale build; verify on a
  fresh preview at the end, do not chase locally (it passes all 3 test layers on HEAD).

## Tasks (in order)

### Task 1 - Approve-suggestion dead button (suggest_link UI) - NEARLY DONE
Root cause: `scanStore.ts` suggest_link branch (~3282-3295) sets `suggestedLinkProductId` +
`decodeStatus:"suggested"` then bare-returns; review.status stays "open"; NO UI ever rendered
`suggestedLinkProductId`, so "Approve suggestion" was a silent no-op on these rows.
DONE so far in this worktree (uncommitted):
- `src/components/NeedsReviewTable.suggestLink.test.tsx` (new, 4 tests) - regression tests.
- `src/components/NeedsReviewTable.tsx` - renders one-tap `Link to <product>` button
  (data-testid `link-suggested`) + note (`suggest-link-note`) when suggestedLinkProductId is set,
  hides the dead Approve button; goes through existing `link_existing` path.
REMAINING: re-run `npx vitest run src/components/NeedsReviewTable.suggestLink.test.tsx
src/stores/identityMerge.store.test.ts` (a fixture `idempotencyKey` was just added - should now be
8 passed / 0 unhandled errors), then commit.

### Task 2 - Internal-name leak in scan reason
Root cause: `src/server/decode/pipeline.ts:1100` builds `allMissReason` by joining raw rung names
(upcitemdb/openfoodfacts/goupc/fetchv2/gpt) + raw internal reasons; flows via `reasonText` ->
`scanStore.ts:2490/2498` -> feed/review `.reason` -> `LiveScanFeed.tsx` renders to ALL roles
(only `decodeNote` is platform-gated).
Fix (server-side preferred): route the all-miss branch through the existing safe `REASON_TEXT`
lookup (already imported in pipeline.ts, used at :869 and :952); keep the raw string only in the
platform-gated debug surface (debug.ladderReasons already exists - VERIFY it is only rendered
platform-gated). Also check `markFeedRowVerified` (scanStore.ts:3045) second path.
TDD: test asserting customer-visible reasonText/feed reason contains none of
/upcitemdb|openfoodfacts|goupc|fetchv2|gpt-5\.5|ladder/i while still being non-empty and honest.

### Task 3 - CSV header drop + unmapped-column warning
Root cause: TWO divergent CSV pipelines in `src/services/csvImport.ts`. The Products-page panel
path (`parseCsvImport`:287-346 + `CsvImportPanel.tsx`) never mapped Brand/Category/Specs/Location:
`ImportRow` (:229-234) lacks the fields, `pickHeader` calls (:318-321) only cover
name/sku/barcode/qty, panel `createProduct` hardcodes `""`. The ExportMenu path
(`buildProductImport`:96-211) maps them fine - do not touch it.
Fix: extend ImportRow + pickHeader (mirror buildProductImport's alias lists at :114-122); wire into
CsvImportPanel createProduct; add unmapped-header warning to ImportSummary + panel UI ("These
columns were not imported: ...").
TDD: csvImport.test.ts header-synonyms cases + unmapped-warning case + CsvImportPanel.test.tsx
end-to-end field carry.

### Task 4 - GTIN-14 canonicalization
Root cause: no GTIN zero-pad canonicalization in deterministic path. `canonicalGtin`/`gtinVariants`
exist (`src/services/upc/gtin.ts`) but only used server-side. Proven: scanning 00049000028911
against product upc 049000028911 -> unknown -> duplicate provisional row; feed shows decode
suggestion name while counts table shows placeholder name (two different rows).
Fix: (a) `scanCleaner.ts` buildNormalizedCandidates - for GTIN-shaped codes add canonical/variant
forms (ADDITIVE only); (b) canonicalize identifier comparison at scanStore.ts ~2709
(ensureProvisionalCount), ~2387 (enrich branch), ~3248 (orphan dedup).
CRITICAL: use canonicalGtin (preserves case-pack indicator digit >=1) - NEVER naive zero-strip;
never canonicalize non-GTIN codes (SKUs/vendor labels).
TDD: resolver test 00049000028911 vs upc 049000028911 -> matchType "upc"; scanCleaner candidates
test; store integration test (one product row after both scans); case-pack negative test
(10049000028918 must NOT merge into 049000028911).

### Task 5 - Corpus poisoning + EvidenceVerifier bypass
Root cause (both proven live): (a) `scripts/build-retail-knowledge.mjs:41` takes OFF `brands`
verbatim (no `.split(",")[0].trim()` unlike sibling scripts); dedup rule :44-51 keeps LONGEST
garbage; 1908 rows with brand>60 chars; poisoned row 0123456789012 = "Peanut Butter Crunch" /
"Fleischer, Selbst gemacht, The Wholesome Bar, Uberti". (b) `src/server/decode/pipeline.ts:947`
hand-sets evidence.verified=true on the structured-DB consensus path - `verifyEvidence` never runs
there; `parallelResolve.ts:141` identitiesAgree (2 shared tokens) is the only check.
Fix, 3 layers: (1) ingest sanitize (first brand tag only, length caps ~80 chars, placeholder/dummy
barcode blocklist: 123456789012 family, 0000000000000, 9999999999999) + rebuild LOCAL knowledge DB
(`npm run build:knowledge-db` - local only); (2) garbage-detector before candidate-pool admission
in parallelResolve (retail_db/barcode_db votes: reject run-on/multi-brand/over-length names);
(3) read-time guard in `retailKnowledgeIndex.ts` (Turso rows may still be dirty).
TDD: ingest script test (new file), parallelResolve garbled-row test (never verified:true),
integration: seeded garbled row at 0123456789012 -> decideDecode never "verified".
GATE: do NOT sync Turso; produce a row-count/sample diff for the owner instead.

### Task 6 - Persist stripping kills owner's own data (CSV-import-then-reload)
Root cause: `scanPersist.ts:59-84` business branch drops `aliases` entirely +
`sanitizeProduct(p,"business")` strips barcode fields (CUSTOMER_SAFE_PRODUCT_FIELDS,
`sensitiveFields.ts:44`); `effectiveClientAccessLevel` (`roleAccess.ts:61`) returns "business" for
the no-login runtime (userId always null on mock path); zustand default shallow merge over fresh
initializer loses everything on reload. Proven with live repro.
Fix per owner decision: explicit local-mode flag (e.g. no cloud backend configured / open access
= platform-equivalent persistence), NOT just userId==null; keep FORBIDDEN_KEYS contract test intact
for a genuine customer role; likely touch roleAccess.ts + scanPersist.ts persistAccessLevel.
TDD: new `src/stores/csvImportReload.store.test.ts` - CSV import -> scan resolves known -> build
persisted blob via persistAccessLevel(null)/buildPersistedScanState -> merge over FRESH
createTestScanStore -> scan STILL resolves known. Must fail before fix. Also verify resolveUnknown
-> alias-teaching path survives reload (same class).

### Task 7 - CSV re-import semantics (refresh fields, honest copy)
Root cause: BOTH import paths mishandle existing-barcode rows. ExportMenu path (buildProductImport
:147-151) hard-discards as "conflict". Panel path calls incrementQuantity (csvImport.ts:441) whose
real impl (CsvImportPanel.tsx:43-53) only stamps updatedAt - Product has no qty field,
InventoryCount untouched; summary claims "merged".
Fix per owner decision (catalog semantics): on existing-barcode row in BOTH paths, refresh
descriptive fields (name/brand/category/specsShort/location) from the row; rename the panel's
incrementQuantity semantics (e.g. refreshExistingProduct); honest summary copy: "matched existing
products (fields refreshed)" - no quantity implication.
TDD: import file A then file B (same barcode, different name/brand) -> product fields visibly
refreshed + honest summary; idempotency preserved (identical re-import still nets zero).

### Task 8 - PN near-match suggestion (review-only)
Design (owner approved): new pure `src/services/textDistance.ts` (Levenshtein, bounded); after
resolveScanToProduct returns unknown, for alpha_sku codes len>=5, search verified products'
primarySku/vendorCodes + approved alias cleanCodes; surface ONLY if distance<=1 AND exactly one
candidate; new optional `ResolverResult.nearMatchSuggestion` {productId, matchedOn, distance};
resolverStatus STAYS needs_review, never auto-counts, never auto-aliases. Needs Review UI renders
"Did you mean <X>?" going through existing resolveUnknown link_existing approval.
TDD: T432118 vs seeded T432119 -> suggestion attached + status still needs_review; two candidates
within distance -> NO suggestion (never guess); non-alpha_sku codes unaffected.

### Task 9 - Gates + final report
Full `npx vitest run` (note: cloudDrainRace.store.test.ts is timing-flaky under full parallel load
only - rerun isolated before calling it a failure), `npx tsc --noEmit`, `npm run lint`, targeted
Playwright (`e2e/` review flow, CSV import, scan; `npx playwright install chromium` if needed).
Snapshot issue: verify Save-count-snapshot on a fresh preview build only (owner: QA was on a stale
preview). Write final report (doctrine format) + update PROGRESS.md/TESTING.md in the worktree.
Commit everything per-fix. NO push - owner reviews first.
