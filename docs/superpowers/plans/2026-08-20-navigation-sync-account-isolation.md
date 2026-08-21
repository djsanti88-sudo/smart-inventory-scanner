# Navigation, Sync, and Account Isolation Implementation Plan

> **For Codex:** Required sub-skill: use `superpowers:subagent-driven-development` to execute this plan task by task. Every behavior change follows strict red-green-refactor TDD. Do not use production accounts, production Firebase, live decode providers, Vercel deployment, push, merge, or paid APIs.

**Goal:** Keep all 1,000 locally counted scans and their product identities stable while cloud writes are pending, eliminate the page-level bootstrap flash, preserve account and tenant isolation, and close the separate history and sanitizer defects.

**Architecture:** Reuse one pending-aware remote merge policy in both store reload paths. Keep authenticated bootstrap in a persistent client provider under the protected App Router layout, while page gates consume its fail-closed status. Accelerate only independent product writes with a bounded product-first phase; all count-law and correction writes remain serial. Prove tenancy with Firebase emulators and prove the original navigation failure with a stale 210-product cloud snapshot plus a 1,000-product pending local snapshot.

**Tech stack:** Next.js App Router, React, TypeScript, Zustand, IndexedDB persistence, Vitest, Playwright, Firebase Auth emulator, Firestore emulator.

**Spec:** `docs/superpowers/specs/2026-08-19-navigation-sync-account-isolation-design.md`

## Global constraints

- Every physical scan remains visible and contributes exactly once to session quantity, regardless of identity state.
- A real user or business change must clear tenant-visible state before rendering the new tenant.
- Session and membership validation always run on protected-app bootstrap. Zustand state and the selected-business key are never authority.
- Pending local rows are authoritative only for the active matching tenant and only while their matching durable operation remains queued.
- No count, scan-event correction, session, review, or alias write may run concurrently. Mark-wrong transfer ordering remains serial.
- Product apply concurrency is capped at four. Repeated writes to one product remain FIFO, and a failed write blocks later writes for that product for the pass.
- No production or paid lane is authorized. Emulator and mock data only.
- Use `apply_patch` for repository edits. Preserve unrelated work. Keep customer copy free of em dashes and en dashes.
- Each task must show an expected failing test before production code, then a passing focused test after the smallest implementation.

### Task 1: Make business reloads pending-aware and stop false sanitizer repairs

**Files:**

- Modify: `src/stores/scanStore.ts`
- Modify: `src/stores/firebaseBackend.store.test.ts`
- Modify: `src/stores/refreshFromCloud.store.test.ts`
- Modify: `src/stores/scanStore.persistShapeGuard.test.ts`

**Step 1: Add failing merge regressions.**

Add a same-tenant `setBusinessContext` test that starts with local product `pending-product` and local alias `pending-alias`, queues `SAVE_PRODUCT` and `RESOLVE_ALIAS`, returns a stale remote snapshot that omits both, and asserts both local rows survive while unrelated remote rows are added. Add the equivalent `refreshFromCloud` assertion. Add a real-tenant-switch assertion that the prior tenant's rows are not merged into the next tenant.

**Step 2: Prove RED.**

Run:

```powershell
npx.cmd vitest run src/stores/firebaseBackend.store.test.ts src/stores/refreshFromCloud.store.test.ts
```

The new `setBusinessContext` assertion must fail because it currently assigns the remote product and alias arrays directly.

**Step 3: Implement one merge policy.**

Extract small pure helpers beside the existing reload logic. Merge by row id, let remote rows replace non-pending local rows, retain local `SAVE_PRODUCT` and `RESOLVE_ALIAS` rows for the active business, keep local archived products from being resurrected by stale active rows, and add remote-only rows. Reuse the helpers in both `setBusinessContext` and `refreshFromCloud`. Preserve the existing pending-aware session, count, scan-feed, and local review behavior unchanged.

**Step 4: Add the valid-reference sanitizer regression and prove RED.**

