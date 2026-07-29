# Audit Remediation Implementation Plan (2026-07-29 GPT-5.6 full-system audit)

> **For the executor (ChatGPT / Codex):** You have ZERO context for this codebase and this
> conversation. Read this whole header, then execute task-by-task. For every task: (1) locate the
> code by SYMBOL via grep first (line numbers below are hints from 2026-07-29 and drift — the symbol
> is authoritative), (2) READ the current code around it before editing, (3) write the failing test
> FIRST, (4) implement the smallest change, (5) run the exact proof command, (6) checkpoint.
> `src/stores/scanStore.ts` is a ~6,500-line monolith: grep for symbols, never browse it top-to-bottom.
>
> **Revision 2 (2026-07-29):** hardened after an external review (ChatGPT). Changes vs rev 1:
> F-16 is metadata-ONLY (never rebuild the payload); F-12 owns its client callers + reconcile E2E specs
> and prefix-floor is rate-limited-not-authenticated; F-10 is redesigned to be feasible (client error
> boundary cannot import the server logger); F-04 locks a 403 contract; F-05 uses a real streaming
> SHA-256, not a SQL aggregate; F-09 is verification-only (already implemented); branch standardized to
> `audit-fixes`; explicit-path staging only; a full integration gate and finding-closure status added.
>
> **Revision 3 (2026-07-29):** hardened after a second external review + a 4-agent code investigation.
> Changes vs rev 2: task labels are **TARGET: CODE-CLOSED** (planned, NOT achieved — only the integrator
> marks closed after the gates pass); F-16 metadata keeps SEPARATE payload vs base-source lineage fields
> (never conflates the current CSV hash with the enriched payload count, never restamps `generated_at`);
> F-12 auth uses the hardened `isAuthBypassEnabled()` pattern from `import-mapping` (NOT account-export's
> strict refusal, which would break the real-route reconcile E2E specs) + a production bypass-denial test;
> F-10 telemetry sink has a strict event ALLOWLIST + drops unverifiable client fields + caps the body
> before parsing; F-05 handles first-promotion (the 3 newer tables absent) with an ABSENT sentinel and
> tests both first + subsequent promotion; F-03 gets an exact emulator test path.
>
> **Revision 4 (2026-07-29):** final execution-safety review. The corpus metadata refresh now updates all
> three payload-derived index counts and tests through temporary fixtures while proving the payload bytes
> are unchanged. Turso fingerprints use an injective typed/length-prefixed encoding, not delimiter-only
> concatenation. The E2E lane may not edit product files outside its ownership without an explicit
> integrator reassignment. Telemetry uses real UTF-8 byte limits, a non-throwing client helper, and the
> Next.js 16 `global-error.tsx` contract (`<html>` + `<body>`). Nested agent fan-out is removed; the
> integrator runs at most three lower-tier specialists concurrently and reserves high-tier reasoning for
> triggered adversarial review.

**Goal:** Land the verified, non-owner-gated fixes from the 2026-07-29 audit (a counting-law bug,
two same-tenant authorization gaps, a red release gate, a Turso-promotion correctness bug, and a set
of hardening/doc items), and prepare — but never execute — the owner-gated production deploys.

**Architecture:** Next.js 16 App Router + React 19 + TypeScript; Zustand 5 optimistic scan store;
Firestore (Admin SDK server-side, security rules as the tenant policy) + Turso/libsql corpus;
Vitest (`unit` node + `dom` jsdom projects) + Playwright E2E. Fixes are surgical and isolated;
no architecture change.

**Tech Stack:** TypeScript, Zustand, Firebase Admin/Firestore rules, `@libsql/client`, Vitest,
Playwright, GitHub Actions.

## Global Constraints (every task inherits these — copied verbatim from project law)

- **TOP-LEVEL LAW — Every Scan Appears and Counts:** EVERY scanned code (known, unknown, misread,
  random, undecodable, trust-gate-rejected) MUST immediately appear on the scan feed AND be counted
  in session totals. Scan 10 = count 10, no exceptions. Gates/decodes/firewalls decide the IDENTITY
  attached to a row (verified / suggested / unidentified) — they NEVER decide whether a row appears
  or counts. Any change that makes a scanned code vanish from the feed or the totals, OR that fails
  to count a physical scan, is a defect.
- **Wrong identity is worse than unknown.** Deterministic `known` requires an approved alias
  (`alias.approved === true`) or a verified product (`product.verified === true`). AI/provider output
  is suggestion/enrichment only. Prefer Needs Review over a wrong guess.
- **`markWrong` is a quantity TRANSFER**, never a delete/zero: it repoints ScanEvents onto a fresh
  provisional. Never destroy counted physical quantity.
- **Idempotency:** every ScanEvent gets a stable `id` + `idempotencyKey` ONCE at scan time, reused
  verbatim on every retry, never regenerated inside retry. Sync is upsert-by-id; a durable transfer
  uses FRESH transfer keys, not the original counting key.
- **Services stay pure:** no React / `next/*` imports anywhere under `src/services`.
- **No em dash or en dash in user-facing copy.** Normal punctuation only.
- **TEST SAFETY — never call live providers.** Unit tests mock engines/fetch; E2E mocks
  `/api/ai-lookup` via `page.route`; the Playwright webServer sets `IS_E2E=1`. NEVER run a live/paid
  provider, live decode, `qa:bots:live`, benchmark, harvest, or intel script.
- **HARD GATES — require explicit owner approval IN THE MOMENT, do NOT do them:** `git push`;
  merge to `master`; any deploy (`vercel deploy`, `firebase deploy`, `deploy:rules:prod`); production
  DB/credential writes; enabling paid infra (PITR/billing); deleting real data. Tasks that need these
  are marked **[OWNER-GATED]** — you prepare and verify locally, the owner runs the gated command.
- **Branch + commit policy:** ALL work happens under the integration branch **`audit-fixes`** (already
  created off `master`); each agent on its own worktree sub-branch `audit-fixes/0N-<name>` per the
  orchestration index. Commit locally per task for checkpointing. **Stage EXPLICIT paths only — NEVER
  `git add -A` or `git add .`** (the working tree carries unrelated untracked files: the audit prompt,
  `pr_diff.txt`, catalog scripts, generated artifacts — a blanket add would sweep them into the PR).
  NEVER push, merge to `master`, or deploy.
- **Delegation + concurrency:** the seven named executor lanes are the complete specialist set; executor
  agents do NOT spawn nested sub-agents. The integrator occupies one slot and runs at most three specialists
  concurrently in successive waves. Use the repository's lower-tier/default executor model for routine,
  bounded work; reserve high-tier reasoning for the integrator and triggered adversarial review only.
- **Finding closure status — agents NEVER self-declare "closed."** Each task header states its TARGET:
  **TARGET: CODE-CLOSED** (the goal once the fix lands and its own tests pass) or **CODE-PREPARED /
  OWNER-GATED** (code + proof ready, but the finding is NOT closable until the owner runs a gated action —
  deploy, enable PITR, live promote). An agent reports its task as "target met, tests green on my
  sub-branch" — it does NOT mark the finding CODE-CLOSED. **Only the integrator (Opus) marks a finding
  actually CODE-CLOSED, and only after the whole-effort integration gate passes on `audit-fixes`.** F-01,
  F-07, F-08 can never become CODE-CLOSED via this PR — they stay OPEN until the owner deploys/enables.
- **Proof commands (verified project scripts):** `npm run test` (all vitest once), `npx vitest run
  <file> -t "name"` (one test), `npm run test:ledger` (counting/ledger invariants — run for ANY
  counting/replay/markWrong change), `npm run test:firebase` (Firestore emulator rules + repository),
  `npm run test:e2e` (mock Playwright, port 3100; first run once: `npx playwright install chromium`),
  `npm run proof:full` (tsc + unit tests + production build), `npm run qa:bots` (mock human-bot browser
  proof, port 3300), `npx tsc --noEmit` (typecheck), `npm run lint`. Default `npm run lint` scans broad
  artifacts; if it fails outside your touched files, ALSO run focused `npx eslint <changed paths>` and
  report unrelated failures separately.
- **Do not fabricate proof.** Label mocked vs live vs manual. If a step is blocked, say so.

## Execution order (by priority)

- **Phase 1 (P0 — urgent):** Task 1 (F-02 counting law), Task 2 (F-01 + F-07 deploy hardened rules +
  indexes — OWNER-GATED, you verify + prepare).
- **Phase 2 (P1):** Task 3 (F-03 markWrong durable transfer), Task 4 (F-04 export role gate),
  Task 5 (F-06 restore green Mock E2E gate).
- **Phase 3 (P2):** Task 6 (F-05 Turso promote coverage + fingerprint), Task 7 (F-12 route auth/quotas
  + client callers), Task 8 (F-08 Firestore PITR/delete-protection — OWNER-GATED), Task 9 (F-10
  observability, minimal in-repo $0).
- **Phase 4 (P3-P4 — hardening/docs):** Task 10 (F-11 permissions/hooks), Task 11 (F-13 pin Actions),
  Task 12 (F-15 deploy doc), Task 13 (F-16 corpus provenance — metadata only), Task 14 (F-17 rollback
  runbook), Task 15 (F-14 jwks-rsa patch hardening), Task 16 (F-09 spend-accounting — VERIFICATION-ONLY).

