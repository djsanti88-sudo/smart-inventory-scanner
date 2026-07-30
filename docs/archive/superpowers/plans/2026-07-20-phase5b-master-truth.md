# Phase 5b - Master-Truth Write Path + Master-Read Conflict Feed (2026-07-20)

**Goal:** Complete the two-DB identity model's master side: (W) strong app-verified decode results
append to the program-owned Firestore `catalogEntries` master catalog via an Admin-SDK server path,
and (R) the tiered resolver's empty master slot gets a REAL feed so tenant-vs-master identity
conflicts are detected and routed to Needs Review. Deferred here from P5 (see
`2026-07-20-phase5-decode-trust.md:22,234`). Scout evidence: `.superpowers/sdd/p5b-scout.md`.

**Acceptance criteria:**
1. A decode that settles `status:"verified"` + `exactCodeEvidenceVerifiedByApp:true` on a public
   barcode appends (idempotently) a sanitized entry to top-level `catalogEntries` with
   `provenanceTier:"ladder_verified_strong"`, server-side only. Suggested / self-report / vendor-label
   results NEVER write. A failed append never breaks the decode response.
2. No master payload ever contains `businessId` (asserted in code + tested).
3. Client-SDK writes to `catalogEntries` remain hard-denied (existing rules test still passes).
4. When the async cloud-catalog enrichment finds a master entry whose identity DISAGREES with the
   tenant product already resolved for the same code, the row routes to Needs Review with an honest
   cross-tier-conflict reason. Agreement or no-tenant-product = behavior unchanged.
5. TOP-LEVEL LAW intact: conflict handling changes IDENTITY only; the row already appeared and
   counted synchronously before any of this runs. `npm run test:ledger` 44/44.
6. Sync hot path stays synchronous and I/O-free (resolver.ts, aliasMatcher.ts, the :4072 dedup guard
   keep `masterCandidates: []` - documented, not an omission).

## Global Constraints (landmines - every task obeys these)
- **GC1 (id namespace trap):** `MasterCandidate.productId` is folded into the tenant
  `distinctProductIds` set (aliasMatcher.ts:269-271, set built at :273). NEVER feed a raw
  `CatalogEntry.id`. Agreement maps to the EXISTING tenant `Product.id`; disagreement uses the
  `"master:"+id` namespace tag; no tenant candidate for the code = emit NOTHING (the existing
  cloudCatalogResolve enrichment already owns that case).
  **HARD INVARIANT (review F3):** the resolver pushes master candidates UNCONDITIONALLY - a
  `masterCandidates` array whose only entries are `master:`-prefixed ids with ZERO tenant-origin
  candidates would make `resolveScanToProductTiered` return status "known" pointing at a phantom
  product id. Task 4 must therefore (a) only pass a non-empty `masterCandidates` when tenant
  candidates were non-empty first, (b) dev-assert this invariant at the call site, and (c) both
  Task 3 and Task 4 carry the explicit regression test: master-only input -> `toMasterCandidates`
  returns `[]` AND the tiered resolver is never called with a lone `master:` candidate.
- **GC2 (purity):** `src/services/resolver.ts` + `aliasMatcher.ts` stay pure/sync. All I/O lives in
  the store's async enrichment (`cloudCatalogResolve`, scanStore.ts:2458) or server routes.
- **GC3 (tenancy):** master writes go through `getAdminDb()` against the literal top-level
  `catalogEntries` collection. NEVER via `bizSubcollection`/tenant repositories. The builder strips
  and asserts absence of `businessId` (defense in depth).
- **GC4 (name collision + the missing-id boundary, review F2 BLOCKER):** there are THREE distinct
  `CatalogEntry` types: `src/services/db/types.ts` (Firestore shape, HAS `id`), and
  `src/services/catalog/catalogTypes.ts:22-52` (the store shape `cloudCatalogResolve` actually
  receives - it has NO `id` field and its own 3-value `verificationStatus` at catalogTypes.ts:8),
  plus scanStore's local usage. `toStoreEntry` (scanStore.ts:5844-5848) drops `raw.id` today, so
  Task 3's input is UNCONSTRUCTABLE from the store shape as-is. Resolution (decided): extend the
  boundary - `catalogTypes.CatalogEntry` gains OPTIONAL `masterId?: string` and
  `masterProvenanceTier?: ProvenanceTier`, and `toStoreEntry` passes `raw.id` /
  `raw.provenanceTier` through. Both fields optional = zero impact on every existing constructor.
  Import with explicit aliases (`import type { CatalogEntry as DbCatalogEntry } ...`).
- **GC5 (tier mapping):** `CatalogEntry` gains `provenanceTier?: ProvenanceTier` (mirrors
  `Product.provenanceTier`, src/types.ts:89-94). `verificationStatus` KEEPS its 3-value vocabulary
  ("verified" for app-verified appends) so every existing reader (`toStoreEntry`,
  scanStore.ts:5842-5844) is untouched. Mapping used here: app-verified ladder decode ->
  `ladder_verified_strong`. No other tiers are minted by this phase.