In `scanStore.persistShapeGuard.test.ts`, pass valid nested-array values for `products`, `scanFeed`, `finalCounts`, and `needsReviewQueue`; assert the sanitized object retains the exact same top-level array references. Seed a valid live store, spy on `console.error`, process one scan, and assert no `wrong-shape field(s)` message occurs. Run:

```powershell
npx.cmd vitest run src/stores/scanStore.persistShapeGuard.test.ts
```

The reference assertions must fail before the fix.

**Step 5: Implement the smallest sanitizer fix.**

Keep the mapped array only when at least one nested field was repaired. Otherwise return the original array reference. Do not weaken malformed-member filtering or the outer every-scan-counts safety net.

**Step 6: Prove GREEN and commit.**

Run both focused commands above plus:

```powershell
npx.cmd vitest run src/stores/businessLoaderRace.store.test.ts
git diff --check
```

Commit only Task 1 files with message `fix: preserve pending identities on reload`.

### Task 2: Keep authenticated business bootstrap alive across page navigation

**Files:**

- Modify: `src/components/BusinessContextGate.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Create: `src/components/BusinessContextGate.provider.test.tsx`
- Modify only if required by the refactor: existing `src/components/BusinessContextGate.*.test.tsx`

**Step 1: Add a failing persistent-provider regression.**

Render a test harness with one provider and alternating page-level gates. Resolve `getSession`, membership validation, rehydration, and `setBusinessContext` once. Switch the child from Scan to History to Reconcile to Settings and back to Scan three times. Assert `getSession`, `listMemberships`, `rehydrateForUid`, and `setBusinessContext` were each invoked once and no `business-loading` UI reappears. Add separate tests proving missing membership and changed user still fail closed.

**Step 2: Prove RED.**

Run:

```powershell
npx.cmd vitest run src/components/BusinessContextGate.provider.test.tsx
```

The navigation/remount assertion must fail with the current page-owned effect.

**Step 3: Implement the provider.**

Move the existing bootstrap state and effect into an exported client `BusinessContextProvider`. Mount it once inside `AuthGuard` in `src/app/(app)/layout.tsx`. Keep `BusinessContextGate` as the page-level renderer of the provider's validated status and adoption/error actions. If a gate is mounted without the layout provider, wrap it in a compatibility provider so existing isolated tests still exercise full bootstrap. Do not add a store-based fast path and do not bypass session or membership checks. Keep catalog-review ungated by leaving its page without `BusinessContextGate`.

**Step 4: Prove GREEN and commit.**

Run:

```powershell
npx.cmd vitest run src/components/BusinessContextGate.provider.test.tsx src/components/BusinessContextGate.authmode.test.tsx src/components/BusinessContextGate.bootstrapError.test.tsx src/components/BusinessContextGate.orphan.test.tsx src/app/\(app\)/businessContextGateCoverage.test.tsx
git diff --check
```

Commit Task 2 files with message `fix: persist business bootstrap across navigation`.

### Task 3: Count every historical event and make local-save status explicit

**Files:**

- Modify: `src/services/sessions/countsFromTimeline.ts`
- Modify: `src/components/SessionCountsTable.test.tsx`
- Modify: `src/components/badges.tsx`
- Create or modify: `src/components/badges.test.tsx`

**Step 1: Add failing count and copy tests.**

Add timeline events with `unknown`, `needs_review`, and `suggested`-equivalent unresolved states, including a missing product join, and assert their latest `quantityAfterScan` values produce rows. Add badge assertions for exact pending text `Saved on this device, waiting to sync` and error text `Saved on this device, sync failed`.

**Step 2: Prove RED.**

Run:

```powershell
npx.cmd vitest run src/components/SessionCountsTable.test.tsx src/components/badges.test.tsx
```

The unresolved timeline rows and current badge labels must fail.

**Step 3: Implement the smallest fixes.**

Remove the identity-status filter from `countsFromTimeline`; keep grouping, chronological last-event selection, and product fallback unchanged. Replace only the pending and error badge labels with the exact approved strings.

**Step 4: Prove GREEN and commit.**

Run the focused command, then:

```powershell
npx.cmd vitest run src/services/sessions/history.test.ts src/services/sessions/sessionHistory.test.ts src/components/ArchivedSessionScans.test.tsx
git diff --check
```

Commit Task 3 files with message `fix: count unresolved history rows`.

### Task 4: Prioritize product sync without weakening correction ordering

**Files:**

- Modify: `src/stores/scanStore.ts`
- Create: `src/stores/productPriorityDrain.store.test.ts`
- Verify unchanged behavior in: `src/stores/markWrongDurable.store.test.ts`
- Verify unchanged behavior in: `src/stores/cloudDrainRace.store.test.ts`

**Step 1: Add failing scheduler tests with a controlled async target.**

Create a cloud-store test target that records start, finish, active count, and lets individual applies resolve or fail on demand. Prove:

1. independent `SAVE_PRODUCT` operations start before queued non-product operations and never exceed four active applies;
2. two writes for the same product start and finish FIFO;
3. failure of the first write for one product leaves the later write queued for that pass;
4. `SAVE_SCAN_EVENT`, `INCREMENT_COUNT`, `SAVE_SESSION`, `SAVE_UNKNOWN_SCAN`, and `RESOLVE_ALIAS` remain in original serial order with maximum active count one;
5. business/user context change stops new starts and committed successes reconcile exactly once.

Use a large product-only queue to prove bounded completion without a browser or arbitrary sleeps.

**Step 2: Prove RED.**

Run:

```powershell
npx.cmd vitest run src/stores/productPriorityDrain.store.test.ts
```

The concurrency and product-first assertions must fail under the current fully serial drain.

**Step 3: Implement a product-only bounded phase.**

Refactor the existing single-item apply body into a small internal helper that preserves timeout, result classification, progress accounting, token checks, and monotonic flush behavior. At the start of a pass, schedule only `SAVE_PRODUCT` groups with at most four workers; each product group processes in FIFO order and stops after its first failure. Then process every non-product item serially in original batch order. Never parallelize or reorder count-law and correction operations.

**Step 4: Prove GREEN and commit.**

Run:

```powershell
npx.cmd vitest run src/stores/productPriorityDrain.store.test.ts src/stores/cloudDrainRace.store.test.ts src/stores/drainLatchWatchdog.store.test.ts src/stores/drainProgressLivelock.store.test.ts src/stores/markWrongDurable.store.test.ts src/stores/correctProductSync.store.test.ts src/stores/resolveUnknownOrphanSync.store.test.ts src/stores/sessionRotationSyncSafety.store.test.ts
npm.cmd run test:ledger
git diff --check
```

Commit Task 4 files with message `perf: prioritize independent product sync`.

### Task 5: Prove two-account isolation with Firebase emulators

**Files:**

- Modify: `e2e/firebase-phase2/admin.ts`
- Modify: `e2e/firebase-phase2/global-setup.ts`
- Create: `e2e/firebase-phase2/two-account-isolation.spec.ts`
- Modify only when a failing test proves it necessary: account selection, sign-out, or persist-namespace source and tests

**Step 1: Extend emulator fixtures.**

Create two fixed Auth emulator users and two fixed businesses with distinct memberships, products, sessions, events, counts, and review markers. Export fixture ids and credentials without production secrets. Cleanup may target only these emulator ids.

**Step 2: Add the real same-browser flow.**

Use one Playwright browser context: sign in as A, verify A-only markers, create one scan, sign out visibly, sign in as B, assert no A marker or active persisted A tenant id is visible, create one B scan, sign out, sign back in as A, and verify A state returns without B data. Seed B's business id as stale selected business before A login and prove membership validation refuses it.

**Step 3: Prove RED, implement only evidence-backed fixes, then GREEN.**

Run the new spec alone through the emulator wrapper. If the flow passes without product code changes, keep it as proof and do not invent an account fix. If it fails, add the smallest source regression test first, fix only the proven leak, and rerun.

```powershell
npm.cmd run test:e2e:firebase -- e2e/firebase-phase2/two-account-isolation.spec.ts
npm.cmd run test:firebase
git diff --check
```

Commit Task 5 files with message `test: prove two-account tenant isolation`.

### Task 6: Reproduce the 1,000-to-210 navigation incident in a browser

**Files:**

- Create: `e2e/scan-1000-navigation-pending.spec.ts`
- Reuse helpers from: `e2e/persist-indexeddb.spec.ts`
- Modify only if required: Playwright fixture or mock/emulator test setup files

**Step 1: Build the exact stale-cloud fixture.**

In a disposable browser profile, seed the active per-user persisted state with exactly 1,000 scan events, 1,000 local products, total quantity 1,000, and pending product operations for the rows absent from a stale 210-product loader snapshot. Keep cloud drain stalled or controlled during the first navigation loops. Use stable named products at positions near 1, 210, 211, 500, and 1,000 for identity assertions.

**Step 2: Exercise the owner-required loop.**

From Scan, record visible totals and stable identity samples. Navigate History, Reconcile, Settings, Scan three complete times through visible links. After every return assert feed total 1,000, summed quantity 1,000, product total 1,000, no blank joined row, scanner focus restored, no `business-loading` flash, and pending count still nonzero. Inject one retryable product failure and repeat the assertions. Release the drain, wait for zero pending, hard reload, and assert the same baseline again.

**Step 3: Prove the test detects the old bug.**

Before relying on the green result, temporarily restore the old direct remote-array replacement in the test worktree or use a deliberately stale loader test switch; run the spec and record that it fails at 210 or on the missing identity sample. Restore the fix and rerun to green. Do not commit the deliberate regression or test switch.

**Step 4: Run focused browser proof and commit.**

```powershell
npm.cmd run test:e2e -- e2e/scan-1000-navigation-pending.spec.ts
git diff --check
```

Commit Task 6 files with message `test: cover pending navigation at 1000 scans`.

### Task 7: Record the incident and run full proof

**Files:**

- Modify: `LESSONS_LEARNED.md`

**Step 1: Add one dated lesson.**

Record the observed `1,000 -> 210 -> 966 -> 1,000` sequence, the exact direct-assignment root cause, the serial product-backlog contributor, the separate history and sanitizer defects, the confirmed per-UID and per-business isolation model, the persistent-layout provider decision, and the regression commands. State explicitly that Firebase has no 210-document read limit and that 210 was the partial snapshot available during pending writes. Mark proof as local/mock/emulator, not production deployment proof.

**Step 2: Run focused and mandatory gates.**

Run in this order and save exact exit codes/counts in the SDD report:

```powershell
npx.cmd vitest run src/stores/firebaseBackend.store.test.ts src/stores/refreshFromCloud.store.test.ts src/stores/scanStore.persistShapeGuard.test.ts src/components/BusinessContextGate.provider.test.tsx src/components/SessionCountsTable.test.tsx src/components/badges.test.tsx src/stores/productPriorityDrain.store.test.ts
npm.cmd run test:ledger
npm.cmd run test:firebase
npm.cmd run test:e2e:firebase
npm.cmd run test:e2e -- e2e/scan-1000-navigation-pending.spec.ts
npm.cmd run qa:bots
npm.cmd run proof:all
```

Run `scanbin-certify -Repo C:\Users\djsan\inventory -Mode full` only if the local command is available and its lane inventory confirms it will not invoke production, live-provider, deploy, push, or paid actions. Otherwise record the exact unavailable or owner-gated lane rather than substituting weaker proof.

**Step 3: Final integrity checks and commit.**

```powershell
git diff --check
git status --short
git log --oneline --decorate -10
```

Commit `LESSONS_LEARNED.md` and any test-only evidence adjustments with message `docs: preserve navigation incident lessons`.

## Completion conditions

- Every task has a RED and GREEN record in its report, except Task 5 where an already-correct isolation flow may be proof-only and must be reported honestly.
- All Critical and Important task-review findings are fixed or explicitly adjudicated after the skill's review cap.
- The final whole-branch review has no unresolved load-bearing finding.
- Fresh required-gate output supports every completion claim.
- The branch remains local and unpushed. No deployment or production mutation occurs.