Each task ends with an independently testable deliverable. Stop and report if any task's assumption
is contradicted by the current code.

## Acceptance criteria

| Finding(s) | Done means | Required proof |
|---|---|---|
| F-02 | N repeated context-conflict scans produce count N and N fresh durable events against the safe provisional identity. | Focused RED/GREEN store test, `npm run test:ledger`, store suite. |
| F-03 | `markWrong` and orphan transfers use fresh balanced keys and survive emulator drain plus a fresh reload on the corrected identity. | Focused store test, exact emulator test, `npm run test:ledger`, `npm run test:firebase`. |
| F-04 | Viewer/counter export requests receive 403 before any tenant collection read; owner/admin behavior remains intact. | Route tests, typecheck, focused lint, mock browser role/export proof. |
| F-05/F-17 | All five swapped tables participate in backup/count/digest checks, first-promotion absence is explicit, canonical hashing is injective, and the operator freeze/recovery runbook is complete. | Local libSQL node tests for first + subsequent promotion; doc review. No live promotion. |
| F-06/F-15 | Mock E2E is stable-green twice and deploy documentation names the live five-check policy without inventing Vercel dashboard state. | `npm run test:e2e` twice; doc diff. |
| F-10 | Allowlisted client failures become sanitized server logs through a bounded, rate-limited sink; the global boundary satisfies Next.js 16 and telemetry failures never recurse. | Route/logger/component tests, typecheck, mock browser proof where applicable. |
| F-11/F-13/F-14 | Tool authority is narrowed, hooks have a proven no-write mode, Actions are immutable-SHA pinned, and the dependency patch fails loudly on drift. | Hook tests in both modes, workflow validation, clean-install patch proof, typecheck. |
| F-12 | Reconcile requires live membership auth, production bypass is denied, both corpus routes are bounded, and response keys are explicitly minimized. | Route/caller tests, production-bypass denial test, three reconcile E2E specs, full mock E2E. |
| F-16 | Metadata matches all three shipped payload indexes while base-source lineage remains separate and payload bytes do not change. | Temp-fixture guard with before/after SHA-256, corpus-drift, golden suite. |
| F-09 | Existing divergence signals remain tested without duplicate implementation. | Existing two focused tests; integrator closes only after the full gate. |
| F-01/F-07/F-08 | Local rules/indexes/recovery material is prepared and emulator-proven. Findings remain OPEN pending owner-approved production actions. | `npm run test:firebase`, exact owner command sheet, recovery runbook; no live mutation. |

## Risks and failure modes

- Counting work can lose or double-count physical scans if a transfer reuses an original idempotency key.
- Parallel work can silently overwrite another lane if an E2E diagnosis escapes its declared ownership.
- Turso check-to-swap races can lose concurrent writes even with a strong digest; the operator write-freeze
  remains mandatory for any later owner-approved live promotion.
- Corpus tooling can destroy later enrichment if the payload generator runs or if a guard test targets the
  real manifest instead of temporary fixtures.
- Public telemetry can be abused to forge logs or amplify errors unless event names, fields, size, rate, and
  client failure behavior are all constrained.
- Auth bypass flags can become a production vulnerability unless the production-denial test exercises the
  real `isAuthBypassEnabled` guard.
- Owner-gated Firebase/Vercel/Turso state can drift after local proof; no local passing test closes live drift.

## Out of scope

- No push, PR creation, merge to `master`, preview/production deploy, live Turso promotion, Firestore rules or
  index deployment, PITR/delete-protection enablement, credential change, paid provider call, or real-data write.
- No broad architecture rewrite, scan-store decomposition, external observability vendor, real paging system,
  or corpus payload rebuild.
- No claim that authenticated Vercel dashboard settings, live Turso backup posture, or owner-gated production
  state is fixed by this code-only effort.

## Files to touch

The exact disjoint ownership map is authoritative in
`docs/superpowers/plans/2026-07-29-audit-fixes/00-orchestration.md`. In summary: Agent 1 owns scan-store and
the one named Firebase emulator test; Agent 2 owns export/reconcile/prefix routes plus callers/tests; Agent 3
owns Turso promotion tooling/runbook; Agent 4 owns tire metadata/updater/guard; Agent 5 owns Firestore
rules/index/recovery docs; Agent 6 owns non-reconcile E2E, workflows, and deploy truth; Agent 7 owns local
tooling, patching, logger, the NEW `docs/OBSERVABILITY.md`, NEW telemetry route/helper, and NEW global error
boundary. Any new file not named in that map requires an integrator-recorded ownership update before editing.

---

### Task 1: F-02 — repeated context-conflict scans must count each physical scan (P0, TOP-LAW) — TARGET: CODE-CLOSED

**Files:**
- Modify: `src/stores/scanStore.ts` — the context-conflict branch (grep `if (isKnown && knownConflict`
  and `knownConflict === "category_context_conflict"`; ~:2223 and ~:2309-2406 on 2026-07-29) and the
  `provMatchId` re-scan bridge (grep `provMatchId`; ~:2208-2222).
- Test: `src/stores/sideDoorFirewall.store.test.ts` (grep the existing single-scan test ~:45-91) and/or
  a new co-located test.

**Root cause (verified in source 2026-07-29 — restate so you fix the RIGHT thing):**
A normal unknown code scanned N times counts N via the `provMatchId` re-scan bridge (proven by
`countAlways.store.test.ts:49-56`). But that bridge is disabled for conflicts: `if (!countable &&
!knownConflict)` (grep `provMatchId`) excludes the `knownConflict` case. The conflict branch instead
calls `get().ensureProvisionalCount(cleanCode, conflictText)`. `ensureProvisionalCount` is per-CODE
idempotent — it early-returns `if (existing) return existing.id;` (grep `IDEMPOTENT: if this code is
already counted`) when the code already has a counted product. Net effect on scan #2 of the same
context-conflicted code: a conflict feed row IS appended (grep `set((s) => ({ scanFeed: [event, ...`
inside the conflict branch — `quantityDelta: 0`), so the row appears (visibility half of the law is
OK), but `finalCounts` is NOT incremented and no `SAVE_SCAN_EVENT`/`INCREMENT_COUNT` is enqueued for
the 2nd physical scan. Session total stays 1 while 2 physical items were scanned. **The counting half
of the TOP LAW is violated.**

**Fix intent:** each physical context-conflict scan must produce a DISTINCT counting event against the
SAFE provisional placeholder (never the poisoned matched product), incrementing the count and enqueuing
its ledger writes — matching the parity the `provMatchId` bridge already gives non-conflict provisionals.
Do NOT count against `resolution.productId` (the poisoned identity). Do NOT weaken the per-code guard in
`ensureProvisionalCount` for OTHER callers (it legitimately prevents double-counting a single code across
paths). Prefer minting a fresh per-scan counting event in/for the conflict branch (fresh `scanEventId` +
fresh `idempotencyKey`, reused verbatim on retry) rather than relaxing `ensureProvisionalCount`'s global
idempotency.

- [ ] **Step 1: Write the failing test.** In a store test (jsdom `dom` project), drive the store so a
  code resolves to a `category_context_conflict` (mirror the setup in `sideDoorFirewall.store.test.ts`),
  then `processScan` the SAME code TWICE. Assert BOTH halves of the law:

```ts
// after two scans of the same context-conflicted code:
const total = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
expect(total).toBe(2);                                   // counting half — currently FAILS (gets 1)
expect(store.getState().scanFeed.length).toBe(2);        // visibility half — already passes
// durability: two distinct counting events must be queued for sync (no reused counting key)
const incrs = store.getState().pendingSyncQueue.filter(q => q.operation === "INCREMENT_COUNT");
expect(incrs.length).toBe(2);
expect(new Set(incrs.map(q => q.idempotencyKey)).size).toBe(2); // distinct keys, not reused
```

- [ ] **Step 2: Run it, verify it FAILS** on the count/queue assertions.
  Run: `npx vitest run src/stores/sideDoorFirewall.store.test.ts -t "counts each physical conflict scan"`
  Expected: FAIL (total is 1 / one INCREMENT_COUNT).

- [ ] **Step 3: Implement the minimal fix** in the conflict branch so repeat physical scans each mint a
  distinct provisional counting event (fresh id + idempotency key) applied to the safe placeholder,
  increment `finalCounts`, and enqueue `SAVE_SCAN_EVENT` + `INCREMENT_COUNT`. Keep the review-open and
  `provisionalProductId` stamping behavior. Read the existing countable branch (grep `effectiveCountable
  && effectiveProductId`) as the canonical enqueue shape to mirror.

- [ ] **Step 4: Run the test — PASS.** Same command as Step 2.

- [ ] **Step 5: Run the full counting-invariant + store suites — no regressions.**
  Run: `npm run test:ledger` then `npx vitest run src/stores` then `npx tsc --noEmit`
  Expected: all PASS. Confirm `countAlways.store.test.ts` and `sideDoorFirewall.store.test.ts` still pass.

