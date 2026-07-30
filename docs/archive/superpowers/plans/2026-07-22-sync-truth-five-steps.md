# Sync Truth - Five Steps (owner-approved 2026-07-22, redo round issue #3 build)

Owner scope law: ONLY these five steps. Anything else discovered = report to owner before executing.
Baseline: fix/redo-round (a8b0d32 + issues 1-2). Worktree C:/tmp/wt-round2. Preview-only deploys.

## Global constraints
- Strict scope per task; match surrounding style; services stay pure; no em/en dashes in copy.
- TOP-LEVEL LAW untouched: scan visibility/counting never gated by any of this.
- Customer wall: nothing customer-typed may reach catalogEntries/learned/corpus (audit-verified; keep true).
- Tests never call live providers; Firestore work uses mocks/emulator patterns already in repo.
- No commit by subagents; orchestrator commits per task.

## Task 1 (owner step 5): second edit to same product must sync
Bug: idempotency key businessId:sessionId:productId:SAVE_PRODUCT collides for repeat edits ->
FirebaseSyncTarget/_appliedKeys + MockDb.appliedKeys swallow edit #2 (drain treats alreadyApplied as ok).
Fix: distinct edits produce distinct keys (content fingerprint or monotonic edit revision in the key at
correctProduct enqueue time, scanStore.ts:5327); genuine RETRIES of the same edit keep the same key
(idempotency preserved). Also: refreshFromCloud products merge must not clobber a locally-pending
SAVE_PRODUCT edit (mirror the finalCounts pendingSyncQueue exclusion, scanStore.ts:1772-1797).
Tests: failing-first - two sequential correctProduct edits both land in MockDb; identical-item retry still
no-ops; firebase rules test extension mirroring existing SAVE_PRODUCT retry test; refresh-race guard test.
Files: src/stores/scanStore.ts, src/services/idempotency.ts (if needed), src/services/mockDb.ts (only if
needed), tests. DO NOT touch server/catalog, api/ai-lookup.

## Task 2 (owner steps 1+2): master append gets keys + actually writes + fails loud
- Creds plumbing already exists (src/lib/firebaseAdmin.ts). Orchestrator handles putting
  FIREBASE_SERVICE_ACCOUNT_* into preview env + local; code task is:
  (a) masterAppend/ai-lookup route: count+log append outcomes honestly instead of pure swallow -
      persist a counter (reuse ladderStorage()/ladder_kv pattern) with written/skipped_human/error,
      and console.error the first error per process with reason (still never breaks the decode response).
  (b) Verify/ensure the append hook actually fires for qualifying fresh computed verified decodes
      (route.ts ~:72-120 gate) - unit tests with mocked admin db proving: qualifying decode -> append
      called; MASTER_CATALOG_APPEND=0 -> not called; append rejection -> response unaffected + error
      counted. Add an admin-db-unavailable test (no creds -> "error" outcome counted, decode unaffected).
Files: src/server/catalog/masterAppend.ts, src/app/api/ai-lookup/route.ts, their tests. DO NOT touch
stores/, components/.

## Task 3 (owner step 3): owner approval page for pending catalogEntries
Platform-owner-only page listing catalogEntries with verificationStatus "pending": columns barcode, name,
brand, size/specs, confidence, evidence summary, firstSeenAt; Approve -> verificationStatus "verified",
provenanceTier "human_verified", verifiedBy set, audit log appended; Reject -> "rejected" + timesRejected+1
+ audit log. Server API routes using getAdminDb() (admin-only guard: same platform-owner auth pattern as
existing owner-gated routes); page follows existing app page/table styling. Honest empty state.
Tests: route unit tests (mocked admin db, auth-rejected case), component tests.
Files: new src/app/(app)/catalog-review/* (or similar), new src/app/api/catalog-review/*, tests.

## Task 4 (owner step 4): approved master entries become a free ladder rung
In server/decode/pipeline.ts free stages: consult approved catalogEntries (verificationStatus "verified")
by canonical GTIN BEFORE any paid rung (position: after learned-tier/L2 cache, before goupc gate - exact
slot chosen to preserve "first settled rung stops"). Read via admin db with an in-process TTL memo;
creds/entry absent -> rung silently misses (never throws, never blocks). Result carries honest provenance
(settled_by "master-catalog"). Verified only when entry is human_verified; else suggestion.
Tests: mocked admin db - hit stops ladder before paid rungs; miss falls through; no-creds falls through;
e2eMode bypasses (IS_E2E rule).
Files: src/server/decode/pipeline.ts, new src/server/catalog/masterLookup.ts, tests.

## Waves
Wave 1 parallel: Task 1 + Task 2 (disjoint files). Orchestrator: creds to preview/local env.
Wave 2 parallel: Task 3 + Task 4 (disjoint files; both read-only vs wave-1 files except route.ts is frozen
after T2 - T4 touches pipeline.ts only, T3 new files only).
Per-task reviewer after each; final whole-branch review; gates (vitest, tsc, ledger, e2e) per wave;
commit per task; preview after wave 2 (or per owner ask).
