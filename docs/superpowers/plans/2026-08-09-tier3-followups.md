# Tier-3 Follow-ups Backlog

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:brainstorming before scoping any item further,
> then superpowers:test-driven-development for implementation. This is a BACKLOG plan, not a single
> sequential build: each numbered item below is independent, sized, and can be picked up cold in its own
> session without re-deriving context. Read PROGRESS.md checkpoint "2026-08-09 (late)" first for the full
> history of the three review loops + deep-review panel that produced this list; PR #32 merged that work
> to master. Owner rulings referenced below were made 2026-08-09 and are recorded here as the source of
> truth for implementation.

**Goal:** Give every item deferred from the 2026-08-09 tier-3 review loops (owner decision list in
PROGRESS.md) a scope, size, priority, and proof plan, so any one can be picked up independently.

**Out of scope:** actually implementing any item. This plan is the backlog and the acceptance criteria;
implementation is separate work, each gated by its own plan-approval where the doctrine requires it
(items marked "structural" or "design" need a fresh attack-panel pass before code, per
`docs/PLAN_EXECUTION.md`).

## How to read this list

Each item has:
- **Size**: S (under 2 agent-hours), M (half day to a day), L (multi-day, needs its own plan + attack panel).
- **Priority**: recommended execution order, justified briefly.
- **Scope**: what changes and where.
- **Acceptance criteria**: what must be true when done.
- **Proof plan**: exact commands/tests to run.

---

## Item 0 (in-flight, not a todo): Decouple delete-route rate limiter from ladderStorage

Already being worked on branch `fix/delete-limiter-firestore`. Listed here for completeness only so a
cold session does not duplicate it. Do not start this from scratch; check that branch first (`git log
fix/delete-limiter-firestore` and its own PROGRESS/DECISIONS notes) before touching the delete-route rate
limiter. Original problem: GDPR erasure (the account delete route) should not become unavailable just
because the decode cache DB (ladderStorage/Turso) is down or slow; the rate limiter for that route was
piggybacking on the same storage seam as decode. Owner decision list origin: PROGRESS.md "2026-08-09
(late)" OWNER DECISION LIST #3.

---

## Item 1 (priority 1, do first): Atomic daily-cap increment with a god charged-but-never-blocked path

**Size:** M (half day to a day).

**Owner ruling recorded 2026-08-09:** god (the platform owner account) stays CHARGED but NEVER BLOCKED at
the daily AI cap. Every other tenant is blocked once its conditional atomic increment fails. This ruling
is already made, so this item is shovel-ready: no design discussion needed, only implementation.

**Why priority 1:** every other item is either already in flight (item 0), needs a fresh design pass
before code (items 2, 3, 7), or is small and isolated (items 4-9). This item has an owner ruling already
on record, a clear bounded blast radius (one storage seam), and fixes a real correctness gap: today's cap
check-then-increment is not atomic, so concurrent requests near the cap boundary can overshoot it.

**Scope:**
- `src/server/upc/storage.ts`: the LadderStorage / DailyCapStorage seam (file adapter and the Turso
  adapter both need the same semantics).
- `chargeDailySlot` (wherever it lives in the decode pipeline / cap-gating code, per CLAUDE.md's daily AI
  cap description: "charges ONLY paid rungs, exactly once per genuine compute") changes its return type
  to include a `granted: boolean` (or equivalent) instead of assuming success.