- [ ] **Step 6: Commit** (explicit paths). `git add src/stores/scanStore.ts src/stores/sideDoorFirewall.store.test.ts && git commit -m "fix(scan): count every repeated context-conflict scan (F-02, TOP-LAW)"`

**Acceptance:** N physical scans of a context-conflicted code = count N and N durable counting events,
each against the safe provisional, review stays open, poisoned identity never counted. Ledger suite green.

---

### Task 2: F-01 + F-07 — prove the hardened Firestore rules + indexes and prepare the deploy **[OWNER-GATED — CODE-PREPARED, not closed]**

**Files:** `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc`.

**Context (verified 2026-07-29):** TRACKED `firestore.rules` (20,666 bytes) already contains the
hardening — admin cannot self-promote to owner (grep `resource.data.role != 'owner'` in the membership
`match` block, ~:355-362) and counter/count envelopes exist (~:33-314). The audit's live read found
PRODUCTION running an OLDER ruleset (7,433 bytes) and only 1 of 3 declared composite indexes deployed
(missing: `catalogEntries(verificationStatus, provenanceTier, updatedAt)` and
`scanEvents(sessionId, createdAt)`). Firestore rules/indexes deploy SEPARATELY from the Vercel app ship,
which is why the app can be current while rules lag. You CANNOT deploy to production — prepare + prove,
owner runs the deploy. **CLOSURE: this finding stays OPEN until the owner deploys; your deliverable is
CODE-PREPARED only.**

- [ ] **Step 1: Confirm the tracked source is correct.** Read `firestore.rules` and confirm the
  owner-protection + counter-envelope blocks exist (grep the anchors above). Read `firestore.indexes.json`
  and confirm all THREE composite indexes are declared.

- [ ] **Step 2: Prove the tracked rules under the emulator (no production).**
  Run: `npm run test:firebase`
  Expected: PASS. If any rule test fails, fix the rules/tests FIRST (that is in-scope, local).

- [ ] **Step 3: Re-confirm the live drift is still current (read-only).** If you have `firebase` CLI +
  auth: read live rules via the Firebase MCP `firebase_get_security_rules` and hash-compare to
  `firestore.rules`; list live indexes via `firestore_list_indexes`. If you lack access, mark this
  INDETERMINATE and ask the owner to confirm.

- [ ] **Step 4: [OWNER-GATED] Prepare the exact deploy commands for the owner (do NOT run):**

```bash
# Owner runs these against project smart-inventory-scanner-app (alias prod):
firebase deploy --only firestore:rules --project prod
firebase deploy --only firestore:indexes --project prod
# Then re-verify: hash live rules == firestore.rules; all 3 indexes report READY.
```

- [ ] **Step 5: Commit** any local rule/test fixes only (explicit paths).
  `git add firestore.rules firestore.indexes.json && git commit -m "chore(firestore): prove tracked rules+indexes under emulator; prep prod deploy (F-01,F-07)"`

**Acceptance:** emulator rule suite green; deploy commands prepared; finding marked CODE-PREPARED/OWNER-GATED
(NOT closed). Nothing deployed by you.

---

### Task 3: F-03 — make `markWrong` and orphan merges durable ledger transfers (P1) — TARGET: CODE-CLOSED

**Files:**
- Modify: `src/stores/scanStore.ts` — `markWrong` (grep `markWrong`; ~:6009-6215), `transferOrphanCount`
  (grep `transferOrphanCount`; ~:939-964 def, call sites ~:3585/:4589/:5187). Precedent to MIRROR:
  `deleteProduct` (grep `deleteProduct`; ~:6735-6770) which already documents this exact class as a
  "reviewed defect 2026-07-22" and fixes it with a synced balanced zero-out/re-add using FRESH per-transfer
  keys.
- Reference (do not edit unless needed): `src/services/db/firebase/firebaseSyncTarget.ts` (grep
  `idempotency_conflict`; ~:124-138).
