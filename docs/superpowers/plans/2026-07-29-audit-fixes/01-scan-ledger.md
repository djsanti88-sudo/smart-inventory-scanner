# Agent 1 — Scan Ledger Correctness

> Read `00-orchestration.md` and `docs/superpowers/plans/2026-07-29-audit-remediation.md` (Tasks 1 & 3)
> first. Implement the master-plan steps verbatim. This wrapper adds isolation + execution sequencing only.

**Sub-branch:** `audit-fixes/01-scan-ledger` (worktree off `audit-fixes`).

**Scope:** master-plan **Task 1 (F-02)** — repeated context-conflict scans must count every physical
scan (TOP-LAW); **Task 3 (F-03)** — durable balanced transfer for `markWrong` + orphan merges.

**Files you OWN (touched by no other agent):**
- `src/stores/scanStore.ts` (the ~6,500-line monolith — grep for symbols, never browse)
- `src/stores/*.store.test.ts` (`sideDoorFirewall.store.test.ts`, `countAlways.store.test.ts`, new
  `markWrongDurable.store.test.ts`)
- The ONE new F-03 emulator test you CREATE: `src/services/db/firebase/markWrongTransfer.rules.test.ts`
  (auto-run by `npm run test:firebase` which does `vitest run src/services/db/firebase`; mirror the existing
  `firebaseSyncTarget.rules.test.ts` skeleton). This is the ONLY file you touch in that folder.
- READ-ONLY reference (do not edit): `src/services/db/firebase/firebaseSyncTarget.ts` +
  `firebaseSyncTarget.rules.test.ts` (as the emulator-test pattern), `src/services/inventory.ts`,
  `src/services/inventory.replay.ts`

**Internal order: SEQUENTIAL.** Both tasks edit `scanStore.ts`; apply F-02 fully (test green + committed)
BEFORE starting F-03, to keep the monolith edits serialized and each `test:ledger` run attributable.

**Executor sequence:**
- Author + run the F-02 failing test and trace the conflict branch / `ensureProvisionalCount` early-return.
- Apply and prove F-02 before authoring the F-03 durable-transfer failing test and studying the
  `deleteProduct` precedent.
- Apply the `scanStore.ts` edits SEQUENTIALLY (F-02 then F-03) and run the gates after each.

**Proof gates (run after EACH task):** `npm run test:ledger`, `npx vitest run src/stores`,
`npx tsc --noEmit`. For F-03 the real gate is an **emulator-backed transfer-and-reload** test (master-plan
Task 3 Step 5): apply the markWrong transfer, DRAIN the pendingSyncQueue to the Firestore emulator, RELOAD
business data fresh (second-device simulation), and assert the cloud count is on the CORRECTED identity with
no `idempotency_conflict` rejection — run via `npm run test:firebase`. A store test alone does NOT prove cloud
durability. Confirm `countAlways` and `sideDoorFirewall` suites still pass.

**Integration notes:** (1) Merge Agent 1 FIRST — if F-03 adds a shared transfer-op type to `src/types.ts`,
keep it purely additive so the other agents' additive edits merge cleanly. (2) The client circuit-breaker
emit for F-10 lives in `scanStore.ts` (your file) but is wired by the INTEGRATOR post-merge as a one-line call
into Agent 7's `src/lib/telemetry.ts` — you do NOT implement F-10, just be aware the integrator will add that
call to this file after you merge.

**Definition of done:** N physical conflict scans = count N with N distinct-keyed durable events; a synced
`markWrong` correction DRAINS to the emulator and survives a fresh reload / second-device load with the count
on the corrected identity; ledger + firebase suites green. Merge `audit-fixes/01-scan-ledger` into `audit-fixes`.
