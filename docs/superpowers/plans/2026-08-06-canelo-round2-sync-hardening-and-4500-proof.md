# CANELO Round 2: Sync Hardening + Full 4,500-Code Cloud Re-Proof

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans).
> Read the `canelo-localhost-campaign` memory FIRST - it holds the rig relaunch steps, credentials,
> commit ids, and the defect evidence this plan fixes. Owner phrase "continue with canelo" = this plan.

**Goal:** Fix the four defect classes found during the 2026-08-05 4,500-scan campaign, then re-prove the
ENTIRE system live in Chrome with the same 4,500 codes on a fresh business: zero cloud loss, all history
saved and downloadable, no UI lag beyond thresholds. Proof = measured evidence, never announcement.

**Architecture:** All code work in worktree `C:\tmp\scanbin-fix-diagnostic` (branch
`fix/decode-diagnostic-2026-08-04`, tip `a0b0344c`). Browser proof via chrome-devtools MCP against
production `next start` on :3050 + Firebase emulators (8080/9099) + live Turso corpus. Orchestrator
commits; subagents never commit. Owner interpretation note: "through Adli" was read as "through the UI
end to end" - confirm with owner if it meant something else.

## Global Constraints (bind every task)

- TOP-LEVEL LAW: every scan appears + counts; identity gates never suppress rows/counts.
- Push, deploy, prod promote, paid live APIs: OWNER-GATED. Local edits/tests/emulator/builds: free.
- Automated tests NEVER call live providers. Emulator integration tests use `npm run test:firebase` harness.
- Barcodes are TEXT always. Never weaken/skip a test to go green. Failing-first test for every bug fix.
- The scanStore is a ~6,500-line monolith: grep symbols, never browse. `cloudDrainRace.store.test.ts` is
  timing-flaky under full parallel load only (passes isolated) - known, not yours.
- Subagent models: Codex (GPT-5.5 medium) or Sonnet for execution; Opus orchestrates + commits. NEVER Fable subagents.
- Rig bring-up commands, logins, and batch files: see memory `canelo-localhost-campaign` (do not re-derive).

## Phase 0: Baseline (do first, ~15 min)

- [ ] Bring up emulators (WITH `--import backups/emulator-snapshot-2026-08-05`), build worktree if stale, start :3050 per canelo memory. Start the :3055 CORS file server over the scratchpad session files ONLY if the old scratchpad survives; otherwise regenerate 4,500 codes: `batches-500.txt` (tire-barcodes-1000.txt first 500) + sessions 02-05 boss (Turso `provenance.source_name='boss_source'` join `tires`), 06-09 general (`tires` random, excluding boss + junk ranges 3220017199-212/3220017314-317), 10 lines x 50 codes per file.
- [ ] Verify baseline green: `npx tsc --noEmit --incremental false` (0 errors) + `npm run test` (expect ~3,845 pass / 90 skip / 0 fail) + `npm run test:ledger` (45).
- [ ] Confirm the 260-item poisoned queue still exists in the old Chrome profile (business `default_df9806fe...328`, key `sis-scan-tJc53s0N1q8wiSeEycouGlR37NPk`) - it is the live repro for Phase 1. If the profile is gone, Phase 1's emulator test is the repro.

## Phase 1: Fix #32 - sync-target retry poisoning (THE blocker, do before any re-run)

Evidence: 47,272 rule denials at firestore.rules L461 (auditLog `allow update,delete: if false`) + L504
(default deny); 260 items stuck forever (170 SAVE_UNKNOWN_SCAN, 85 SAVE_PRODUCT, 5 SAVE_SCAN_EVENT);
visible symptom = session detail shows 200 "Unidentified item" products + 389/500 events + stuck "Active".

- [ ] Scout `src/services/db/firebase/firebaseSyncTarget.ts` apply(): find every write that is create-only
  under rules (auditLog docs, `_appliedKeys`, any set() on fixed ids) and how a RETRY of a partially
  applied item re-issues them as updates.
- [ ] Failing-first EMULATOR test (test:firebase harness, e.g. `firebaseSyncRetry.rules.test.ts`): apply an
  item; simulate partial failure after the audit/applied-key write; re-apply the SAME item; assert the
  retry SUCCEEDS and the entity lands (today: permission-denied forever).
- [ ] Fix: make apply() idempotent on retry - either tolerate existing create-only docs (check-then-skip
  inside the transaction) or mint per-attempt audit ids; `_appliedKeys` existing = alreadyApplied success,
  never an error. Do NOT loosen firestore.rules (append-only audit is a security property).
- [ ] Add per-item `syncError` recording when a drain apply is denied (today: silent) - honest reasons law.
- [ ] Gates: new emulator test green, full `npm run test:firebase` green, `npm run test` green.
- [ ] LIVE PROOF: open the old Chrome profile, reload - the 260 stuck items must FLUSH to 0; session
  `d1da1105` must then show 500/500 events, "Completed", and its 200 "Unidentified item" products must
  gain their real identities in the session detail. Screenshot before/after.

## Phase 2: Fix #33a - drain latch wedge

