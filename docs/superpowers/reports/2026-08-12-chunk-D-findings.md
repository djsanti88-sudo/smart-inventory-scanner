# Chunk D Findings — data / catalog / sync / knowledge (2026-08-12)

Read-only analysis pass per `docs/superpowers/plans/2026-08-12-simplification-campaign-brief.md`.
No edits made. All findings below were independently re-verified by the chunk lead (not just
the scout agents) with direct `Grep`/`Read` before being listed as `proven`.

Scope covered: `src/services/db/`, `src/services/catalog/`, `src/services/reconcile/`,
`src/services/csvImport.ts` / `csvExport.ts` / `columnIntelligence.ts`, `src/services/sessions/`,
`src/server/business/`, `src/server/share/`, `src/server/tire-knowledge/*.ts`,
`src/server/retail-knowledge/*.ts` (code only, generated artifacts excluded per brief section 4).

| id | category | evidence | claim | change | confidence | blast radius | LOC delta |
|---|---|---|---|---|---|---|---|
| D-1 | Proven dead code | `src/services/db/firebase/repositories.ts:68-73,89-137` (`scanEventsRepository`, `countSessionsRepository`, `inventoryCountsRepository`, `unknownReviewsRepository`, `settingsRepository`, `shopOverridesRepository`, `businessesRepository`, `membersRepository`, `userProfilesRepository`). Search: `grep -rn "<9 names>" --include=*.ts --include=*.tsx src scripts` (excludes `.next/`) returns matches only inside `repositories.ts` itself — zero callers anywhere else. Verified independently by the chunk lead. | 9 of 13 exported repository factory functions in this file have no consumer; production code reads Firestore through `businessDataLoader.ts`'s own `getDocs` calls instead, and only `productsRepository`/`aliasesRepository` are exercised by `repositories.rules.test.ts`. | Delete the 9 unused factories, keep `productsRepository`, `aliasesRepository`, `auditRepository`, `catalogRepository` (all four have live callers — `catalogRepository` is used by `scanStore.ts`, the other two by tests/other code). | proven | `npm run proof:local`; `npm run test:firebase` (exercises the two rules-tested repositories, unaffected) | ~-55 |
| D-2 | Proven dead code | `src/services/db/firebase/businessDataLoader.ts:14` — re-export `export { toStoreProduct, toStoreAlias, toStoreSession, toStoreCount, toStoreScanEvent } from "./storeMappers";` labeled "back-compat with existing importers" | No importer uses this re-export path. The only real consumer, `src/app/api/resolve-scan/route.ts:7`, imports these five functions directly from `@/services/db/firebase/storeMappers`, never from `businessDataLoader`. Search: `grep -rn "toStoreProduct\|toStoreAlias\|toStoreSession\|toStoreCount\|toStoreScanEvent"` across `src/`. | Delete line 14. | proven | `npm run proof:local` (tsc catches any missed importer) | -1 |
| D-3 | Proven dead code | `src/services/db/firebase/businessDataLoader.ts:36` — re-export of `LOAD_RETRY_BACKOFF_MS` | Zero references anywhere in the repo, including inside the file that re-exports it. Search: `grep -rn "LOAD_RETRY_BACKOFF_MS" src scripts` returns nothing. Its siblings `LOAD_ATTEMPT_TIMEOUT_MS`/`LOAD_MAX_ATTEMPTS` ARE used by `src/stores/businessLoaderRetryPropagation.store.test.ts:25` and must stay. | Delete only the `LOAD_RETRY_BACKOFF_MS` re-export line. | proven | `npm run proof:local` | -1 |
| D-4 | Proven dead code | `src/server/tire-knowledge/TireKnowledgeProvider.ts:154` — `export async function resolveTrustedExactBarcode(...)` ("compatibility wrapper") | Zero callers. Search: `Grep "resolveTrustedExactBarcode\b"` across `src/` returns only the declaration; the pipeline (`src/server/decode/pipeline.ts`) and API route wire up `resolveTrustedExactBarcodeDecision`/`resolveExactBarcode`/`resolveExactPartNumber` instead. Independently re-verified. | Delete the function (and its doc comment). | proven | `npm run proof:local`; corpus tests (`corpusIntegrity.test.ts`, `tireExactIndex.test.ts`) don't touch it | -8 |
| D-5 | Proven dead code + names-that-lie | `src/server/retail-knowledge/retailKnowledgeIndex.ts:155` — `export function lookupRetailBarcode(code)` (sync variant) | Zero callers. Search: `Grep "lookupRetailBarcode[^A]"` across `src/` matches only its own definition plus two comment mentions (lines 71, 145) that already describe it as `lookupRetailBarcode(Async)` in prose; every real caller uses `lookupRetailBarcodeAsync`. Independently re-verified. Secondary defect on the same block: its doc comment claims "tries local SQLite first, then Turso" but the function body never calls Turso — it returns `null` on a SQLite miss. Since the function is dead, this is moot once deleted rather than a separate fix. | Delete the function; the two comment references to `lookupRetailBarcode(Async)` should just read `lookupRetailBarcodeAsync` (comment-only edit, not a test). | proven | `npm run proof:local` + `npm run test:corpus-drift` / `test:golden` (neither exercises the dead sync path) | -10 |
| D-6 | Duplicated logic | `src/services/catalog/brandFamilies.ts:77-84` (private `norm`) vs `src/services/catalog/brandPrefixGeneral.ts:12-19` (exported `normalizeBrand`) | Byte-for-byte identical function bodies (verified by direct read of both). `brandFamilies.ts`'s own comment even says "Same brand-normalization as the firewall so lookups line up" — acknowledging the duplication rather than sharing it. `prefixFirewall.ts` already imports `normalizeBrand` from `brandPrefixGeneral.ts`, proving that is the canonical location. | `brandFamilies.ts` imports `normalizeBrand` from `brandPrefixGeneral.ts` and deletes its private `norm`, updating its 2-3 call sites. | proven | `npx vitest run src/services/catalog/brandFamilies.test.ts` (asserts on `sameBrandFamily`/`familyLabelFor` output, not on `norm` directly) + `npm run proof:local` | -8 |
| D-7 | Duplicated logic | `src/services/catalog/prefixFirewall.ts:33-39` (private `catTokens`) vs `src/services/catalog/candidateUpcSet.ts:31-37` (private `tokens`) | Byte-for-byte identical bodies (verified by direct read of both): lowercase, strip non-alphanumeric, split on space, filter length >= 3. Search: `grep -n "function catTokens\|function tokens"` confirms these are the only two definitions, both unexported/private. | Add a shared `tokenize` export to `brandPrefixGeneral.ts` (the module both files already depend on for `normalizeBrand`) and have both files import it instead of defining their own copy. | proven | `npx vitest run src/services/catalog/prefixFirewall.test.ts src/services/catalog/candidateUpcSet.test.ts` + `npm run proof:local` | -7 |
| D-8 | Proven dead code (interface, escalate before deleting) | `src/services/catalog/catalogProvider.ts:1-21` — entire file, `CatalogProvider` interface | `grep -rn "CatalogProvider" --include=*.ts --include=*.tsx src` (excluding the file's own definition) returns zero implementers/consumers — only a comment in `scanStore.ts:815` ("cloud later via CatalogProvider") that describes it as future scaffolding, never an actual usage. `localCatalogProvider.ts` exports plain functions (`decideLookup`, `findEntry`, `upsertVerified`, `applyAiCandidate`, `observeScan`) that `scanStore.ts` calls directly; nothing implements the `CatalogProvider` shape (`setOverride`/`snapshot()` — grepping those method names hits only unrelated mock/test fixtures). Independently re-verified. | ESCALATE: this is a genuinely unreferenced type, but it reads as intentional forward-looking scaffolding per its own comment ("cloud later via..."), which is a product-direction call, not a mechanical dead-code deletion. Recommend owner decide keep-vs-delete rather than auto-removing. | probable (dead) / decision required | `npm run proof:local` would catch any missed reference if deleted | -21 if approved |

**Total proven, ready-to-execute LOC delta (D-1 through D-7): ~-90 lines.**
Plus D-8 (-21 lines) pending an owner keep/delete call.

## Escalations (would require touching a test or an invariant — out of scope for this pass)

- **D-4a — `mintShareToken`'s dead `ttlMs` parameter.** `src/server/share/shareTokenStore.ts:264-265`:
  the second parameter of `mintShareToken(payload, ttlMs)` is discarded immediately (`void ttlMs;`)
  and never used — the real expiry comes entirely from `payload.expiresAt`, which the one caller
  (`src/app/api/share/route.ts`) computes itself before calling. The parameter name implies it
  controls TTL; it controls nothing. This is a real "names that lie" / dead-parameter finding, but
  removing it requires changing `src/server/share/shareTokenStore.test.ts`, which calls
  `mintShareToken(payload, 60_000)` and `mintShareToken(payload, -60_000)` to construct its cases.
  Per brief section 2, that is out of bounds for this campaign. ESCALATE to the owner as a
  test-touching change, not executed.
- **D-8 (see table)** — escalated as a keep-vs-delete product decision rather than a pure mechanical
  removal, since it is the one candidate that plausibly represents intentional forward design.

## Notes (structurally important, out of scope for a simplification pass)

- **Two Firestore read paths for products/aliases.** `repositories.ts`'s remaining live exports
  (`productsRepository`, `aliasesRepository`) are only exercised by an emulator-gated rules test
  (`repositories.rules.test.ts`); production reads go through `businessDataLoader.ts`'s own direct
  `getDocs` calls instead. Two different code paths read the same collections. Collapsing this is a
  real architecture decision (which path is canonical) with test and behavior implications — flagged
  for a future non-simplification task, not attempted here.
- **`tireListingNormalizer.ts` (324 lines)** is a legitimate split candidate — junk-stripping,
  size-canonicalization, and brand/model extraction are already comment-delimited as separate
  sections (A1/A2/A3) — but splitting a file into more files is a reorganization, not a line-count
  reduction, so it is out of scope per hunt-list item 6 ("cite the seam, do not perform the split").
- **`tireKnowledgeIndex.ts`'s repeated 3-tier fallback** (SQLite → Turso → in-memory JSON) across
  barcode/part-number/size lookups looks like duplication at first glance, but each tier's
  query/normalization differs meaningfully, and the pattern is the documented architecture
  (`docs/ARCHITECTURE.md`: "Two DB layers on purpose"). Not proposed — merging these would add a new
  abstraction layer, which the brief's anti-goals explicitly forbid.
- **`evidenceScoring.ts`'s `ScoreFlags.weakGenericName` / `.privateDataDetected`** are hardcoded
  `false` at their one call site in `catalogAutoVerify.ts`. This is unfinished wiring (a behavior
  gap), not redundant code — noted for awareness, not proposed as a finding.
- **`reconcile/`, `csvImport.ts`, `csvExport.ts`, `columnIntelligence.ts`** were checked closely
  (brand-corroboration tiers, AM-R4/AM-R5/AM-R8 rules) and are clean: every exported function has a
  real production caller, and `shopwareCsvAdapter.ts` / `universalAdapter.ts` intentionally diverge
  in input shape (raw CSV text vs. pre-parsed sheet + column mapping) rather than duplicating logic.
  No findings in this subtree.
- **`src/server/business/provisioning.ts` and `src/services/sessions/*`** — checked, no dead code,
  no duplicate decisions, no single-caller wrapper problems. Clean.
- A directory-scoped `Grep` occasionally returned "No files found" against `repositories.ts`
  specifically during scouting despite the pattern being present (confirmed present via `Bash`/`grep`
  and via a file-scoped `Grep` call). This looks like a caching/indexing quirk of the search tool on
  this file, not a real absence — worth a heads-up to anyone else running dead-code sweeps in this
  chunk, since a naive read of a null result here would falsely conclude a symbol is dead.
