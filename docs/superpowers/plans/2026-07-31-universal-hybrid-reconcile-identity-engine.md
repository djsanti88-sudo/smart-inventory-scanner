# Universal Hybrid Reconcile Identity Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Safely reconcile every local import row with explainable identity decisions and exactly-once optional physical-count application.

**Architecture:** Pure identity code lives in `src/services/identity`; only all-hit local snapshots feed it. Preview is stateless and returns a deterministic bounded signed chunk set; server-only local/mock persistence owns links/runs/claims, while browser IndexedDB can only cache those signed chunks.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, existing CSV/XLSX reader, local corpus, Web Crypto HMAC/SHA-256.

## Global Constraints

- No E2E, deploy, push, production persistence, live/paid provider, real-data import, or Firebase installation/authentication.
- Buckets are exactly `automatic | review | abstain | non_product | invalid`; each input row serializes into one terminal bucket. `non_product` requires an explicit adapter record type or exact allowlisted normalized category (`labor|service|fee|subtotal|header`), never free text/semantic/model inference.
- Preview performs no writes, decode, provider, network, Turso, or `LadderStorage` initialization.
- Candidate lookup is local-only/all-hit and fails closed without a local snapshot; never use first-hit or `LIMIT 1`.
- Vendor identifiers remain namespaced; imported provenance is untrusted; semantic ranking never creates automatic identity.
- Reconcile never changes counts. Physical count writes one aggregate event per source row, never scanner events per unit.
- Firebase proof requires local `firebase --version`; if unavailable record `firebase_emulator_gate: BLOCKED` and do not claim GREEN.

## File map

`src/services/identity/{types,canonical,plugins,tirePlugin,engine,preview,importLedger}.ts` owns pure contracts. `src/server/identity/{localSnapshotIndex,readOnlyCandidateSource,localRepository,applyService}.ts` owns local snapshot, server persistence, and apply. `src/services/identity/previewCache.ts` is browser cache only. Existing seams are `src/services/importSchema.ts`, `src/services/universalFileReader.ts`, `src/services/universalImportPreview.ts`, `src/components/UniversalImportPanel.tsx`, `src/components/ReconcilePanel.tsx`, `src/services/inventory.ts`, and `src/services/inventory.replay.ts`.

### Task 1: Define typed identity and fingerprint contracts

**Files:** Create `src/services/identity/types.ts`, `src/services/identity/canonical.ts`; Test `src/services/identity/canonical.test.ts`.

**Interfaces:** Define identity contracts, validation/canonical helpers, and `createImportIds({ sanitizedContentRootHash, orderedMappings, businessId, sourceSystem, vendorId, importerVersion })`; original file hashes and issued/expiry metadata are excluded from sanitized content identity/importId.

- [ ] **Step 1: Write failing tests** — validation cases; same sanitized root/mapping/scope yields identical importId despite different file hashes or issued/expiry values, while changing sanitized content root or mapping changes importId.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/canonical.test.ts`; expected missing exports.
- [ ] **Step 3: Implement minimal contracts** — use sorted-key canonical UTF-8 JSON and `identity-import-v1` SHA-256; validation rejects non-finite/negative quantity, unsupported unit, malformed identifier, and missing required scope; `IdentityDecisionKind` includes all five buckets.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/identity/canonical.test.ts && npx eslint src/services/identity/types.ts src/services/identity/canonical.ts src/services/identity/canonical.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/identity/types.ts src/services/identity/canonical.ts src/services/identity/canonical.test.ts && git commit -m "feat: add identity contracts"`.

### Task 2: Implement generic and tire plugins

**Files:** Create `src/services/identity/plugins.ts`, `src/services/identity/tirePlugin.ts`; Test matching `.test.ts` files.

**Interfaces:** Define `IdentityCategoryPlugin { normalize; deterministicKeys; hardConstraints; semanticFeatures }`, `genericIdentityPlugin`, `tireIdentityPlugin`, `pluginFor`.