- Every caller of `chargeDailySlot` must branch on `granted`: tenants treat `granted: false` as
  cap-blocked (today's existing "Needs Review, cap reached" honest-reason path); god's caller path
  charges the counter unconditionally (never checks `granted` to decide whether to proceed) but still
  records the charge for observability.
- File adapter: single-process atomic increment is easy (in-memory/file lock around read-check-write).
  Turso adapter: needs a true conditional UPDATE, e.g. `UPDATE daily_cap SET used = used + 1 WHERE
  used < limit` and checking `changes()`/affected-rows to know if it was granted, not a
  read-then-write pair (the current race).

**Explicitly bounded, not fully eliminated:** the plan text says overshoot is bounded by the number of
concurrent in-flight requests at the exact moment two increments race before either commits. A single
atomic UPDATE per adapter removes the classic check-then-act race for sequential contention; if the
underlying store cannot guarantee row-level atomicity under true concurrent writers, document that
residual bound rather than claiming zero overshoot.

**Acceptance criteria:**
1. A new test proves: N concurrent chargeDailySlot calls against a cap of K (N > K) for a normal tenant
   result in exactly K granted and N-K denied, never K+1 granted.
2. A new test proves: god's calls always return granted-for-purposes-of-proceeding even past the cap, but
   the counter still increments (so the charge is visible in cap telemetry/reporting).
3. All existing daily-cap and pipeline tests still pass unmodified (no behavior change for the
   already-correct single-request path).
4. `npm run test:ledger` still green (cap gating is adjacent to, not part of, the count ledger, but the
   pipeline touches shared code paths).

**Proof plan:**
- Failing-first: write the concurrency test against the CURRENT implementation, confirm it fails
  (overshoot observed), per TDD.
- `npx vitest run <new test file>` green after the fix.
- `npx vitest run` full unit project green (no regression in decode pipeline/cap tests).
- `npx tsc --noEmit` clean (return-type change ripples to every caller).
- Manual grep for every existing call site of `chargeDailySlot` to confirm each was updated (do not rely
  on TypeScript alone catching call sites that ignore the return value if the signature stays
  boolean-compatible - make the type change deliberately breaking, e.g. change the return type from
  `boolean` to an object, so every ignored call site is a compile error).

---

## Item 2 (priority 2, needs a plan first): Drop businessId from buildIdempotencyKey

**Size:** L (structural, multi-day, needs its own plan + adversarial attack panel before any code).

**Why priority 2:** this is the highest-leverage item on the list ("kills the whole adoption
rescope-rewrite obligation" per the owner decision list) but it is also the riskiest: it touches the
idempotency contract that the whole sync/dedupe system depends on, and it has a live-data compatibility
tail (old keys already exist in Firestore forever). Sequenced second so item 1 (shovel-ready, low risk)
ships first while this one gets a proper design pass.

**Scope:**
- The `buildIdempotencyKey` function (used across scan events, sync queue items, dedupe checks) currently
  embeds `businessId` as a prefix. Multiple 2026-08-07/08 fixes exist ONLY because adoption (anonymous
  session -> real business) has to rescope every embedded key from the placeholder businessId to the real
  one (`rescopePlaceholderQueueItem`, the Loop 1/2/3 stamp-aware fixes, the whole demotion-latch design
  from the 2026-08-09 late checkpoint). Removing businessId from the key format removes the entire class
  of rescope bugs at the root, per the doctrine's "root-cause the CLASS" rule.
- Needs: server-side `_appliedKeys` (or equivalent dedupe-applied-key tracking in Firestore) must accept
  BOTH the old `businessId:...` format and the new bare format forever (old keys already persisted in
  production Firestore cannot be migrated in place without a live-data migration, which is owner-gated).
- Needs: a migration path for in-flight persisted queues (IndexedDB/localStorage) that still hold
  old-format keys from before the change ships - either a one-time forward migration on load (matching
  the pattern already used for the IndexedDB persist migration, #27) or acceptance that old-format keys
  simply continue to work under the backward-compat rule above.
- Needs: full attack panel before code per `docs/PLAN_EXECUTION.md` and `GUARDRAILS.md` ("Attack every
  real plan from multiple angles (incl. Codex) before executing") - this item does NOT get to skip
  straight to implementation.

**Acceptance criteria:**
1. New idempotency keys no longer embed businessId.
2. Every historical key format still dedupes correctly server-side (a regression test replays an old
   `businessId:...` key and a new bare key for the same logical event and confirms exactly one apply).
3. Adoption (anonymous session -> real business) no longer needs ANY key-rewrite step - the whole
   `rescopePlaceholderQueueItem` mechanism and its dependent tests become unnecessary (either deleted or
   proven to be no-ops), which is the actual measure of "kills the whole obligation."
4. `test:ledger` and `test:firebase` both green; no double-counting introduced by the format change.

**Proof plan:**
- Plan + attack panel written and adjudicated first (separate artifact, not this backlog file).
- Failing-first tests for: new-format dedupe, old-format dedupe, mixed-format collision safety, adoption
  without any rescope step.
- `npm run test:ledger`, `npm run test:firebase`, full `npm run test`, `npx tsc --noEmit`.
- Emulator adopt spot-check (the same manual proof pattern used in the 2026-08-09 checkpoint) run again
  post-change to confirm adoption still drains to 0 pending with correct counts, this time via the new
  key format with no rescope step involved.

---

## Item 3 (priority 3, needs a design spike): Multi-tab same-session scanning

**Size:** L (design + implementation, multi-day).

**Why priority 3:** real correctness gap (one tab's scans can be silently lost on concurrent writes) but
lower urgency than items 1-2 because it requires exploring multiple designs before committing, and it
overlaps with item 7 (per-record persist keys) - solving persistence at the record level is very likely
to solve, or substantially simplify, this item too, so they should be evaluated together rather than
built twice.

**Scope:**
- Today's persist layer (localStorage historically, IndexedDB since #27) does whole-snapshot-wins:
  the last tab to write its full state blob overwrites whatever the other tab wrote, so a second tab
  scanning concurrently can lose its own scans on the next coalesced persist tick. This is pre-existing
  behavior, not a #27 regression - #27 changed the storage backend, not the write-merge semantics.
- Options to evaluate before picking one (this is the design-spike part of the work):
  1. Per-record IDB keys (write each ScanEvent/count as its own key instead of one giant JSON blob) -
     turns concurrent writes from "last writer wins on everything" into "last writer wins per record,"
     which mostly solves cross-tab loss for free. This is the same storage shape as item 7.
  2. Tab leadership election (one tab owns writes, others forward scans to it via BroadcastChannel or a
     lock) - stronger consistency, more complexity.
  3. BroadcastChannel merge (each tab writes its own delta, a merge step unions deltas on read) - avoids
     leadership complexity but needs careful conflict/ordering rules for the same product being scanned
     in two tabs near-simultaneously.

**Acceptance criteria:**
1. A design doc/plan section picks one of the above (or a fourth option found during the spike) with a
   stated reason, before any implementation code lands.
2. A regression test proves: two tabs (simulated via two store instances against the same storage
   backend) each scan different products concurrently; after both settle, BOTH scans are present and
   counted (today: one is lost).
3. No change to single-tab behavior or performance for the common case.

**Proof plan:**
- Failing-first test simulating two concurrent writers against the current implementation (confirms the
  loss), then again after the fix (confirms recovery).
- Manual two-tab browser proof (two real browser tabs signed into the same account, scanning
  concurrently) via Playwright multi-context, since this is exactly the kind of timing-sensitive bug that
  unit tests alone can under-prove.
- `npm run test:ledger` green (count correctness under concurrent writers is a ledger concern).

---

## Item 4 (priority 4): Integrity-fallthrough alerting

**Size:** S (under 2 agent-hours).

**Why priority 4:** small, isolated, and closes a silent-failure gap that could otherwise run unnoticed
for a long time in production (a missing/rotated boss HMAC key sends every tenant's unknown codes down
the paid ladder without anyone knowing). High value for low effort, sequenced right after the larger
structural items so it does not get lost.

**Scope:**
- The `shard_or_manifest_invalid` / `missing_hmac_key` code paths (trusted-index integrity checks) today
  call `logServerEvent` but nothing surfaces it loudly. Add a loud structured alert (matching whatever the
  project's existing alerting pattern is - check `observability` patterns / `docs/ARCHITECTURE.md` for
  how other critical-path failures are surfaced) plus a visible surface in the weekly report
  (`/weekly-report` deep pass, `observability` agent).

**Acceptance criteria:**
1. A missing or invalid HMAC key produces a distinguishable, loud log/alert entry (not just a routine
   `logServerEvent` call indistinguishable from normal traffic).
2. The weekly-report `observability` agent (or an equivalent grep-able surface) picks this condition up
   if it fires.
3. No change to actual decode behavior - this is alerting-only, the ladder continuation itself is correct
   per owner rule L16 (a code not in the DB always continues through the ladder).

**Proof plan:**
- Unit test: force `shard_or_manifest_invalid` or `missing_hmac_key`, assert the loud alert path fires
  (mocked sink, assert call with expected severity/shape).
- Manual/automated check that the weekly-report observability pass would catch it (dry run or code
  inspection of the agent's grep patterns).

---

## Item 5 (priority 5): URL-blind fetch-mock sweep

**Size:** S (under 2 agent-hours).

**Why priority 5:** the specific instance that surfaced this class was already fixed 2026-08-09 (two dom
test failures root-caused to URL-blind fetch mocks counting the unpaced `/api/prefix-floor` enrichment as
decode POSTs). This item is the sweep for the rest of the class - lower urgency because it is a test-only
correctness issue (false confidence in decode-call-count assertions), not a production bug.

**Scope:**
- Sweep `src/stores/*.test.ts` for any `fetch` mock that intercepts ALL calls regardless of URL and then
  asserts a call count against that mock. Any such test is at risk of silently counting unrelated fetches
  (like the prefix-floor enrichment call) as decode calls.
- Fix pattern: discriminate mocks by URL (matching the pattern used in the 2026-08-09 fix) so each
  assertion only counts the calls it actually means to count.

**Acceptance criteria:**
1. Every fetch-mock-based call-count assertion in `src/stores/*.test.ts` discriminates by URL.
2. No test's assertions change in a way that weakens what they prove - the fix must make counts more
   precise, never delete/loosen an assertion to make it pass (per anti-fake-proof rules).

**Proof plan:**
- Grep-based inventory first (`grep -rn "global.fetch = " src/stores/*.test.ts` or the project's actual
  mock pattern) to produce the exact file list before touching anything.
- `npx vitest run src/stores` full run green after each fix, comparing pass counts before/after to prove
  nothing was silently weakened.

---

## Item 6 (priority 6): Retry-After retries bypass the client pacer budget

**Size:** S (under 2 agent-hours), needs a proving test first per the plan text.

**Why priority 6:** bounded and flagged already (not a live incident), but it is a real budget-control
gap: `fetchWithBackoff`'s single 429 retry does not consume a pacer token, so a burst of 429s can exceed
the intended client-side rate budget even though each individual retry looks reasonable in isolation.

**Scope:**
- Correct semantics per the task text: `max(Retry-After, next token)` - the retry must wait for whichever
  is longer, the server's requested backoff or the client pacer's next available token, and must actually
  consume a token when it fires.
- Locate `fetchWithBackoff` (client-side pacer / retry logic, likely near the decode-call client code
  referenced elsewhere in this plan, e.g. `/api/prefix-floor` or `/api/ai-lookup` callers).

**Acceptance criteria:**
1. A proving test first demonstrates the bypass: simulate a 429 with `Retry-After`, drain the pacer
   budget, confirm the retry fires anyway (bypassing the budget) - this must FAIL against current code
   per TDD.
2. After the fix, the same test confirms the retry waits for `max(Retry-After, next token)` and consumes
   a token.
3. No regression to normal (non-429) pacer behavior.

**Proof plan:**
- `npx vitest run <fetchWithBackoff test file>` — new test fails before fix, passes after.
- Existing pacer/backoff test suite still green.

---

## Item 7 (priority 7, pairs with item 3): Per-record persist keys

**Size:** M-L (performance-motivated structural change).

**Why priority 7:** real but not urgent - the single-blob JSON.stringify cost grows with scan count (7.4MB
observed at 4,500 scans in the CANELO proof) and is a main-thread cost on every coalesced persist tick,
but it is not yet a correctness bug on its own (the CANELO 4,500 proof passed). It is sequenced to be
evaluated ALONGSIDE item 3 rather than built twice, since per-record IDB keys is both the multi-tab fix
and the perf fix.

**Scope:**
- Move from one giant JSON blob per persist tick to per-record IndexedDB keys (append/update the changed
  record only, instead of rewriting the whole state blob on every tick).
- Must preserve every existing persist guarantee: survive refresh, offline resilience, the one-time
  legacy localStorage forward migration from #27, idempotent replay.

**Acceptance criteria:**
1. Persisting N additional scans on top of an existing M-scan session does work proportional to N, not
   proportional to M+N (the current O(total size) cost per tick).
2. All existing persist/hydration tests pass unmodified in behavior (same data survives refresh).
3. If built together with item 3: the same design also closes the multi-tab loss case.

**Proof plan:**
- Perf test/benchmark: measure main-thread time for a persist tick at 500, 2,000, 4,500 scans before and
  after; confirm the after-curve is roughly flat/linear-in-delta instead of linear-in-total.
- Full persist/hydration test suite green.
- Re-run (or reference) the CANELO-style large-volume proof to confirm no regression at scale.

---

## Item 8 (priority 8, needs an owner decision): Adopted sessions and non-provisional catalog products are not pushed on adoption

**Size:** S (under 2 agent-hours once the decision is made).

**Why priority 8:** this is flagged in the task as a decision item, not a bug - "deliberate parity with
live scanning" is the current stated intent. Low priority because it may turn out to be a non-issue once
the owner confirms the intent; sequenced near the end because it blocks on a product decision, not on
engineering complexity.

**Scope:**
- When an anonymous session is adopted into a real business, session documents and non-provisional
  catalog products are not currently pushed to the backend as part of adoption - this mirrors how live
  scanning also does not eagerly push those documents, so it may be correct as-is.
- The open question: does cross-device rendering of adopted counts (viewing the adopted session's data
  from a second device/browser) need those product docs pushed, or is the current parity intentional and
  sufficient?

**Acceptance criteria:**
1. Owner decision recorded: either "leave as-is, this is intentional parity" (close the item with a
   one-line note in DECISIONS.md) or "push is required" (in which case this item gets re-scoped with its
   own acceptance criteria once the decision lands).
2. If a push is required: adopted session/product docs become visible on a second device signed into the
   same account, matching how normally-synced data already behaves.

**Proof plan:**
- If closed as intentional: no code change, just a decision record.
- If push is required: a two-context Playwright proof (adopt on device A, verify visibility on device B)
  matching the pattern already used for cross-device restore proof in the 2026-08-05/06 CANELO work.

---

## Item 9 (priority 9, tooling only): agy/Antigravity headless hang

**Size:** S (tooling investigation).

**Why priority 9:** lowest priority because it affects only the review-tooling pipeline (one leg of the
deep-review panel), not the product. It already has a documented honest fallback: the 2026-08-09 late
checkpoint's panel ran without the Gemini/agy leg and reported that leg's absence honestly rather than
faking a verdict, per anti-fake-proof rules. Fixing it improves future review coverage but nothing is
currently blocked on it.

**Scope:**
- Two clean-room review runs died with "timeout waiting for response" (one at step 3). Reproduce by
  running `agy` interactively (not headless) once first to see if the same hang occurs - if it does not
  reproduce interactively, the bug is specifically in headless/non-interactive invocation.
- If it reproduces: file or fix the wrapper (`.claude` plugin config or whatever script invokes `agy` in
  the review pipeline) - likely a stdin/timeout/prompt-handling mismatch between the wrapper's
  non-interactive invocation and what the `agy` CLI expects.

**Acceptance criteria:**
1. Root cause identified: either "does not reproduce interactively, headless-only wrapper bug" or "agy
   itself hangs regardless of mode" (in which case this becomes an upstream report, not a local fix).
2. If a local wrapper fix is possible: the next deep-review panel run completes the Gemini/agy leg without
   a timeout.

**Proof plan:**
- One interactive `agy` run reproducing (or not reproducing) the hang, logged.
- If fixed: one full deep-review panel re-run with the agy leg producing a real verdict (not a reported
  absence).

---

## Item 10 (needs its own attack panel first): Charge-settlement hardening (decode paid-cap egress)

**Size:** L (concurrency-sensitive, money path; needs its own attack panel before code).

**Priority:** high (unmetered-spend class).

**Origin:** the 2026-08-10 deep-review panel (rounds 1-2) on the item-1 atomic daily-cap change
(PROGRESS.md checkpoint 2026-08-10). Two REAL but PRE-EXISTING defects were found in
`src/server/decode/pipeline.ts`'s charge-at-egress machinery and deferred here (they predate item 1).

**Scope:**
- F1 (CRITICAL): a STORAGE-error (not a cap denial) thrown at a rung's egress consumes the arm's
  paid-charge flag; `runLadder` (`src/server/upc/ladder.ts`) catches the per-rung exception and
  continues, so a downstream paid rung runs UNMETERED. Item-1 added sticky-ness for cap DENIALS only;
  storage-error failures are not made sticky. Fix direction: generalize the arm-stickiness so ANY
  global settlement failure fails the whole arm closed (no downstream provider egress), mapping a
  global storage failure to a `charge_unavailable`/needs-review outcome rather than a 500.
- F2 (CRITICAL, narrow): if the atomic charge (Turso `incrementIfBelow`) hangs PAST the per-rung
  budget (`DECODE_LADDER_RUNG_MS`, default 8000ms), `runLadder`'s Promise.race timeout abandons the
  rung while the charge promise is still pending; the arm-flag was already consumed, so the next rung
  bypasses charging and runs unmetered, and a late-resolving denial can leak into the finally
  (cap_blocked after paid work) or into the next arm. Fix direction: give each arm its own settlement
  promise/token that later egresses await; do not complete/reuse an arm while its settlement is
  pending; add a bounded, fail-closed charge timeout. Add regression tests using a deferred charge
  that resolves/denies after the rung timeout.
- Also evaluate a cleaner root fix: an ATOMIC two-key reservation that advances the global and
  per-account counters together (or neither), which would also retire item-1's residual
  "global-first phantom on account-deny + refund compensation" band-aid.

**Acceptance criteria:**
1. A concurrency test proves no unmetered provider egress under (a) a storage-error at the first
   rung's charge and (b) a charge that resolves after the rung timeout.
2. God is still charged-but-never-blocked (no regression to item 1's ruling).
3. `npm run test:ledger` green.
4. Full `npm run test` green.

**Proof plan:**
- Attack panel on a written plan first, per `docs/PLAN_EXECUTION.md` and GUARDRAILS.md, before any
  code (this item does not get to skip straight to implementation).
- Failing-first tests for F1 (storage-error at egress leaks a downstream unmetered rung) and F2
  (charge promise resolving after the rung timeout leaks charging state), confirmed to fail against
  current code, then confirmed to pass after the fix.
- `npx vitest run` full unit project green.
- `npm run test:ledger` green.
- `npx tsc --noEmit` clean.

---

## Item 11 (small, cosmetic): Honest cap-scope reason code (account vs global)

**Size:** S (under 2 agent-hours).

**Priority:** low (cosmetic/observability).

**Origin:** same 2026-08-10 deep review (F5).

**Scope:**
- When a decode request is denied on its PER-ACCOUNT cap at egress, the pipeline throws a generic
  `DailyCapExceededError` and the route surfaces `reasonCode: "daily_cap"` (global) instead of
  `account_daily_cap`, whereas the route's own pre-gate correctly emits `account_daily_cap`.
- Fix: carry a cap scope ("global" | "account") through `DailyCapExceededError` and
  `DecodePipelineResult`, and emit `account_daily_cap` for account-scoped denials.

**Acceptance criteria:**
1. A test where a raced decode account denial surfaces `account_daily_cap` (not `daily_cap`).
2. No behavior change to global denials.

**Proof plan:**
- Failing-first test: force an account-scoped denial at egress, assert today's (wrong) `daily_cap`
  reason code, confirm it fails after the fix (now `account_daily_cap`).
- Existing daily-cap reason-code tests still pass unmodified for global denials.
- `npx vitest run <the decode route/pipeline cap test file>` green.

---

## Priority order summary

0. (in-flight, not a todo) Delete-limiter off ladderStorage - branch `fix/delete-limiter-firestore`.
1. Atomic daily-cap increment (M) - shovel-ready, owner ruling already made.
2. Drop businessId from buildIdempotencyKey (L) - highest leverage, needs a plan + attack panel first.
3. Multi-tab same-session scanning (L) - design spike, evaluate alongside item 7.
4. Integrity-fallthrough alerting (S) - small, closes a silent-failure gap.
5. URL-blind fetch-mock sweep (S) - test-only correctness, class-level cleanup.
6. Retry-After retries bypass the client pacer budget (S) - bounded, needs a proving test first.
7. Per-record persist keys (M-L) - perf-motivated, pairs with item 3.
8. Adopted sessions/non-provisional catalog products not pushed on adoption (S) - blocked on an owner
   decision, not on engineering complexity.
9. agy/Antigravity headless hang (S, tooling) - review-pipeline only, nothing product-facing blocked.
10. Charge-settlement hardening / decode paid-cap egress (L) - unmetered-spend class, needs its own
    attack panel first.
11. Honest cap-scope reason code, account vs global (S) - cosmetic/observability.