Evidence: backlog froze at 782/987/260 with zero errors in long-running tabs; reload re-arms it.

- [ ] Scout the drain in-flight latch in scanStore (`syncPending`/drain chain). Hypothesis: an aborted/
  thrown pass leaves the latch set so every later syncPending() no-ops.
- [ ] Failing-first store test: force an apply() rejection mid-drain, then enqueue more + call syncPending;
  assert the new drain RUNS (today: wedged). Add a watchdog: latch older than N seconds with a non-empty
  queue self-resets (log it).
- [ ] Gates: new test + all 7 session/sync suites + test:ledger green.

## Phase 3: Fix #33b/#34 - bootstrap races + rotation prune (timeboxed 90 min total; park what does not fit with findings written down)

- [ ] Deep-link bounce: full-load of /history intermittently lands on /scan (AuthGuard anon race ->
  /login -> hardcoded replace("/scan")). Fix: login redirect honors a returnTo (or AuthGuard defers until
  Firebase restore settles). Failing-first dom test.
- [ ] "Loading business data..." intermittent forever-hang on full load (gate never flips
  businessDataLoaded; no error surfaced). Instrument, root-cause, fix or surface a retry affordance.
- [ ] Rotation prunes merged past-session finalCounts so History downloads regress until next refresh
  (followup #34 residual): either stop pruning merged rows on rotation or fetch counts on demand per
  download click. Failing-first test.
- [ ] Gates: history page tests (15+new) + affected suites green.

## Phase 4: Client 429 backoff (#28, small)

- [ ] prefix-floor/ai-lookup client calls honor Retry-After with capped backoff + jitter instead of
  hammering (878 x 429 in the 1,000-paste stress). Failing-first unit test with mocked fetch. Gates green.

## Phase 5: THE RE-PROOF - same 4,500 codes, cloud in Chrome, measured (no announcements)

Fresh business so cloud completeness is exact: sign up `canelo2@test.local` / `test1234` via the UI,
restart :3050 with its businessId APPENDED to `TRUSTED_EXACT_BOSS_BUSINESS_IDS`.

- [ ] Rebuild + restart with ALL fixes. Re-run baseline gates on final code.
- [ ] Run 9 sessions x 500 (batches-500 + session-02..09: same codes as round 1) via the page-side
  autonomous runner (canelo memory pattern): paste 50 space-separated + Enter, wait rows, wait settle.
  AFTER EVERY session: finish + IMMEDIATELY start next (the rotation stress) - do NOT wait for drain.
- [ ] Per-batch metrics recorded (LoAF observer): rows-appear ms, settle ms, long frames >=200ms, worst
  frame, our-API 429 count. Per-session: blob KB, quota probe, pending depth.
- [ ] Cloud verification after EACH session (emulator REST aggregations): cumulative scanEvents = 500xN,
  inventoryCounts matches, session doc reaches "completed" once drained, ZERO products left as
  "Unidentified item" placeholders after drain settles.
- [ ] History proof after sessions 3, 6, and 9: all rows present with correct units; download CSV
  live-captured for the OLDEST completed session (501 lines incl. header, real identities); repeat once
  after a FULL page reload and once in a second isolated browser context signed into the same account
  (cross-device restore).
- [ ] Mid-campaign resilience spot-checks (once each): refresh mid-session (counts survive, feed
  restores); brief offline/online toggle (scans keep counting, drain resumes).

**PASS/FAIL acceptance (all must hold):**
1. 4,500/4,500 rows appeared + counted in-tab; cloud scanEvents = 4,500; counts match; 9 session docs
   "completed"; 0 permanent placeholder products; pending queue 0 at close WITHOUT any recovery reload.
2. No stuck queue at any point > 5 minutes; no reload needed to un-wedge sync.
3. Speed: rows-appear p95 < 1.5s; batch settle p95 < 20s; no main-thread block > 5s at any point, none
   > 2s during batches 1-5 of any session; localStorage quota never exceeded (fail-soft never fires).
   If a speed gate fails -> execute contingency: decode-result state-update batching (#29 class fix),
   then re-run the failing session(s).
4. History: every session visible, correct units/products, CSV downloads proven live (captured bytes,
   not button-exists) including after reload + second context.
5. Final battery green on final code: tsc, `npm run test`, `test:ledger`, `test:firebase`.
- [ ] Full report per final_report_protocol (proof types labeled mocked/live/automated), update canelo
  memory + OWNER-FOLLOWUPS (#32/#33/#34 -> fixed with evidence) + ledger. Local merge of the branch to
  master allowed; PUSH REMAINS OWNER-GATED. Leave the rig running for owner inspection.

## Execution notes

- Codex = main executor for Phases 1-2 (sync target + store internals); Sonnet for Phases 3-4; Opus
  adjudicates, diff-verifies, runs gates, commits. Phase 5 driven by the orchestrator in Chrome directly.
- Phases 1 and 2 are sequential (same files). Phases 3-4 can run parallel to each other after 2.
- If Codex quota is out: Sonnet executes, per the standing fallback.
- Server restarts only BETWEEN sessions during Phase 5.