- [ ] **Step 1: Write failing tests** — inline tire fixtures asserting size and R8/R8+ reject; generic text feature is review-only.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/plugins.test.ts src/services/identity/tirePlugin.test.ts`; expected missing modules.
- [ ] **Step 3: Implement minimal plugins** — reuse `tireSizeToken`, `sameBrandFamily`, `nameTokens`, `jaccard`, `plusGenerationDiff`; generic deterministic keys are exact typed IDs only.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/identity/plugins.test.ts src/services/identity/tirePlugin.test.ts && npx eslint src/services/identity/plugins.ts src/services/identity/tirePlugin.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/identity/plugins.ts src/services/identity/tirePlugin.ts src/services/identity/plugins.test.ts src/services/identity/tirePlugin.test.ts && git commit -m "feat: add identity plugins"`.

### Task 3: Build pure decision engine

**Files:** Create `src/services/identity/engine.ts`; Test `src/services/identity/engine.test.ts`.

**Interfaces:** `decideIdentity(input, snapshot, plugin): Promise<IdentityDecision>` and `decideIdentityBatch(inputs, source): Promise<IdentityDecision[]>`.

- [ ] **Step 1: Write failing tests** — one approved exact candidate is automatic; exact tie, provider candidate, and unverified candidate are review; malformed input is invalid.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/engine.test.ts`; expected missing function.
- [ ] **Step 3: Implement minimal engine** — validate, constrain, discard contradictions, rank deterministically, fingerprint decision; only unique immutable eligible evidence is automatic.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/identity/engine.test.ts && npx eslint src/services/identity/engine.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/identity/engine.ts src/services/identity/engine.test.ts && git commit -m "feat: add identity engine"`.

### Task 4: Add all-hit local snapshot candidate source

**Files:** Create `src/server/identity/localSnapshotIndex.ts`, `src/server/identity/readOnlyCandidateSource.ts`; Test `src/server/identity/readOnlyCandidateSource.test.ts`, `src/services/db/firebase/apiRouteImportGraph.test.ts`.

**Interfaces:** `lookupAllLocalBarcodes(snapshot, keys)`, `lookupAllLocalPartNumbers(snapshot, keys)`, `createReadOnlyCandidateSource({ snapshot, lookupApprovedLinks }): IdentityCandidateSource`.