- **GC6 (idempotency + no-downgrade):** doc id = `"gtin_" + canonicalGtin(normalizedBarcode)`
  (src/services/upc/gtin.ts:34-41) so retries upsert the same doc (`set(..., { merge: true })`).
  `canonicalGtin` returns NULL for non-GTIN input (review F5): `buildMasterCatalogEntry` must
  return null when it does - NEVER construct a `"gtin_null"` id (cross-product collision corruption).
  The human_verified no-downgrade check runs inside `db.runTransaction(...)` (review F6) - the
  Admin SDK supports it and it removes the read-then-write race outright.
- **GC7 (E2E + failure isolation):** the route hook is skipped in `e2eMode()`; the append is
  fire-and-forget (`void ...catch()`), can never change the HTTP response, and unit tests mock the
  Admin SDK (no live Firestore in `npm test`).
- **GC8 (server-only):** `masterAppend.ts` lives under `src/server/**` and imports
  `@/lib/firebaseAdmin` (already `import "server-only"`). The static import-boundary test must stay
  green.
- **GC9 (law):** nothing in this phase may touch `ensureProvisionalCount` ordering, counting math, or
  suppress a row. Conflict = `needs_review` identity outcome only.
- **GC10 (server path out of scope, review F8):** server-side resolution (`resolveScanServer.ts`,
  `resolve-scan/route.ts`) keeps `masterCandidates: []` this phase - a server-path-only consumer will
  not see cross-tier conflicts until a follow-on. Documented gap, not an oversight; AC4 is the CLIENT
  `cloudCatalogResolve` path only.

## Files touched (consolidated)
New: `src/server/catalog/masterAppend.ts` + test, `src/services/catalog/masterCandidates.ts` + test.
Modified: `src/services/db/types.ts`, `src/services/catalog/catalogTypes.ts`,
`src/app/api/ai-lookup/route.ts` + route test, `src/stores/scanStore.ts` (cloudCatalogResolve +
toStoreEntry), `src/services/resolver.ts` (comment only), firebase rules spec (one deny assertion).

## Cost
All local/mocked - $0 external. No live API calls, no deploy; emulator + shells only.

## Task 1 - Master append module (server, new files)
**Files:** `src/services/db/types.ts` (add field), NEW `src/server/catalog/masterAppend.ts`,
NEW `src/server/catalog/masterAppend.test.ts` (vitest unit project).
**Interfaces (Produces):**
```ts
// db/types.ts CatalogEntry gains:
provenanceTier?: ProvenanceTier;  // import type from "@/types"

// masterAppend.ts
export interface MasterAppendInput {
  normalizedBarcode: string;
  codeType: string;                       // must be one of upc_a | ean_13 | gtin_14 (public shapes)
  decision: { status: string; exactCodeEvidenceVerifiedByApp?: boolean; confidence?: number };
  identity: { name?: string; brand?: string; category?: string };
}
/** Pure trust gate + payload builder. Returns null unless status==="verified" &&
 *  exactCodeEvidenceVerifiedByApp===true && public codeType && non-empty name.
 *  Output NEVER contains businessId (strip + assert via a key filter). */
export function buildMasterCatalogEntry(input: MasterAppendInput): DbCatalogEntry | null;
/** Admin-SDK upsert per GC6. deps injectable for tests: { db?: FirebaseFirestore.Firestore }. */
export async function appendMasterCatalogEntry(entry: DbCatalogEntry, deps?): Promise<"written"|"skipped_human"|"error">;
```
**TDD:** failing-first tests: (a) suggested/self-report/vendor_label/x00 -> null; (b) verified +
app-verified + upc_a -> entry with provenanceTier "ladder_verified_strong", verificationStatus
"verified", id "gtin_..."; (c) an input object carrying a stray `businessId` key -> output has none;
(d) mocked existing doc human_verified -> "skipped_human", write not applied (transaction path);
(e) write applied with merge semantics at `catalogEntries/gtin_<canonical>` inside runTransaction;
(f) `canonicalGtin` null (malformed code despite public codeType) -> builder returns null, no
`gtin_null` id ever constructed (review F5).

## Task 2 - Route hook (server write wiring)
**Files:** `src/app/api/ai-lookup/route.ts` (the dead `getAdminAuth/getAdminDb` import at :19 becomes
live or is replaced by importing masterAppend), its route test file.
**Edit (review F4 - route.ts has THREE return branches after :343: persisted ~:358, cap_blocked
~:365, fresh fallthrough ~:373):** the hook fires on ANY outcome branch that carries a decode
decision passing the Task-1 gate (fresh compute AND persisted/L2-replay - the idempotent
transactional upsert makes replay appends harmless and keeps master fresh); it NEVER fires on
cap_blocked (no decision). Implementer: verify each branch's actual payload shape and apply one
shared helper before each qualifying return. Fire-and-forget (`void ...catch(() => {})`), never
awaited into the response. Feature-flag env `MASTER_CATALOG_APPEND` default ON, forced OFF when
`IS_E2E`/`e2eMode()`.
**TDD:** route test with mocked pipeline outcome + mocked masterAppend: (a) verified app-verified ->
append called once with the sanitized entry; (b) suggested -> never called; (c) append rejection does
not change the HTTP response; (d) IS_E2E -> never called.