- Test: new `src/stores/markWrongDurable.store.test.ts` (unit) AND a new emulator test at the EXACT path
  `src/services/db/firebase/markWrongTransfer.rules.test.ts` (Agent 1 OWNS this one new file; it is picked
  up automatically by `npm run test:firebase`, which runs `vitest run src/services/db/firebase`, and does NOT
  collide with Agent 5's `firestore.rules`/`firestore.indexes.json` ownership). A store test alone does NOT
  prove cloud durability.

**Root cause (verified):** `markWrong` repoints local state but REUSES the original scan event's
idempotency keys. `firebaseSyncTarget.ts` detects the changed target (`sessionId_productId` differs) and
returns `idempotency_conflict` with `retryable:false` — the corrected cloud write is REJECTED, not applied.
The old `InventoryCount` removal has no corresponding sync op, and `transferOrphanCount` call sites mutate
`finalCounts` locally with zero `pendingSyncQueue` entries. So a correction looks right locally but reload
/ second device restores the wrong cloud count.

**Fix intent:** one durable, idempotent transfer primitive with FRESH transfer keys that (a) enqueues a
balanced pair of count writes (decrement old identity to its transferred amount, increment new identity),
(b) repoints the ScanEvents with fresh-keyed `SAVE_SCAN_EVENT` writes, and (c) is applied by both
`markWrong` and every `transferOrphanCount` caller. Model it on the `deleteProduct` fix already in the file.

- [ ] **Step 1: Write the failing unit test.** Simulate a synced scan (count on product A), then `markWrong`
  to a fresh provisional B. Assert the pendingSyncQueue contains a BALANCED transfer with FRESH keys (not
  the original counting key), and that a replay reconstructs count on B, not A:

```ts
const q = store.getState().pendingSyncQueue;
const counts = q.filter(i => i.operation === "INCREMENT_COUNT" || i.operation === "SET_COUNT" || i.operation === "TRANSFER_COUNT");
expect(counts.length).toBeGreaterThanOrEqual(2);                 // balanced old- and new-identity writes
expect(counts.every(i => i.idempotencyKey !== originalCountingKey)).toBe(true); // fresh transfer keys
// a re-pointed SAVE_SCAN_EVENT with a fresh key must also be queued (the event moved to B):
expect(q.some(i => i.operation === "SAVE_SCAN_EVENT" && i.idempotencyKey !== originalSaveKey)).toBe(true);
// replay from feed events reconstructs the corrected identity:
const replayed = replayLedgerCounts(store.getState().scanFeed);  // use the project replay util
expect(replayed.find(c => c.productId === productBId)?.quantity).toBe(1);
expect(replayed.find(c => c.productId === productAId)?.quantity ?? 0).toBe(0);
```

- [ ] **Step 2: Run it, verify it FAILS.**
  Run: `npx vitest run src/stores/markWrongDurable.store.test.ts`
  Expected: FAIL (reused key / no balanced transfer / A still counted).

- [ ] **Step 3: Implement the durable transfer primitive** and route `markWrong` + `transferOrphanCount`
  callers through it, mirroring `deleteProduct`'s synced balanced pattern with fresh keys.

- [ ] **Step 4: Run the unit test — PASS.** Same command.

- [ ] **Step 5: Write and run the EMULATOR-backed persistence proof (this is the finding's real gate).**
  Create `src/services/db/firebase/markWrongTransfer.rules.test.ts`, MIRRORING the existing
  `src/services/db/firebase/firebaseSyncTarget.rules.test.ts` skeleton: `ready = (process.env.FIRESTORE_EMULATOR_HOST || "").includes(":")`,
  `describe.skipIf(!ready)`, `initializeTestEnvironment({ projectId, firestore: { rules: readFileSync("firestore.rules","utf8"), host, port } })`,
  `beforeEach` `env.clearFirestore()` + `env.withSecurityRulesDisabled(...)` to seed a business + businessMembers +
  a synced count on product A. Then: build the `markWrong` transfer's `PendingSyncItem`s, `apply()` them via a
  `FirebaseSyncTarget` on `env.authenticatedContext(UID).firestore()`, then READ BACK via `getDoc` (fresh
  read = second-device/reload simulation) and assert the cloud count lands on B (not A) with NO
  `idempotency_conflict` rejection. (This file auto-runs under `npm run test:firebase`; it self-skips under
  plain `npm run test` when `FIRESTORE_EMULATOR_HOST` is unset.)
  Run: `npm run test:firebase`
  Expected: PASS — the corrected write is ACCEPTED and survives a cloud reload.

- [ ] **Step 6: Prove no counting regression.** Run: `npm run test:ledger` then `npx tsc --noEmit`. PASS.

- [ ] **Step 7: Commit** (explicit paths). `git add src/stores/scanStore.ts src/stores/markWrongDurable.store.test.ts src/services/db/firebase/markWrongTransfer.rules.test.ts && git commit -m "fix(ledger): durable balanced transfer for markWrong + orphan merges, emulator-proven (F-03)"`

**Acceptance:** a synced correction DRAINS to the emulator and survives a fresh cloud reload / second-device
load with the count on the corrected identity; no `idempotency_conflict` rejection; physical quantity never
lost. Unit + ledger + firebase suites green.

---

### Task 4: F-04 — gate account export by role (P1) — TARGET: CODE-CLOSED

**Files:**
- Modify: `src/app/api/account/export/route.ts` (grep `TENANT_SUBCOLLECTIONS` ~:54-64; membership check
  ~:175-183; `exportCollection` ~:203-225).
- Reference: `firestore.rules` (grep `match /auditLog` — restricts read to `['owner','admin']`, ~:457-462).
- Test: `src/app/api/account/export/route.test.ts` (create if absent).

**Root cause (verified):** the route checks only that the caller is a MEMBER of the tenant
(`if (!member.exists) return 403`) and never reads `member.data().role`. It then exports every
`TENANT_SUBCOLLECTIONS` entry — including `auditLog` — via the Admin SDK, which BYPASSES Firestore rules.
A `viewer`/`counter` can export audit logs and other role-restricted data.

**LOCKED CONTRACT (2026-07-29 — no ambiguity):** account export is an owner/admin-only operation.
`viewer` and `counter` roles receive **HTTP 403** for the whole export (not a silent field-omission).
`owner`/`admin` receive the full export unchanged. Same-tenant membership is still required first.

- [ ] **Step 1: Write failing tests — assert the EXACT 403 contract:**

```ts
// viewer and counter: exactly 403, no body leak
expect((await POST(viewerReq)).status).toBe(403);
expect((await POST(counterReq)).status).toBe(403);
// owner/admin: full export including auditLog
const ownerRes = await POST(ownerReq);
expect(ownerRes.status).toBe(200);
expect((await ownerRes.json()).collections.auditLog).toBeDefined();
```

- [ ] **Step 2: Run, verify FAIL.** Run: `npx vitest run src/app/api/account/export/route.test.ts`
  Expected: FAIL (viewer/counter currently get 200 + auditLog).

- [ ] **Step 3: Implement the role gate:** after the membership check, read `member.data().role`; if it is
  not `owner` or `admin`, return `403` before any collection is read. Leave the owner/admin path unchanged.

- [ ] **Step 4: Run — PASS.** Same command.

- [ ] **Step 5: Typecheck + focused lint.** `npx tsc --noEmit` and `npx eslint src/app/api/account/export/route.ts`

- [ ] **Step 6: Commit** (explicit paths). `git add src/app/api/account/export/route.ts src/app/api/account/export/route.test.ts && git commit -m "fix(auth): account export is owner/admin only; 403 for viewer/counter (F-04)"`

**Acceptance:** viewer/counter get exactly 403; owner/admin export unchanged (incl. auditLog); tests pass.

---

### Task 5: F-06 — restore a green required Mock E2E gate (P1) — TARGET: CODE-CLOSED

**Files:** Playwright specs under `e2e/` and `playwright.config.ts`, subject to the ownership rules below.
NOTE ownership: the reconcile-related E2E specs (`e2e/reconcile.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts`,
`e2e/phase4-universal-import.spec.ts`) are owned by Task 7 (Agent 2) because F-12 changes their API contract.
If your F-06 failure is in one of THOSE specs, coordinate: fix it as part of Task 7, not here.
If diagnosis points to product code outside Agent 6's owned files, STOP before editing it. Report the exact
symbol/file to the integrator, who must either assign the fix to the agent that already owns that file or
record an explicit ownership transfer in `00-orchestration.md` before work resumes. The disjoint-file
guarantee is not waived merely because an E2E test exposed the bug.

**Context (verified live):** on the production-deployed SHA `35bebdb...`, four core CI checks passed but
the required `Mock E2E (chromium)` check completed with FAILURE. Root cause unknown until you run it.

- [ ] **Step 1: Reproduce locally.** First run once: `npx playwright install chromium`. Then:
  `npm run test:e2e` (mock backend, port 3100, `IS_E2E=1`, AI route mock-only). Read the failure + spec.

- [ ] **Step 2: Diagnose root cause.** Determine whether it is a real regression, a flaky/timing test, or
  a fixture/port issue. Follow `superpowers:systematic-debugging` (find root cause; do NOT weaken/delete the
  test to force green). Report the diagnosis before fixing.

- [ ] **Step 3: Fix the root cause** (product code if it is a real regression; test/fixture if the test is
  wrong). Never fake proof.

- [ ] **Step 4: Prove green.** Run: `npm run test:e2e` twice (confirm not flaky). Expected: PASS, stable.

- [ ] **Step 5: Commit** (explicit paths — list the exact specs/code you touched).
  `git add <changed e2e/… and/or src/… paths> && git commit -m "fix(e2e): restore green Mock E2E gate on master (F-06)"`

**Acceptance:** `npm run test:e2e` passes locally and stably; diagnosis documented. (Re-running the GitHub
required check happens on the next reviewed commit — do not mutate historical checks.)

---

### Task 6: F-05 — Turso promotion: cover all five swapped tables + a real content fingerprint (P2) — TARGET: CODE-CLOSED (live re-promote OWNER-GATED)

**Files:**
- Modify: `scripts/tire-db-repair/10_promote_execute.mjs` (grep `LIVE_TABLES` ~:56, `NEW_TABLES` ~:57-61,
  `readLiveCounts` ~:446-453, `readLiveContentFingerprint` ~:502-514, `buildRowHashExpr` ~:486-493,
  `FINGERPRINT_COLUMNS` ~:464-474, `cmdBackup` ~:624-738, `assertLiveUnchangedSinceManifest` ~:568-606).
- Test: `scripts/tire-db-repair/10_promote_execute.test.mjs`.

**Root cause (verified — audit UNDERSTATED it):** the swap replaces FIVE tables (`tires`,
`tire_part_numbers`, `tire_product_part_number_aliases`, `canonical_tire_products`, `provenance`) but
backup + count-drift + content-fingerprint iterate only `LIVE_TABLES = ["tires","tire_part_numbers"]`,
so the three others get NO backup and NO drift detection. And `buildRowHashExpr` uses SQLite `unicode(concat)`,
which returns the code point of only the FIRST character of the concatenation; the primary key is first in
`FINGERPRINT_COLUMNS`, so it never changes when a mutable field is edited — combined with the other
aggregate being pure `SUM(length(...))`, ANY equal-length edit to a mutable field is invisible.

**FEASIBILITY NOTE (external review, 2026-07-29):** SQLite/Turso has NO built-in collision-resistant row
hash (no `sha256`/`md5`), so "any equal-length edit is detected" CANNOT rest on another ad-hoc SQL aggregate.
Use the feasible design below.

**Fix design (LOCKED): PK-ordered streaming SHA-256 computed in JS, reusing the backup's existing row pass.**
`cmdBackup` already streams every row of the covered tables via keyset pagination (grep the keyset loop in
`cmdBackup`). For EACH of the five swapped tables: read rows PK-ordered in pages, and for each row update a
running `crypto.createHash("sha256")` with an INJECTIVE canonical serialization of the row (all fingerprinted
columns in a FIXED order; encode each value with an explicit type tag plus UTF-8 byte length before its bytes,
and encode NULL with its own type tag). Do NOT use delimiter-only concatenation or a magic NULL string because
real text can contain the delimiter/sentinel and collide. Do NOT materialize all rows in memory —
`hash.update()` per row, then `hash.digest("hex")` per table. Store one digest per table in the manifest.
`assertLiveUnchangedSinceManifest` compares these per-table digests across all five tables. (Alternative if
the streaming pass is too slow for `retail`-sized tables — it is NOT, these five are small: a
database-revision / write-freeze protocol; but the streaming SHA-256 is the chosen implementation.)

**First-promotion handling (LOCKED — external review + code investigation, 2026-07-29):** on a FIRST
promotion the three newer tables (`tire_product_part_number_aliases`, `canonical_tire_products`, `provenance`)
do NOT exist as live tables yet — they are created by the staging->live rename during `promote` (see the
`existingNames.has(live)` branch at ~:1288-1305). So `SELECT COUNT(*)` / the row scan would THROW
`no such table`. Every extended per-table read (`readLiveCounts`, `readLiveContentFingerprint`, `cmdBackup`)
MUST first check existence via the code's EXISTING pattern (`SELECT name FROM sqlite_master WHERE type='table'`
-> a `Set` -> `.has(live)`, the same check `promote`/`rollback` already use) and, when absent, record a
DISTINCT sentinel `"ABSENT"` — never reuse the existing empty-table sentinel `"EMPTY:0"`, nor `null`/`0`.
Drift comparison then works as plain equality: a first-promotion cycle reads ABSENT-to-ABSENT (no drift) at
every gate until the swap itself creates the tables (which happens after all drift checks have run).

- [ ] **Step 1: Write failing tests** against a local `file:` libsql DB (the harness already uses
  `PROMOTE_TURSO_URL`). Cover BOTH promotion scenarios:
  - **Subsequent promotion (all 5 tables present):** reuse a fixture that seeds all five live tables (add a
    `seedFakeLiveDbWithAllFiveTables()` helper — either run one real `promote` first, or `CREATE TABLE` the 3
    new tables like `tires`/`tire_part_numbers` are seeded at test lines ~146-173). Assert: (a) a same-length
    mutable-field UPDATE CHANGES that table's SHA-256 digest; (b) an UPDATE to one of the 3 newly-covered
    tables after backup is DETECTED (drift refuses promote), mirroring the existing drift tests (~:798-870).
  - **First promotion (the 3 newer tables ABSENT):** reuse the existing `seedFakeLiveDb()` (it seeds ONLY
    `tires` + `tire_part_numbers`). Assert backup/count/fingerprint report the `"ABSENT"` sentinel for the 3
    missing tables and do NOT throw `no such table`; backup/stage/verify all succeed.

```js
// Subsequent: same-length edit must change the streaming SHA-256 digest for that table:
const fp1 = await readLiveContentFingerprint(client);           // returns { table: sha256hex | "ABSENT" }
await client.execute("UPDATE tires SET brand = 'XXXXXXXXX' WHERE barcode = ?", [bc]); // same length
assert.notStrictEqual((await readLiveContentFingerprint(client)).tires, fp1.tires);
// All five swapped tables are keys in the map (present -> hex, absent -> "ABSENT"):
for (const t of ["tires","tire_part_numbers","tire_product_part_number_aliases","canonical_tire_products","provenance"])
  assert.ok(Object.prototype.hasOwnProperty.call(fp1, t));
// First promotion: absent tables read the distinct ABSENT sentinel, never a throw or a false EMPTY:0:
const fpFirst = await readLiveContentFingerprint(firstPromoteClient); // seedFakeLiveDb(): 3 new tables absent
assert.strictEqual(fpFirst.provenance, "ABSENT");
assert.notStrictEqual(fpFirst.provenance, "EMPTY:0");
```

- [ ] **Step 2: Run, verify FAIL.** Run: `node --test scripts/tire-db-repair/10_promote_execute.test.mjs`
  Expected: FAIL (fingerprint blind to same-length edit; omitted tables absent).

- [ ] **Step 3: Implement** the streaming SHA-256 fingerprint over all five swapped tables (per the design
  above), extend `readLiveCounts` + `cmdBackup` + `assertLiveUnchangedSinceManifest` to all five, and add
  per-table `FINGERPRINT_COLUMNS` for the three newly-covered tables. Remove the `unicode()`/`length()`
  aggregate approach. GATE every per-table read behind the `sqlite_master` existence check and return the
  `"ABSENT"` sentinel when a table is missing (first-promotion safe — no `no such table` throw). Extend
  `readLiveCounts` to record `null`/`"ABSENT"` for a missing table rather than crashing on `COUNT(*)`.
  Bind the manifest to the exact verification result it represents, and require the documented operator
  write-freeze from Task 14 for any owner-approved live promotion; a digest comparison alone does not close
  the final check-to-swap write-race.

- [ ] **Step 4: Run — PASS** (full file). `node --test scripts/tire-db-repair/10_promote_execute.test.mjs`

- [ ] **Step 5: Commit** (explicit paths). `git add scripts/tire-db-repair/10_promote_execute.mjs scripts/tire-db-repair/10_promote_execute.test.mjs && git commit -m "fix(turso-promote): all 5 tables + streaming SHA-256 content fingerprint (F-05)"`

**Acceptance:** backup/count/fingerprint cover all five swapped tables; any equal-length mutable edit changes
the SHA-256 digest and is detected; BOTH first-promotion (3 tables ABSENT, no throw, distinct sentinel) and
subsequent-promotion (all 5 present, drift caught) are tested; existing promote gates still pass; NO live
promote run (OWNER-GATED).

---

### Task 7: F-12 — authenticate + rate-limit the corpus-enumeration routes AND update their callers (P2) — TARGET: CODE-CLOSED

**Files (this task OWNS all of these — no other agent touches them):**
- Routes: `src/app/api/reconcile/match/route.ts` (grep `MAX_ROWS` ~:37), `src/app/api/prefix-floor/route.ts`.
- Client callers of reconcile/match (they must send auth after the contract change):
  `src/components/ReconcilePanel.tsx`, `src/stores/reconcileStore.ts`,
  `src/components/UniversalImportPanelContainer.tsx`, and their tests
  (`src/components/ReconcilePanel.test.tsx`, `src/components/UniversalImportPanelContainer.test.tsx`).
- Reconcile E2E specs (carved from Agent 6 because F-12 changes their contract):
  `e2e/reconcile.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts`, `e2e/phase4-universal-import.spec.ts`.
- Reference the rate-limit helper other routes use (grep `checkRateLimit` — `ai-lookup`, `account/export`,
  `catalog-review`, `catalog-dispute` use it) and the server auth verifier (grep how `account/export`
  verifies its idToken/membership; reuse that exact pattern).

**Root cause (verified):** `reconcile/match` has NO auth, NO rate limit, NO byte cap; accepts up to 20,000
rows and returns corpus-derived barcode↔part-number linkages — a bulk extraction primitive. `prefix-floor`
is an ungated per-code brand oracle. No `middleware.ts` exists. Client callers confirmed:
`ReconcilePanel.tsx`, `reconcileStore.ts`, `UniversalImportPanelContainer.tsx` + the three E2E specs above.

**LOCKED CONTRACT (2026-07-29, rev 3 — mirror `import-mapping`, NOT `account/export`):**
- `reconcile/match` = **authenticated + rate-limited via the hardened bypass pattern.** Add an
  `authorize(businessId, idToken)` that MIRRORS the `authorize` function in
  `src/app/api/import-mapping/route.ts` EXACTLY:
  `if (isAuthBypassEnabled() || !isLiveAuth()) return null;` (from `@/services/auth/authBypass` +
  `@/services/auth/authMode`), else `getAdminAuth().verifyIdToken(idToken)` -> uid, then a
  `businessMembers/${memberDocId(businessId, uid)}` existence check (401 no token, 403 non-member, 503 on
  admin config error). Do NOT copy `account/export`'s unconditional refusal — the reconcile E2E specs
  (`reconcile.spec.ts`, `phase4-universal-import.spec.ts`) hit the REAL route with NO token, and the bypass is
  what keeps them green. `isAuthBypassEnabled()` short-circuits to `false` FIRST when `NODE_ENV==='production'`,
  so bypass is impossible in prod. Also add a LOWER batch cap, a request-byte limit, `checkRateLimit`, and
  minimized returned fields. Because the CONTRACT changes, the client callers must attach idToken+businessId.
- `prefix-floor` = **rate-limited ONLY, NOT authenticated** (single-code lookup; the underlying
  `catalogEntries` collection is already `allow read: if true` by design). Add rate limit + byte/quota caps;
  do NOT add auth. (This resolves the rev-1 contradiction.)

- [ ] **Step 1: Write failing route tests.**

```ts
// reconcile/match under LIVE auth (mock isLiveAuth()->true, bypass off): no token -> 401
expect((await POST(unauthReqLiveAuth)).status).toBe(401);
expect((await POST(oversizedBodyReq)).status).toBe(413);        // byte/row cap
expect((await POST(authedSmallReq)).status).toBe(200);          // valid token + membership within cap
// exceed rate limit -> 429 on the Nth authed call
// PRODUCTION bypass-denial (the security proof — idiom: vi.stubEnv, cf. ProdFirebaseBanner.test.tsx):
vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("IS_E2E", "1"); vi.stubEnv("NEXT_PUBLIC_E2E_AUTH_BYPASS", "1");
// mock isLiveAuth()->true; even with both bypass flags set, prod must NOT bypass:
expect((await POST(noTokenReq)).status).toBe(401);
expect(verifyIdToken).not.toHaveBeenCalledWith(/* a forged/absent token that would have been let through */);
// In E2E/bypass mode (NODE_ENV=test, IS_E2E=1) the route processes without a token (keeps reconcile specs green).
// prefix-floor: no auth, rate-limited (429 after N), byte-capped:
expect((await GET(prefixFloorReq)).status).toBe(200);
```

- [ ] **Step 2: Run, verify FAIL.** `npx vitest run src/app/api/reconcile/match/route.test.ts src/app/api/prefix-floor/route.test.ts`

- [ ] **Step 3: Implement the routes.** reconcile/match: add `authorize()` mirroring `import-mapping/route.ts:44-76`
  (`isAuthBypassEnabled() || !isLiveAuth()` short-circuit, then `verifyIdToken` + `businessMembers` membership),
  lower `MAX_ROWS`, a request-byte guard, `checkRateLimit`, minimized response. Reject an oversized declared
  `Content-Length` before reading, then use `new TextEncoder().encode(raw).byteLength` on `request.text()`
  before `JSON.parse` so the limit is UTF-8 bytes, not JavaScript character count. Choose and document a
  bounded row limit no higher than 5,000; if a verified customer fixture needs more, add server-owned
  pagination instead of restoring the 20,000-row bulk primitive. Build an explicit response DTO containing
  only fields consumed by the three reviewed callers, and add a test that recursively rejects any response
  key outside that allowlist. prefix-floor: `checkRateLimit` + the same declared/actual byte-cap pattern,
  no auth.

- [ ] **Step 4: Update the client callers.** Make `ReconcilePanel.tsx` / `reconcileStore.ts` /
  `UniversalImportPanelContainer.tsx` attach the auth token + businessId to their reconcile/match request
  (mirror how other authed client calls do it). Update their unit tests to expect the authed request shape.
  Run: `npx vitest run src/components/ReconcilePanel.test.tsx src/components/UniversalImportPanelContainer.test.tsx src/stores` — PASS.

- [ ] **Step 5: RUN the reconcile E2E specs to confirm they stay green** (the bypass keeps them passing WITHOUT
  token changes — the E2E harness runs with `IS_E2E=1` + `NEXT_PUBLIC_E2E_AUTH_BYPASS=1`, which `authorize()`
  honors). Run: `npm run test:e2e` (which includes `e2e/reconcile.spec.ts`, `e2e/phase4-fuzzy-reconcile.spec.ts`,
  `e2e/phase4-universal-import.spec.ts`). Expected: PASS with NO spec edit. Only if a spec fails, make the
  MINIMAL fix (and note it). This keeps the full Mock E2E gate (Task 5) green after the contract change.

- [ ] **Step 6: Typecheck + focused lint.** `npx tsc --noEmit` and `npx eslint` over the changed paths.

- [ ] **Step 7: Commit** (explicit paths — list every route, caller, test, and spec you touched).
  `git add src/app/api/reconcile/match/route.ts src/app/api/prefix-floor/route.ts src/components/ReconcilePanel.tsx src/stores/reconcileStore.ts src/components/UniversalImportPanelContainer.tsx <the tests> e2e/reconcile.spec.ts e2e/phase4-fuzzy-reconcile.spec.ts e2e/phase4-universal-import.spec.ts && git commit -m "fix(api): authenticate+rate-limit reconcile/match (+callers+e2e); rate-limit prefix-floor (F-12)"`

**Acceptance:** reconcile/match requires auth + is rate/byte-capped; prefix-floor is rate-limited (no auth);
all client callers send auth; their unit tests + the three reconcile E2E specs pass; the full Mock E2E gate
stays green.

---

### Task 8: F-08 — enable Firestore PITR and delete protection **[OWNER-GATED — CODE-PREPARED, not closed]**

**Files:** documentation only for you — a NEW `docs/RECOVERY.md` (do NOT edit `docs/DEPLOY_TRUTH.md`; that
is Task 12 / Agent 6).

**Context (verified live):** production database reports `POINT_IN_TIME_RECOVERY_DISABLED`,
`DELETE_PROTECTION_DISABLED`, `versionRetentionPeriod: 3600s`. Enabling PITR/delete protection is an owner
action with possible billing impact — you cannot do it. **CLOSURE: stays OPEN until the owner enables it.**

- [ ] **Step 1: Document** in `docs/RECOVERY.md` the current state and exact enable steps (Firebase console →
  Firestore → database settings → enable PITR + delete protection; or gcloud/firebase CLI equivalents), plus
  a restore-drill procedure to run after enabling.
- [ ] **Step 2: [OWNER-GATED]** owner enables PITR + delete protection and proves a restore drill.
- [ ] **Step 3: Commit** (explicit path). `git add docs/RECOVERY.md && git commit -m "docs(recovery): PITR/delete-protection enable steps + restore drill (F-08)"`

**Acceptance:** clear owner runbook; finding marked CODE-PREPARED/OWNER-GATED; nothing enabled by you.

---

### Task 9: F-10 — production observability, minimal in-repo, $0 (P2) — TARGET: CODE-CLOSED

**Files:**
- Modify: `src/server/log.ts` (server logger — grep `logServerEvent`) and the SERVER-side cap/charge/counter
  failure sites that should emit structured events.
- Create: `src/app/api/telemetry/route.ts` (a NEW, sanitized, rate-limited telemetry sink — this task OWNS
  this new file; it does not collide with Agent 2's existing routes).
- Create: `src/app/global-error.tsx` (a Next global error boundary — a CLIENT component).
- Create: `src/lib/telemetry.ts` (a tiny CLIENT-safe helper that POSTs to `/api/telemetry`).
- NOTE — the client circuit-breaker POST call site lives in `scanStore.ts` (Agent 1's file) and the
  daily-cap-exhausted emit lives in Agent 2's area: those emit CALLS are **integrator-wired** post-merge (see
  `00-orchestration.md`). You build the sink + helper + boundary + `log.ts` events for server-only sites you
  own; you do NOT edit `scanStore.ts`, `aiSpendGuard*`, or `ai-lookup`.
- Test: `src/server/log.test.ts` (create), `src/app/api/telemetry/route.test.ts` (create), a component test
  for the error boundary.

**Context (verified):** observability is logs-only; `src/server/log.ts` even documents that a client-side
circuit-breaker OPEN transition is SERVER-INVISIBLE. No app-root error boundary currently exists.
**Locked scope: minimal, in-repo, ZERO cost — NO external vendor, NO new paid
dependency (no Sentry/OTel vendor).**

**FEASIBILITY NOTE (external review, 2026-07-29):** a Next error boundary (`error.tsx`/`global-error.tsx`)
is a CLIENT component and CANNOT import the server-only `log.ts`. So client-origin signals (the circuit
breaker, unhandled client errors) reach the server via a small telemetry API route the client POSTs to;
the route (server-side) calls `logServerEvent`. "Alerting" at $0 = structured, queryable logs (documented
fields + an example Vercel log query); real paging is explicitly OUT of the $0 scope and noted as a follow-up.
Note F-09 already emits `spend_write_diverged` (aiSpendGuard) and `charge_pair_incomplete` (ai-lookup route);
this task ADDS the missing server events and makes client-side signals server-visible — it does not duplicate F-09.

**SECURITY (external review, 2026-07-29): a public telemetry sink must not let attackers forge operational
logs.** `logServerEvent`'s real shape is `{ route, event, reasonCode?, businessId?, status?, detail? }` (NO
`severity`/`kind`/`source` fields — do not invent them). The route MUST: (1) ALLOWLIST `event` to exactly
`breaker_open` and `client_error` (reject any other -> 400); (2) FORCE `route: "/api/telemetry"` server-side —
never accept a client-supplied `route` (a forged one would impersonate another server route's logs); (3) DROP
`businessId` entirely (unverifiable — this route has no auth); (4) DERIVE `status`/`reasonCode` server-side
per event, never from the client; (5) accept only a short `detail` string, `.slice(0,200)` + sanitized; (6)
  reject an oversized declared `Content-Length`, then CAP the actual UTF-8 byte length of
  `await request.text()` BEFORE `JSON.parse` (413); (7) rate-limit via `checkRateLimit`.

- [ ] **Step 1: Write failing tests.**
  (a) Agent 7: cover `logServerEvent` sanitization plus any server-only failure site inside Agent 7's owned
      files. The daily-cap and client-breaker emit tests belong to the integrator's post-merge wiring step,
      because their production call sites are owned by Agents 2 and 1 respectively.
  (b) telemetry route: a POST with a sanitized breaker event calls `logServerEvent`; malformed/oversized
      bodies are rejected; the route is rate-limited.
  (c) error boundary: on error it POSTs a sanitized payload to `/api/telemetry` (component test).

```ts
// real logServerEvent fields only (route/event/reasonCode/businessId/status/detail) — no kind/severity/source:
// (a) server-visible cap event:
expect(loggedEvents).toContainEqual(expect.objectContaining({ event: "daily_cap_exhausted" }));
// (b) telemetry sink logs an ALLOWLISTED client event with a SERVER-forced route:
await POST(tele({ event: "breaker_open" }));
expect(loggedEvents).toContainEqual(expect.objectContaining({ route: "/api/telemetry", event: "breaker_open" }));
// non-allowlisted event -> 400, never logged:
expect((await POST(tele({ event: "admin_login_ok" }))).status).toBe(400);
// client-supplied route/businessId are DROPPED / forced, not trusted:
await POST(tele({ event: "client_error", route: "/api/account/export", businessId: "victim" }));
const logged = loggedEvents.find(e => e.event === "client_error");
expect(logged.route).toBe("/api/telemetry");    // forced, not the forged client value
expect(logged.businessId).toBeUndefined();       // dropped (no auth -> unverifiable)
// oversized body rejected BEFORE parse:
expect((await POST(oversizedTelemetryReq)).status).toBe(413);
```

- [ ] **Step 2: Run, verify FAIL.** `npx vitest run src/server/log.test.ts src/app/api/telemetry/route.test.ts`

- [ ] **Step 3: Implement.** (i) emit structured server events at the server-side cap/counter failure sites via
  `logServerEvent`; (ii) `src/app/api/telemetry/route.ts` — the SECURITY-HARDENED sink per the note above:
  reject a declared `Content-Length` over the limit, then
  `const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > MAX_TELEMETRY_BODY_BYTES) return json(413);` THEN
  `JSON.parse`; allowlist `event` to `{breaker_open, client_error}` (else 400); force `route:"/api/telemetry"`;
  drop `businessId`; derive `status`/`reasonCode` server-side; `detail = String(detail).slice(0,200)` sanitized;
  `checkRateLimit(ipFromRequest(request), { limit: intEnv(process.env.TELEMETRY_RATE_LIMIT, <n>), storage: await ladderStorage() })`
  with the fail-open try/catch (mirror `catalog-dispute/route.ts:73-89`); then `logServerEvent(...)`;
  (iii) `src/lib/telemetry.ts` — a client-safe, best-effort `postTelemetry(event, detail?)` fetch helper that
  catches network/rejection failures and never throws or creates an error-reporting loop (the breaker/cap
  call sites that invoke it are integrator-wired since they live in other agents' files);
  (iv) `src/app/global-error.tsx` (CLIENT) calls `postTelemetry("client_error", ...)` — NO server-logger import.
  Per the installed Next.js 16 contract it renders its own `<html>` and `<body>` tags and exposes a safe retry
  action;
  (v) `docs/OBSERVABILITY.md`: the event fields + an example Vercel log query an owner alert watches (log-based;
  real paging is out of $0 scope, noted as a follow-up).

- [ ] **Step 4: Run — PASS.** Same command. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit** (explicit paths).
  `git add src/server/log.ts src/server/log.test.ts src/app/api/telemetry/route.ts src/app/api/telemetry/route.test.ts src/lib/telemetry.ts src/app/global-error.tsx <global-error test> docs/OBSERVABILITY.md && git commit -m "feat(observability): server-visible cap/counter events + client telemetry sink + error boundary, $0 (F-10)"`

**Acceptance:** server-side cap/counter failures emit structured events; the telemetry sink accepts ONLY the
allowlisted events (`breaker_open`, `client_error`), forces the route, drops `businessId`, caps the body BEFORE
parsing (413), and is rate-limited; the global error boundary + (integrator-wired) client breaker report
through it via `src/lib/telemetry.ts`; event-field + log-query doc written; no external vendor or paid dependency.

---

### Task 10: F-11 — narrow tool preauthorization and give Stop hooks a no-write mode (P3) — TARGET: CODE-CLOSED

**Files:** `.claude/settings.local.json` (permissions + Stop hooks), `scripts/hooks/fable5-stop.ps1`,
`scripts/hooks/deep-review-radar.mjs`.

**Context (verified):** `.claude/settings.local.json` pre-allows `Bash(node:*)`, `Bash(npx vercel:*)`, and
mutation-capable git commands; two write-capable Stop hooks run unconditionally. The highest-risk action
(prod deploy) IS separately hook-gated by `.claude/hookify.vercel-prod-gate.local.md`, so this is defense-in-
depth, not an open hole.

- [ ] **Step 1:** Narrow the broad preauthorizations (scope `node`/`vercel` allowances to what is actually
  needed; keep git-mutation allowances only as the owner wants). Add an env-driven no-write/dry-run mode the
  Stop hooks honor (skip writing reports/`.claude/.deep-review-radar.json` when set).
- [ ] **Step 2:** Verify the hooks still function normally without the flag and write nothing with it.
- [ ] **Step 3: Commit** (explicit paths). `git add .claude/settings.local.json scripts/hooks/fable5-stop.ps1 scripts/hooks/deep-review-radar.mjs && git commit -m "chore(tooling): narrow preauth + no-write Stop-hook mode (F-11)"`

**Acceptance:** narrower permissions; hooks honor a no-write mode; prod-deploy gate untouched.

---

### Task 11: F-13 — pin GitHub Actions to immutable SHAs (P3) — TARGET: CODE-CLOSED

**Files:** `.github/workflows/ci.yml`, `.github/workflows/playwright.yml`.

**Context (verified):** all `uses:` pin mutable major tags (`actions/checkout@v4`, `setup-node@v4`,
`cache@v4`, `upload-artifact@v4`); live Actions policy allows all actions, no SHA pinning required.

- [ ] **Step 1:** Replace each `@v4` with the immutable commit SHA for that release (add a trailing
  `# v4.x.x` comment). Dependency-update automation is out of scope for this lane.
- [ ] **Step 2:** Confirm workflow YAML is valid (do not push). CI verification is deferred to the owner's
  next push.
- [ ] **Step 3: Commit** (explicit paths). `git add .github/workflows/ci.yml .github/workflows/playwright.yml && git commit -m "chore(ci): pin actions to immutable SHAs (F-13)"`

**Acceptance:** all actions SHA-pinned with version comments; YAML valid.

---

### Task 12: F-15 — reconcile deploy documentation with live policy (P3) — TARGET: CODE-CLOSED

**Files:** `docs/DEPLOY_TRUTH.md` (grep the four-check list ~:32-54).

**Context (verified):** the doc lists FOUR required checks and says Playwright/Mock E2E is not required;
live branch protection actually requires FIVE (including `Mock E2E (chromium)`).

- [ ] **Step 1:** Update the required-check list to five (add `Mock E2E (chromium)`), and reconcile the
  "Vercel production dashboard connection pending" claim against the current Production deployment record
  (mark the trigger claim as needing authenticated Vercel confirmation if unverifiable).
- [ ] **Step 2: Commit** (explicit path). `git add docs/DEPLOY_TRUTH.md && git commit -m "docs(deploy): required checks = 5 incl Mock E2E; reconcile trigger note (F-15)"`

**Acceptance:** doc matches live branch-protection reality.

---

### Task 13: F-16 — regenerate corpus provenance METADATA ONLY, never rebuild the payload (P4) — TARGET: CODE-CLOSED

**Files:** `src/server/tire-knowledge/tireKnowledge.generated.meta.json` (grep `source_file_hash`,
`barcode_index_count`), a NEW metadata-only updater `scripts/refresh-tire-meta.mjs`, its NEW exact guard
test `scripts/refresh-tire-meta.test.mjs`, and
`src/server/tire-knowledge/corpusDrift.test.ts` (grep the `driftFloor` / enrichment comment — read only).

**Context (verified):** meta records 76,173 barcode keys, 22,383 part-number keys, and 70,223 identity keys,
while the shipped payload contains 78,437, 27,364, and 72,321 respectively. `corpusDrift.test.ts`
INTENTIONALLY allows the payload to exceed the manifest (enrichment ahead of manifest is healthy).

**DANGER (external review, 2026-07-29):** the FULL generator (`npm run build:tire-knowledge`) rebuilds the
generated PAYLOAD from an older source snapshot and would DISCARD later enrichment (shrinking the corpus).
**Do NOT run the payload generator. Do NOT hand-edit generated JSON payload.** Update ONLY the metadata to
describe the payload that already ships. Precedent for a metadata-only fix exists at
`scripts/tmp-fix-source-count.mjs` (read it as a pattern).

**Lineage rule (external review + code investigation, 2026-07-29 — do NOT conflate provenance facts):**
the CURRENT on-disk source CSV (`data/tire-knowledge/tire_corpus_flat.csv`, hashes to `bab179f1...`) is a
THIRD snapshot that was NEVER run through the generator — hashing it today would misrepresent lineage. So:
KEEP the existing recorded base-source values (`source_file_hash` = `4390ed58...`, `source_row_count` = 76208)
untouched (they correctly describe what the generator actually consumed). Do NOT restamp the top-level
`generated_at` to "now"; repoint it to the payload's own internal `generated_at`. The ONLY gated consumer is
`barcode_index_count` (read by `corpusDrift.test.ts:36,51` as a `>=` floor and `tireKnowledge.test.ts:43`) —
KEEP that field name and UPDATE its value to the true payload count (78,437), which safely tightens the floor.

- [ ] **Step 1: Write a metadata-only updater** `scripts/refresh-tire-meta.mjs` (pattern: read/transform/verify/write,
  like `scripts/tmp-fix-source-count.mjs`, but it touches ONLY the meta file). It READS the existing payload
  `tireKnowledge.generated.json` (for `payload_sha256` over its bytes, `payload_barcode_count`, and the payload's
  own internal `generated_at`) and the EXISTING `tireKnowledge.generated.meta.json` (to copy the base-source
  fields forward — never recompute them from the on-disk CSV). The updater MUST accept explicit payload/meta
  paths (or export a path-parameterized function) so tests operate only on temporary fixture copies; its CLI
  defaults may point at the real files for the one deliberate refresh step. It writes ONLY the selected meta
  file, preserving all existing field names and ADDING these six lineage fields:

```jsonc
"payload_sha256": "<sha256 of the current tireKnowledge.generated.json bytes>",
"payload_barcode_count": 78437,                     // true current payload key count
"base_source_sha256": "4390ed58...",               // COPIED from existing meta.source_file_hash (never recomputed)
"base_source_row_count": 76208,                     // COPIED from existing meta.source_row_count
"payload_generated_at": "<payload JSON's own internal generated_at>",
"metadata_refreshed_at": "<new Date().toISOString() — the ONLY 'now' field>"
```
  Also update all three payload-derived legacy counts: `barcode_index_count` = 78,437,
  `part_number_index_count` = 27,364, and `identity_index_count` = 72,321. Repoint the
  existing top-level `generated_at` to the payload's internal `generated_at`. Leave `source_file_hash` /
  `source_row_count` unchanged. Do NOT read or rewrite the payload JSON/DB.

- [ ] **Step 2: Write `scripts/refresh-tire-meta.test.mjs`** using temporary copies of payload + meta. Assert the updater changes ONLY
  the temporary meta file, the payload SHA-256 bytes are UNCHANGED (not merely the key count), all three
  legacy counts match their payload indexes, and base-source fields are preserved:

```ts
const beforeHash = sha256(readPayloadBytes(tempPayload));
runMetaUpdater({ payloadPath: tempPayload, metaPath: tempMeta });
expect(sha256(readPayloadBytes(tempPayload))).toBe(beforeHash); // exact payload bytes untouched
const meta = readMeta(tempMeta);
expect(meta.payload_sha256).toBe(beforeHash);
expect(meta.payload_barcode_count).toBe(78437);
expect(meta.barcode_index_count).toBe(78437);
expect(meta.part_number_index_count).toBe(27364);
expect(meta.identity_index_count).toBe(72321);
expect(meta.base_source_sha256).toBe("4390ed58...");           // base lineage PRESERVED, not the on-disk CSV hash
expect(meta.metadata_refreshed_at).not.toBe(meta.payload_generated_at); // distinct timestamps, no conflation
```

- [ ] **Step 3: Run `node --test scripts/refresh-tire-meta.test.mjs`. After the temporary-fixture guard test
  passes, run the updater ONCE against the real meta path, inspect the diff to confirm only the meta file
  changed, then prove no regression.** Run:
  `npm run test:corpus-drift` (or `npx vitest run src/server/tire-knowledge/corpusDrift.test.ts`) and
  `npm run test:golden`. Expected: PASS.

- [ ] **Step 4: Commit** (explicit paths). `git add src/server/tire-knowledge/tireKnowledge.generated.meta.json scripts/refresh-tire-meta.mjs <guard test> && git commit -m "chore(corpus): metadata-only provenance refresh; payload never rebuilt (F-16)"`

**Acceptance:** meta.json describes all three indexes in the actual shipped payload; the payload SHA-256 is
byte-for-byte UNCHANGED (no enrichment lost); tests never mutate production-path fixtures; drift + golden
suites green.

---

### Task 14: F-17 — Turso rollback runbook + operator write-freeze note (P3) — TARGET: CODE-CLOSED

**Files:** `scripts/tire-db-repair/10_promote_execute.mjs` (rollback path, grep `cmdRollback` ~:1372-1467),
and a NEW runbook doc under `scripts/tire-db-repair/` (do NOT edit `docs/DEPLOY_TRUTH.md`). NOTE: this file
is also edited by Task 6 (F-05); both are the SAME agent (Agent 3) and run SEQUENTIALLY — land F-05 first.

**Context (verified):** rollback renames current tables to `*_failed_promotion_<ts>` and restores
`*_old_<ts>`; there is no delta capture/replay. For a single supervised promotion this is correct, but writes
that landed between promote and rollback from ANOTHER script survive only in the renamed failed tables until a
manual merge.

- [ ] **Step 1:** Add a runbook that instructs operators to PAUSE all other Turso-writing scripts
  (`pilot-apply-turso.mjs`, scheduled harvest jobs) during the promote→rollback window, and documents how to
  recover rows from a `*_failed_promotion_<ts>` table if a rollback happened after concurrent writes.
- [ ] **Step 2 (optional):** add a lightweight delta-capture/reconcile note or helper if the owner wants
  automatic protection; otherwise the runbook warning suffices.
- [ ] **Step 3: Commit** (explicit paths). `git add scripts/tire-db-repair/10_promote_execute.mjs <runbook doc path> && git commit -m "docs(turso-rollback): operator write-freeze runbook + recovery note (F-17)"`

**Acceptance:** operators have a clear write-freeze + recovery procedure for the rollback window.

---

### Task 15: F-14 — harden the jwks-rsa postinstall patch (P4) — TARGET: CODE-CLOSED

**Files:** `scripts/patch-jwks-rsa.cjs`, `package.json` (postinstall).

**Context (verified):** the patch is justified (jwks-rsa top-level `require('jose')` breaks on Vercel with
ESM-only jose v6), narrow, and idempotent. The only concern is silent drift if upstream layout changes.

- [ ] **Step 1:** Add input/output hash verification (or a version-bound guard) so the patch FAILS LOUDLY if
  `jwks-rsa`'s target files differ from the expected content/version, instead of silently no-op'ing. Prefer,
  if feasible, a maintained upstream version / patch-package with a committed patch file.
- [ ] **Step 2: Prove** a clean `npm ci` still applies the patch (or the maintained alternative) and the app
  typechecks: `npx tsc --noEmit`.
- [ ] **Step 3: Commit** (explicit paths). `git add scripts/patch-jwks-rsa.cjs package.json && git commit -m "chore(deps): hash-verify jwks-rsa patch to fail loudly on drift (F-14)"`

**Acceptance:** patch verifies its input/output (or is replaced by a maintained mechanism); loud failure on
drift.

---

### Task 16: F-09 — spend-accounting divergence is already implemented: VERIFY ONLY (P4) — TARGET: CODE-CLOSED (verification)

**Files (READ-ONLY unless a gap is found):** `src/services/security/aiSpendGuard.ts` (grep
`spend_write_diverged` ~:339), `src/services/security/aiSpendGuard.gptLadder.test.ts` (grep
`spend_write_diverged`), `src/app/api/ai-lookup/route.ts` (grep `charge_pair_incomplete` ~:439),
`src/app/api/ai-lookup/route.legacyChargePair.test.ts`.

**Context (verified 2026-07-29 — external review was RIGHT):** the divergence signal ALREADY exists and is
tested. `aiSpendGuard.recordGptLadderSpend` retries the atomic write once and, on double failure, emits a
structured `spend_write_diverged` event (tested at `aiSpendGuard.gptLadder.test.ts` ~:323-327). The legacy
authed path emits `charge_pair_incomplete` and still serves (tested at `route.legacyChargePair.test.ts`
~:126-132). The locked decision (alert only, keep serving) is ALREADY the behavior. **So this is
VERIFICATION-ONLY — do NOT add a redundant alert path (that would overlap F-10 / Agent 7).**

- [ ] **Step 1: Verify** by running the existing tests: `npx vitest run src/services/security/aiSpendGuard.gptLadder.test.ts src/app/api/ai-lookup/route.legacyChargePair.test.ts`. Expected: PASS, and both
  assert the divergence event fires.
- [ ] **Step 2:** If (and ONLY if) you find a spend-write failure site that does NOT emit a structured
  divergence event, add the missing single-line `logServerEvent`/`console.error` event + a test — mirror the
  existing pattern exactly. Otherwise make NO code change.
- [ ] **Step 3: Report** "F-09 target met by verification" (already implemented), noting the two event names
  and their tests. The executor does not mark it closed; the integrator may mark it CODE-CLOSED only after the
  integration gate. Surfacing these logs as real owner ALERTS is folded into F-10's observability doc
  (log-based), not a separate edit here.
- [ ] **Step 4: Commit** ONLY if Step 2 changed a file (explicit paths); otherwise no commit.

**Acceptance:** the two divergence signals are confirmed present + tested; no redundant edit; F-09 closed by
verification.

---

## Integration gate (the integrator — Opus — runs this on `audit-fixes` AFTER all sub-branches merge)

Per project law the human-bot proof gate is REQUIRED for scanner/inventory/role/export/resolution changes —
unit tests alone are NOT sufficient. Run, in order, and require GREEN:

1. `npm run proof:full` — tsc + unit tests + production build (catches build-only breakage the unit run misses).
2. `npm run test:ledger` — counting invariants (Tasks 1, 3).
3. `npm run test:firebase` — Firestore emulator rules + repository + the F-03 transfer-and-reload proof (Tasks 2, 3, 4).
4. `node --test scripts/tire-db-repair/10_promote_execute.test.mjs` — both first/subsequent promotion safety cases.
5. `node --test scripts/refresh-tire-meta.test.mjs`, then `npm run test:corpus-drift` and `npm run test:golden`.
6. `npm run test:e2e` TWICE — stable, not flaky, port 3100 (Tasks 5, 7).
7. `npx eslint <all changed paths>` — focused lint; report any unrelated repo-wide lint failures separately.
8. `npm run qa:bots` — mock human-bot browser proof, port 3300 (NOT `qa:bots:live`) for the scanner/role/export/reconcile surfaces.

Any red = fix root cause before the PR is considered ready. Then confirm finding-closure status: F-01, F-07,
F-08 remain **CODE-PREPARED / OWNER-GATED (OPEN)**; all others CODE-CLOSED.

## Self-review checklist (executor: run before declaring your task done)

- [ ] Your task's failing test was seen RED before the fix and GREEN after.
- [ ] The task's own proof commands are green (ledger for 1/3; firebase incl. transfer-and-reload for 3;
      route+e2e for 4/5/7; `node --test` for 6; corpus-drift+golden for 13; existing spend tests for 16).
- [ ] No live/paid provider, no push, no deploy, no prod write occurred. All **[OWNER-GATED]** items are
      prepared but NOT executed, and reported as CODE-PREPARED (not closed).
- [ ] The TOP LAW holds: no change made a scan vanish from the feed or fail to count; Task 1 strengthened it.
- [ ] No em/en dashes added to user-facing copy; `src/services` stays free of React/`next/*`.
- [ ] You staged **explicit paths only** (never `git add -A`/`git add .`) and committed to your
      `audit-fixes/0N-<name>` sub-branch. No push, no merge to `master`.
- [ ] Final report labels mocked vs live vs manual proof, lists what passed with exact commands/output, and
      lists the owner-gated actions still pending (F-01/F-07/F-08).