- [ ] **Step 1: Write failing tests** — retained fixture has two collision hits, repeated keys batch once, missing snapshot throws `local_snapshot_unavailable`; static graph assertion rejects `@/server/upc/storage`, `@libsql/client`, `fetch`, decode, and `/api/ai-lookup` imports.
- [ ] **Step 2: Run RED** — `npx vitest run src/server/identity/readOnlyCandidateSource.test.ts src/services/db/firebase/apiRouteImportGraph.test.ts`; expected missing APIs/assertion.
- [ ] **Step 3: Implement minimal local source** — use `Map<string, IdentityCandidate[]>`, return all hits and snapshot versions, authorize exact tenant/source/vendor links, and never import storage/client/provider modules.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/server/identity/readOnlyCandidateSource.test.ts src/services/db/firebase/apiRouteImportGraph.test.ts && npx eslint src/server/identity/localSnapshotIndex.ts src/server/identity/readOnlyCandidateSource.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/server/identity/localSnapshotIndex.ts src/server/identity/readOnlyCandidateSource.ts src/server/identity/readOnlyCandidateSource.test.ts src/services/db/firebase/apiRouteImportGraph.test.ts && git commit -m "feat: add local all-hit identity source"`.

### Task 5: Freeze evaluator and baseline format

**Files:** Create `src/eval/identity/{types,evaluator,evaluator.test}.ts`, manifest/report files, `scripts/benchmark-identity-import.mjs`.

**Interfaces:** `evaluateIdentityCases(cases, decisions): IdentityMetrics` reports bucket/quantity accounting, false automatic, coverage, review recall/precision@3, strata, CI, latency.

- [ ] **Step 1: Write failing tests** — before fixture generation inline three immutable cases: automatic positive, review missing true candidate, abstain; assert accounting includes `invalid: 0`.
- [ ] **Step 2: Run RED** — `npx vitest run src/eval/identity/evaluator.test.ts`; expected evaluator absent.
- [ ] **Step 3: Implement minimal evaluator** — generate synthetic-only checked-in manifest/report marked `promotionEligible:false`; group before corruption.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/eval/identity/evaluator.test.ts && npx eslint src/eval/identity scripts/benchmark-identity-import.mjs`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/eval/identity/types.ts src/eval/identity/evaluator.ts src/eval/identity/evaluator.test.ts src/eval/identity/fixtures/identity-manifest.v1.json src/eval/identity/reports/baseline.v1.json scripts/benchmark-identity-import.mjs && git commit -m "test: add identity evaluator"`.

### Task 6: Upgrade reader with explicit compatibility wrapper

**Files:** Modify `src/services/importSchema.ts`, `src/services/universalFileReader.ts`; Test their existing tests.

**Interfaces:** `readUniversalWorkbook(file)` returns every non-empty sheet; `readUniversalFile(file)` remains compatibility wrapper and throws on multi-sheet; `.xls` throws safe-export error.

- [ ] **Step 1: Write failing tests** — XLSX keeps two named sheets; wrapper throws multi-sheet and CSV stays compatible.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/importSchema.test.ts src/services/universalFileReader.test.ts`; expected workbook API absent.
- [ ] **Step 3: Implement minimal reader** — retain `text`/`arrayBuffer`, use CSV/TSV/ExcelJS XLSX paths, do not silently choose first sheet or parse BIFF.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/importSchema.test.ts src/services/universalFileReader.test.ts && npx eslint src/services/importSchema.ts src/services/universalFileReader.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/importSchema.ts src/services/universalFileReader.ts src/services/importSchema.test.ts src/services/universalFileReader.test.ts && git commit -m "feat: read all import sheets"`.

### Task 7: Add server-only repository, vendor-wide rules, and preview cache

**Files:** Create `src/server/identity/atomicLocalStorage.ts`, its test, `src/server/identity/localRepository.ts`, its test, `src/server/identity/localAggregateLedger.ts`, its test, `src/services/identity/previewCache.ts`, its test; Modify `src/services/identity/types.ts`.

**Interfaces:** `AtomicLocalStorage { transaction<T>(fn: AtomicTransaction=>Promise<T>): Promise<T> }`, `createFileAtomicLocalStorage({ root: resolved .tmp/identity-import/<run-id> })`; typed vendor-wide rule/review-only transformation; complete `ImportRun` lifecycle; `createLocalRepository(storage)` and `createLocalAggregateLedger(storage): AggregateLedgerPort`; browser `PreviewCacheStorage` remains cache-only.

- [ ] **Step 1: Write failing tests** — exact source/rule/lifecycle cases; file adapter rejects a root outside repository-local `.tmp/identity-import`, atomically survives adapter reconstruction/crash, and ledger returns its stored result after restart; Node cache fake lacks claim API.
- [ ] **Step 2: Run RED** — `npx vitest run src/server/identity/atomicLocalStorage.test.ts src/server/identity/localRepository.test.ts src/server/identity/localAggregateLedger.test.ts src/services/identity/previewCache.test.ts`; expected missing atomic repository/ledger/cache.
- [ ] **Step 3: Implement minimal boundary** — injected storage owns repository/ledger atomicity; concrete local/mock file adapter uses resolved `.tmp/identity-import/<run-id>`, mutex plus atomic temp-file replacement, and refuses path escape. Production adapter stays blocked; IndexedDB caches signed chunks only.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/server/identity/atomicLocalStorage.test.ts src/server/identity/localRepository.test.ts src/server/identity/localAggregateLedger.test.ts src/services/identity/previewCache.test.ts && npx eslint src/server/identity/atomicLocalStorage.ts src/server/identity/localRepository.ts src/server/identity/localAggregateLedger.ts src/services/identity/previewCache.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/server/identity/atomicLocalStorage.ts src/server/identity/atomicLocalStorage.test.ts src/server/identity/localRepository.ts src/server/identity/localRepository.test.ts src/server/identity/localAggregateLedger.ts src/server/identity/localAggregateLedger.test.ts src/services/identity/previewCache.ts src/services/identity/previewCache.test.ts src/services/identity/types.ts && git commit -m "feat: add local durable identity repository"`.