## Task 3 - Master-candidate transform (pure, client-safe, new files)
**Files:** NEW `src/services/catalog/masterCandidates.ts`, NEW `masterCandidates.test.ts`.
**Interfaces:**
```ts
// Input = the STORE CatalogEntry shape (catalogTypes.ts) AFTER the GC4 boundary extension - the
// caller (Task 4) reads masterId/masterProvenanceTier off the store entry; raw db-shape ids are
// never handled client-side.
export interface MasterHit { masterId: string; name?: string; brand?: string; masterProvenanceTier?: ProvenanceTier }
/** GC1 semantics. tenantProducts/aliases = current store state; cleaned = the scanned code.
 *  - find tenant candidate products already resolvable for this code (reuse resolveScanToProductTiered
 *    with empty master slot, or the exported candidate collection helper if present);
 *  - none -> [];
 *  - identity AGREES (brand family-aware equal via brandFamilies + name jaccard >= IDENTITY_JACCARD_THRESHOLD
 *    using nameTokens/jaccard from identityMerge.ts) -> [{ productId: tenantProduct.id, matchedOn: code,
 *    provenanceTier: hit.provenanceTier ?? "corpus_verified" }] (agreement reinforces, never conflicts);
 *  - identity DISAGREES -> [{ productId: "master:"+hit.id, ... }] (distinct id -> resolver emits conflict). */
export function toMasterCandidates(hit: MasterHit, tenantProducts: Product[], aliases: Alias[], cleaned: CleanedCode, businessId: string): MasterCandidate[];
```
**TDD:** (a) no tenant product -> []; (b) same brand+name -> tenant-id candidate, tiered resolve
returns the SAME product, no conflict; (c) different brand (non-family) -> "master:" id, tiered
resolve returns conflict; (d) Michelin/BFGoodrich family sibling -> NOT a conflict (brandFamilies);
(e) REGRESSION LOCK for the GC1 trap: raw masterId never appears as a productId when a tenant
product exists and agrees; (f) REGRESSION LOCK (review F3): zero tenant candidates -> `[]`, and a
direct `resolveScanToProductTiered` call with a lone `master:` candidate is asserted to be the
phantom-known failure mode this guard prevents (documented negative-shape test).

## Task 4 - Store wiring (LAW-CRITICAL - dedicated review after implementation)
**Files:** `src/stores/scanStore.ts` ONLY (`cloudCatalogResolve`, :2458 area). Grep, don't browse.
**Edit:** inside `cloudCatalogResolve` after a master entry is fetched and BEFORE the existing
apply/auto-verify logic: build `toMasterCandidates(...)` from current state; if it yields a
`"master:"`-namespaced candidate, re-run `resolveScanToProductTiered` with it; on `conflict`, set the
review row / feed row to `needs_review` with reason
`"Cross-tier conflict: master catalog identity disagrees with this account's product"` and SKIP the
enrichment apply (identity only - the count/row are already on the books; GC9). Agreement/no-tenant:
existing behavior byte-identical. The sync call sites (resolver.ts:36, scanStore.ts:4074) KEEP
`masterCandidates: []` + gain a one-line comment pointing here (GC2/AC6).
**Files (GC4 boundary):** this task ALSO owns the `catalogTypes.CatalogEntry` optional-field
extension + the `toStoreEntry` passthrough (scanStore.ts:5844-5848) so `masterId`/
`masterProvenanceTier` reach `cloudCatalogResolve`.
**TDD:** store-level tests (mock lookupGlobalCatalog): (a) conflict -> row needs_review + count
unchanged + honest reason; (b) agreement -> enrichment applies exactly as today; (c) LAW: feed row
existed + counted before the async resolve ran (assert on the pre-await state); (d) HARD INVARIANT
(review F3): a master-only hit (no tenant candidate) never reaches the tiered resolver - existing
enrichment behavior byte-identical, dev-assert fires in test if violated.

## Task 5 - Phase gate + proof
- `npm test`, `npx tsc --noEmit`, `npm run test:ledger`, `npm run test:golden`, `npm run test:firebase`
  (rules: client write to catalogEntries still denied - extend the existing rules spec with one
  explicit `catalogEntries` write-deny assertion if not already present), `npm run build`,
  full `npm run test:e2e`, `python -m tools.fable5 review-build`.
- Product-resolution change => human-bot browser proof required before handoff
  (`npm run qa:bots:tire` minimum) per CLAUDE.md - run at phase close.

**Execution:** T1/T2/T3 disjoint -> parallel Sonnet implementers. T4 after T3 (consumes its module),
dedicated model review (monolith + law). Orchestrator diff-verifies + commits each task; slim ultra
review over the whole-phase diff at close.