### Task 8: Build stateless signed preview

**Files:** Create `src/services/identity/preview.ts`, its test, `src/app/api/identity/preview/route.ts`, its test; Modify `src/services/universalImportPreview.ts`.

**Interfaces:** `SignedPreviewChunk` carries `sanitizedContentRootHash`, canonical sanitized rows/decisions/mappings/scope, file-hash provenance, issued/expiry, and signature. Root preimage is the ordered content-identity projection and omits file hashes, root, signatures, issuedAt, and expiresAt; full signed chunks still bind all omitted provenance/time fields. `createIdentityPreview` returns `{ preview, signedPayloads }`.

- [ ] **Step 1: Write failing tests** — file-hash or issued/expiry-only changes leave sanitized root/importId unchanged but alter signatures; sanitized content/mapping changes alter root/importId; missing/reordered/mixed-root chunks fail.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/preview.test.ts src/app/api/identity/preview/route.test.ts`; expected signer/preview absent.
- [ ] **Step 3: Implement minimal preview** — hash ordered canonical content-identity projections excluding file hashes/root/signatures/times, derive importId from sanitized root+mappings+scope, then insert provenance/time/root and sign full chunks.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/identity/preview.test.ts src/app/api/identity/preview/route.test.ts && npx eslint src/services/identity/preview.ts src/app/api/identity/preview/route.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/identity/preview.ts src/services/identity/preview.test.ts src/app/api/identity/preview/route.ts src/app/api/identity/preview/route.test.ts src/services/universalImportPreview.ts && git commit -m "feat: add signed identity preview"`.

### Task 9: Add aggregate import union and replay adapter

**Files:** Create `src/services/identity/importLedger.ts` and test; Modify `src/services/inventory.ts`, `src/services/inventory.replay.ts`; Test replay/ledger gates.

**Interfaces:** `createAggregateImportEvent(input): AggregateImportEvent`, `mapAggregateImportEventToCountDelta(event)`, `AggregateLedgerPort { applyOnce(event: AggregateImportEvent, key: string): Promise<ApplyOnceResult>; findByIdempotencyKey(key: string): Promise<ApplyOnceResult|null> }`, `replayInventoryEvents(events: Array<ScanEvent|AggregateImportEvent>, sessionId)`, and compatibility `replayLedgerCounts(events: ScanEvent[], sessionId)` delegates to `replayInventoryEvents` so `npm run test:ledger` callers remain valid.

- [ ] **Step 1: Write failing tests** — inline physical row yields one `{kind:"aggregate_import",quantity:7}` and replay 7; reconcile has no aggregate event; retained fake `AggregateLedgerPort` proves duplicate `applyOnce` returns prior result and `findByIdempotencyKey` supports crash recovery.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/importLedger.test.ts src/services/inventory.replay.test.ts`; expected union adapter absent.
- [ ] **Step 3: Implement minimal ledger** — stable key derives importId+rowId, implement injectable atomic `AggregateLedgerPort`, map aggregate events into count math, keep `replayLedgerCounts` compatibility delegation, and never cast to ScanEvent/call processScan/create N events.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/services/identity/importLedger.test.ts src/services/inventory.replay.test.ts && npm run test:ledger && npx eslint src/services/identity/importLedger.ts src/services/inventory.ts src/services/inventory.replay.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/services/identity/importLedger.ts src/services/identity/importLedger.test.ts src/services/inventory.ts src/services/inventory.replay.ts src/services/inventory.replay.test.ts src/stores/ledgerInvariants.store.test.ts && git commit -m "feat: add aggregate import events"`.

### Task 10: Apply verified signed preview idempotently

**Files:** Create `src/server/identity/applyService.ts` and test, `src/app/api/identity/apply/route.ts` and test.

**Interfaces:** `applyIdentityImport({ signedPayloads, mode, corrections }, { repository, verifier, source, ledger }): Promise<ApplyResult>` consumes Tasks 7–9; route wires one injected atomic storage into repository and ledger. Only managers/owners apply; clerks preview only.

- [ ] **Step 1: Write failing tests** — recompute sanitized root/importId; content/mapping changes reject, file-hash/time-only changes do not alter identity but tampering still breaks signature; chunk/auth/recovery cases remain covered.
- [ ] **Step 2: Run RED** — `npx vitest run src/server/identity/applyService.test.ts src/app/api/identity/apply/route.test.ts`; expected service absent.
- [ ] **Step 3: Implement minimal apply** — verify full-chunk signatures, project out file hashes/root/signatures/times, recompute sanitized root and import/row IDs from canonical sanitized content/mappings/scope, then claim/apply/recover.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/server/identity/applyService.test.ts src/app/api/identity/apply/route.test.ts && npx eslint src/server/identity/applyService.ts src/app/api/identity/apply/route.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/server/identity/applyService.ts src/server/identity/applyService.test.ts src/app/api/identity/apply/route.ts src/app/api/identity/apply/route.test.ts && git commit -m "feat: apply signed imports"`.

### Task 11: Add scoped identity review

**Files:** Create review route/table and matching tests.

**Interfaces:** actions confirm candidate, reject, create tenant product, revoke link.

- [ ] **Step 1: Write failing tests** — manager may confirm same-tenant candidate; clerk cannot approve/create/count.
- [ ] **Step 2: Run RED** — `npx vitest run src/app/api/identity/reviews/route.test.ts src/components/IdentityReviewTable.test.tsx`; expected missing route/table.
- [ ] **Step 3: Implement minimal review** — write audit review/link through Task7; no shared catalog promotion.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/app/api/identity/reviews/route.test.ts src/components/IdentityReviewTable.test.tsx && npx eslint src/app/api/identity/reviews/route.ts src/components/IdentityReviewTable.tsx`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/app/api/identity/reviews/route.ts src/app/api/identity/reviews/route.test.ts src/components/IdentityReviewTable.tsx src/components/IdentityReviewTable.test.tsx && git commit -m "feat: add identity reviews"`.

### Task 12: Migrate universal import and reconcile UI

**Files:** Modify UniversalImportPanel, Container, ReconcilePanel and their tests.

**Interfaces:** consume Task8 preview; apply request is `{ signedPayloads, mode, corrections }`; no source-byte reupload exists. `NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1=1` enables new local/mock coexistence.

- [ ] **Step 1: Write failing DOM tests** — flag off preserves legacy path; flag on uses all sheets/five buckets/chunks; clerk has no apply; manager submits complete `signedPayloads`; no silent first-sheet caller on new path.
- [ ] **Step 2: Run RED** — `npx vitest run src/components/UniversalImportPanel.test.tsx src/components/ReconcilePanel.test.tsx`; expected old first-sheet/store flow.
- [ ] **Step 3: Implement minimal UI** — wire flag-controlled coexistence, caching/submitting all Task8 chunks; keep legacy callers while flag off. Cut over/remove legacy only in a later owner-approved change after all gates pass.
- [ ] **Step 4: Run GREEN/lint** — `npx vitest run src/components/UniversalImportPanel.test.tsx src/components/ReconcilePanel.test.tsx && npx eslint src/components/UniversalImportPanel.tsx src/components/UniversalImportPanelContainer.tsx src/components/ReconcilePanel.tsx`; expected PASS.
- [ ] **Step 5: Commit** — `git add src/components/UniversalImportPanel.tsx src/components/UniversalImportPanelContainer.tsx src/components/ReconcilePanel.tsx src/components/UniversalImportPanel.test.tsx src/components/ReconcilePanel.test.tsx && git commit -m "feat: use signed identity preview UI"`.

### Task 13: Prove security, purity, concurrency, and Firebase condition

**Files:** Create security/concurrency tests; modify Firebase sync tests only if contract coverage requires it.

**Interfaces:** consume Tasks 4,7–10 and existing `_appliedKeys` behavior.

- [ ] **Step 1: Write failing tests** — forged authority, revoked link, source mismatch, approve/revoke race, cross-tenant evidence, duplicate claim, and poison preview/default-apply calls fail closed.
- [ ] **Step 2: Run RED** — `npx vitest run src/services/identity/security.test.ts src/server/identity/applyConcurrency.test.ts`; expected matrix absent.
- [ ] **Step 3: Implement minimal guards** — add only tenant/purity/race guards and import-boundary assertions; no production rules/indexes.
- [ ] **Step 4: Run GREEN/lint** — run `npx vitest run src/services/identity/security.test.ts src/server/identity/applyConcurrency.test.ts src/services/db/firebase/firebaseSyncTarget.test.ts`, then `npx eslint src/services/identity/security.test.ts src/server/identity/applyConcurrency.test.ts src/services/db/firebase/firebaseSyncTarget.test.ts src/services/db/firebase/firebaseSyncTarget.rules.test.ts`; after both PASS run `firebase --version`, and only if present run `npm run test:firebase`, otherwise record `firebase_emulator_gate: BLOCKED` with CLI output.
- [ ] **Step 5: Commit** — `git add src/services/identity/security.test.ts src/server/identity/applyConcurrency.test.ts src/services/db/firebase/firebaseSyncTarget.test.ts src/services/db/firebase/firebaseSyncTarget.rules.test.ts && git commit -m "test: harden identity imports"`.

### Task 14: Lock local 5,000-row performance and final gates

**Files:** Create perf test/frozen fixture; modify benchmark script and ARCHITECTURE.

**Interfaces:** consume Task8 chunked preview/evaluator and emit local timing plus chunk-count/max-byte/root-verification report.

- [ ] **Step 1: Write failing test** — inline deterministic 5,000 inputs; assert warm wall <=10s, decision p95 <=2ms, accounting exact, multiple chunks, every token <=512 KiB, and root verification passes.
- [ ] **Step 2: Run RED** — `npx vitest run src/eval/identity/importPerf.test.ts`; expected fixture/harness absent.
- [ ] **Step 3: Implement minimal harness** — generate checked-in frozen fixture, measure parse/retrieval/decision/serialization/UI scheduling, and document Task8 stateless preview plus Task9 count separation.
- [ ] **Step 4: Run GREEN/final local gates** — `npx vitest run src/eval/identity/importPerf.test.ts && npm run test:ledger && npm run test:corpus-drift && npm run test:golden && npx tsc --noEmit`; expected PASS; Firebase remains GREEN only if Task13 preflight succeeded.
- [ ] **Step 5: Commit** — `git add src/eval/identity/importPerf.test.ts src/eval/identity/fixtures/frozen-5000.v1.json scripts/benchmark-identity-import.mjs docs/ARCHITECTURE.md && git commit -m "test: lock identity performance gates"`.

## Self-review

- Dependencies are 1 contracts, 2 plugins, 3 engine, 4 local all-hit source, 5 evaluator, 6 reader, 7 server repository, 8 signed preview, 9 aggregate ledger, 10 apply, 11 review, 12 UI, 13 safety, 14 performance.
- Tasks 7–10 each have one heading, Files, Interfaces, five steps, and one explicit-path commit. Task12 sends complete `signedPayloads`; Tasks12/14 consume Task8 chunked preview. Task6 is compatibility-only; flagged coexistence/caller cutoff is Task12.
- No legacy scanner-event import factory, correction prose, first-sheet silent caller, E2E, live call, or production persistence is present.
