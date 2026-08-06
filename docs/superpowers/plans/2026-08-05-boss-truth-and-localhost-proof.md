# Boss Truth Override + Localhost Proof Implementation Plan (2026-08-05)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Scout files under `.superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/scout-*.md` are canonical detail; this plan cites them as SCOUT-A (merge topology), SCOUT-W (workbook), SCOUT-T (turso write path), SCOUT-R (rebuild+gpt), SCOUT-L (localhost).

**Goal:** Make `NEW_UPDATED_BOSS_DB.xlsx` sheet1 the boss truth in live Turso and all corpus artifacts, integrate the fix branch + donor extractions into local master, and stand up a fully proven localhost environment where every database code decodes (boss tires first), sessions persist, and the whole app is browser-proven by parallel agent batches.

**Architecture:** Phase A is pure git (ff + 3-way donor merges). Phase B is a two-track write: live Turso via the existing staged-promotion CLI, plus new SHA-pinned boss export files feeding the local artifact rebuild chain. Phase D composes a real `.env.local`, runs dev with the Firebase emulator and the real ladder, and drives batched browser + API campaigns.

**Tech Stack:** git, node (better-sqlite3, @libsql/client via existing scripts), Python stdlib xlsx parsing, Next.js dev + Firebase emulators, Playwright MCP + chrome-devtools MCP + qa:bots, `scripts/stress/decode-batch.mjs`.

## Global Constraints

- Barcodes and part numbers are TEXT everywhere; leading zeros preserved; no numeric coercion (SCOUT-W: sheet2 floats are why sheet2 is excluded).
- TOP-LEVEL LAW: every scan appears and counts. OWNER RULE 2026-08-05: probes never dead-end; ladder continues in every environment.
- Owner authorizations in force: live Turso boss override (backup-first), paid rungs in local (caps + `decode-batch` $10 hard stop stay), misread-to-paid accepted, free-settled-suggestion escalation is intentional (do NOT "fix").
- Still gated: git push, deploy, prod promote. All merges LOCAL only.
- Sheet1 of the workbook is product truth; sheet2 ignored (SCOUT-W item 6). The 39 blank-barcode rows, 1 truncated code, and 36 studdable/studded shared-barcode pairs go to review/conflict-ledger, never guessed.
- Turso writes only via the staged pattern of `scripts/tire-db-repair/10_promote_execute.mjs` (SCOUT-T): fresh backup -> stage -> verify -> `PROMOTE_CONFIRM=YES` promote; update-in-place preserving `canonical_product_uid`; the ONLY actor running the promote step is the orchestrator.
- Never print secret values; `.env.local` composition copies vars without echoing.
- No em/en dashes in any user-facing copy.
- Executors: Codex + Sonnet implement (no commits); orchestrator commits and runs live-write/promote steps. No Fable subagents.

## Execution Map

| Lane | Tasks | Notes |
|---|---|---|
| A (main repo git) | A1 ff-master; A2 donor copies; A3 donor 3-way (upc set); A4 donor 3-way (ScannerInput); A5 donor-tree closeout | A2-A4 parallel after A1; A5 last |
| B (data) | B1 export gen; B2 drift check; B3 Turso staged override; B4 artifact rebuild + pins; B5 offline resolution proof | B1 parallel with A; B3 after B1+B2; B4 after B3; B5 after B4 |
| D (localhost) | D1 env compose; D2 stack up + smoke; D3 mass decode campaign; D4 browser function fleet; D5 sessions + perf; D6 phase close | D1 parallel with B4; D2 after A+B4+D1; D3/D4 parallel after D2, small batches |

Phase C (gpt-5.4-mini) is already satisfied (SCOUT-R items 5-6); D2 smoke re-verifies at runtime.

## Affected Files (summary)

- Phase A: git refs only + donor files (`scripts/retail-quality.mjs(.node-test)`, `src/server/upc/storage.ts(+3 tests)`, `src/components/ScannerInput.tsx(+test)`), `vitest.config.ts` (possible exclude), donor-tree cleanup in the main repo.
- Phase B: NEW `backups/boss-export-2026-08-05/*` (exports, meta, review remainder, resolution proof), NEW `scripts/boss-override-2026-08-05.mjs` (to create), `scripts/build-tire-exact-index.mjs` (pin updates), regenerated `src/server/tire-knowledge/*` artifacts + `knowledge.generated.db`, live Turso tables (tires, provenance, tire_part_numbers, aliases).
- Phase D: NEW `C:\tmp\scanbin-fix-diagnostic\.env.local`, NEW `.superpowers/stress/codes.json`, proof artifacts under `e2e/proof/localhost-2026-08-05/`.

## Out of Scope

- Push, deploy, production promote (owner-gated). Vercel/preview anything.
- "Fixing" the free-settled-suggestion paid escalation (owner ruled intentional) or the misread-to-paid policy.
- Sheet2 of the workbook (confirmed red herring), the 687MB source artifact contents, retail corpus regeneration.
- The hardened donor `build-knowledge-db.mjs` (deferred; committed builders used this phase).
- Legacy same-class masking fixes in `lookupUnknown`/`backgroundVerifyDeep` (ledgered follow-ups).

## Risks

- R1 Live Turso mutation: mitigated by fresh backup + stage/verify/atomic-swap + rollback command + orchestrator-only promote + existing local JSON backups.
- R2 Unexplained +399-row drift: B2 is a HARD GATE before B3; collision with boss rows blocks the promote.
- R3 Artifact/DB divergence window between B3 and B4: rebuild immediately after promote; gates corpus-drift/golden prove coherence before D2.
- R4 Paid spend during D3: codes come from the corpus (free rungs); paid exposure limited to the deliberate unknown-edge subset under decode-batch's $10 hard stop + daily cap; spend reported at phase close.
- R5 Emulator/live-auth wiring: D2 smoke gates the whole of D3/D4; failure loops before any campaign runs.
- R6 36 shared-barcode variant pairs: excluded from updates, recorded in the conflict ledger + review_remainder.csv, never guessed.

## Rollback

- Phase A: `git branch -f master <old-tip>` restores the ref; donor commits revert individually; the donor tree is preserved as `backups/donor-tree-2026-08-05.patch` + archive dir before any revert; branch deletion only after commit verification.
- Phase B Turso: the promotion CLI's `rollback` (rename swaps back) + fresh pre-stage backup + `backups/turso-boss-export-2026-08-04` full-row JSON.
- Phase B artifacts: regenerate from prior pinned inputs (kept in place) or `git checkout` the previous generated files.
- Phase D: environment only; stop servers, delete `.env.local`.

## Cost

- Subscription-billed agents (Codex + Sonnet/Haiku) throughout; zero Lane-1 API keys. Live paid exposure ONLY in D3's deliberate unknown-code subset via the app's own Lane-2 keys under the $10 decode-batch hard stop + AI_LOOKUP_DAILY_LIMIT=2000; Turso usage is the owner's existing instance. Spend reported at phase close per doctrine.

---

### Task A1: Fast-forward local master to the fix tip (orchestrator)

- [ ] In `c:\Users\djsan\inventory`: `git stash list` must be empty of surprises; working tree stays donor-dirty (that is expected and untouched by ff since HEAD moves but tracked donor modifications remain relative to new HEAD - VERIFY with `git status --short | wc -l` before/after that the dirty set is unchanged in count).
- [ ] `git merge-tree --write-tree master 9345522a` (SCOUT-A verified clean) then `git checkout master` is NOT needed: use `git fetch . 9345522a:master` equivalent - since we are ON retailtursodatabase with a dirty tree, do NOT checkout. Instead: `git branch -f master 9345522a` (moves local master ref only; working tree untouched), then `git log --oneline master -3` to verify.
- [ ] Record in ledger: master moved from <old tip> to 9345522a (ff-equivalent, SCOUT-A confirmed ancestor chain).

### Task A2: Donor direct copies (Sonnet)

**Files:** copy from the dirty tree (they are modifications in `c:\Users\djsan\inventory`): `scripts/retail-quality.mjs`, `scripts/retail-quality.node-test.mjs` into the fix worktree `C:\tmp\scanbin-fix-diagnostic` (SCOUT-A: untouched by fix/boss lineage, direct copy safe).
- [ ] Copy both files; run `node --test scripts/retail-quality.node-test.mjs` in the worktree. Expected: PASS.
- [ ] If the node-test file collides with the vitest unit glob (same class as the L-shaped Task 6 lesson: check `vitest.config.ts` exclude list), add it to the exclude array and run `npx vitest run --project unit scripts/` to prove no collection break.
- [ ] Report; orchestrator commits `feat(salvage): retail quality gate (donor extraction)`.

### Task A3: Donor 3-way merge, upc storage set (Codex)

**Files:** `src/server/upc/storage.ts`, `storage.test.ts`, `openFoodFactsUsage.test.ts`, `upcItemDbUsage.test.ts` (SCOUT-A: both sides edited; merge base 508baaa0 == master content for all four).
- [ ] For each file produce the donor diff: `git -C c:\Users\djsan\inventory diff 508baaa0 -- <file> > <scratch>.patch`, then apply with `git apply --3way` in the worktree (base identical so conflicts only where fix-branch also touched; SCOUT-A flags `storage.test.ts` 26-line pure-addition).
- [ ] Resolve conflicts keeping BOTH sides' semantics (donor hardening + fix-branch changes); no test weakened.
- [ ] Run: `npx vitest run src/server/upc/` Expected: ALL PASS. Then `npx tsc --noEmit` clean.
- [ ] Report with per-file conflict notes; orchestrator commits `feat(salvage): upc storage hardening (donor 3-way)`.

### Task A4: Donor 3-way merge, ScannerInput (Codex)

**Files:** `src/components/ScannerInput.tsx`, `ScannerInput.test.tsx` (same 3-way recipe as A3).
- [ ] Apply donor diffs with `--3way`; preserve the fix-branch behavior AND the donor's live-state improvement (salvage verdict praised its live-state update).
- [ ] Run: `npx vitest run src/components/ScannerInput.test.tsx` and the dom project sweep `npx vitest run src/components/` Expected: ALL PASS. Scanner buffer rules (CLAUDE.md) must hold: focused-by-default, Enter submits, refocus after submit - the existing tests assert these; do not weaken.
- [ ] Report; orchestrator commits `feat(salvage): ScannerInput live-state update (donor 3-way)`.

### Task A5: Donor-tree closeout (Sonnet, after A2-A4 committed)

- [ ] Import-grep: for each remaining modified/untracked donor path, grep the four extracted files + worktree src for imports of it. Expected: none (SCOUT-A). Anything imported gets flagged to the orchestrator, NOT deleted.
- [ ] Safety bundle: `git -C c:\Users\djsan\inventory diff 508baaa0 -- ':(exclude)*.generated.json' ':(exclude)*.generated.meta.json' ':(exclude)src/server/tire-knowledge/tireKnowledge.generated.json' > backups/donor-tree-2026-08-05.patch` (hand-written work only; generated excluded as regenerable).
- [ ] Revert donor modifications: `git -C c:\Users\djsan\inventory checkout -- .` EXCEPT keep: PROGRESS.md, LESSONS_LEARNED.md, TESTING.md, CLAUDE.md, GUARDRAILS.md (today's doc appends - list them explicitly in the checkout pathspec exclusion by staging them first: `git add PROGRESS.md LESSONS_LEARNED.md TESTING.md CLAUDE.md GUARDRAILS.md docs/superpowers/plans/` then `git checkout -- .` reverts only unstaged). Then `git commit -m "docs: 2026-08-05 checkpoint, lessons, owner rule"` (docs commit now safe on the moved master... verify current branch first; commit docs on master).
- [ ] Untracked junk: move `data/retail-knowledge/retail_off.enriched.jsonl.gz` (687MB) and `src/server/retail-knowledge/retailKnowledge.generated.json.gz` copies into `backups/donor-archive-2026-08-05/` (move, not delete); delete only `pr_diff.txt` and `tire-barcodes-1000.txt` stays (owner asked for it - KEEP). Restore corrupted test knowledge: `git checkout -- testing/app-knowledge/` if modified, else note untracked placeholders and move them to the archive dir too.
- [ ] `git status --short` afterward must show ONLY intentionally-kept untracked items (list them in the report). Branch `retailtursodatabase` may then be deleted by the ORCHESTRATOR ONLY after A2-A4 commits are verified on the fix line: `git branch -D retailtursodatabase` (its content = 508baaa0 ancestor + extracted donors + archived patch).

### Task B1: New boss export generation (Sonnet)

**Files:** Create `backups/boss-export-2026-08-05/boss_sheet1.csv` (+ `boss_export_meta.json` with SHA-256, counts) from the scout's full extraction (`<scratchpad>/new_sheet1_full_extraction.csv` - verify its SHA against a fresh re-parse of the xlsx with the same stdlib method, then copy); create `review_remainder.csv` (39 blanks + 1 truncated + 36 shared-barcode conflict pairs, from SCOUT-W lists).
- [ ] Also produce `turso_upsert_rows.jsonl`: one record per sheet1 row with `{item_number, brand, size_raw, item_name, barcode}` barcodes as strings.
- [ ] Verify: 3,543 rows, 3,504 with barcodes, 100% check-digit pass on standard lengths, 36 duplicate-barcode rows flagged with their pair. Print counts to the report.
- [x] COMPLETED 2026-08-05: outputs at backups/boss-export-2026-08-05/. TRUE UPSERT SET = 3,429 rows (3,504 minus 72 conflict-pair rows minus 1 truncated minus 2 invalid self-referential placeholder codes 9235030211/9315030311 that fail check digit - new review reason invalid_placeholder_barcode). review_remainder.csv = 114 rows; closure 114 + 3,429 = 3,543 exact. B3 verify gates MUST use 3,429, and MUST assert both placeholder codes are absent from live tires after promote.

### Task B2: Turso drift check (Sonnet, read-only)

- [ ] Explain the +399 tires / +387 part-numbers drift since the 07-28 backup with zero provenance growth (SCOUT-T item 4): query rows in live `tires` absent from the backup manifest sample - what source/shape are they (DT-harvest? master-append?)? SELECT-only. Report findings; if the drift rows collide with boss item numbers or barcodes, flag BLOCKING to the orchestrator before B3.

### Task B3: Turso staged override (implementer preps, ORCHESTRATOR promotes)

> B2 GATE RESULT (2026-08-05): CLEAR. Drift = DT-harvest weekly additions (399 tires / 387 part numbers, window 07-26..08-03; harvester writes no provenance - ledgered follow-up). CONDITION: 13 barcodes collide with harvester rows for the same physical product under different part-number spellings (list in b2-drift-report.md, e.g. boss NX18192 = harvester 18192NXK). The override script MUST special-case these 13: preserve the existing canonical_product_uid, update identity fields from boss truth only where blank/weaker, and ADD the boss item number to tire_part_numbers as an alias. Verify gate asserts all 13 handled that way. Upsert row count baseline = 3,429 (B1 corrected arithmetic); both placeholder codes 9235030211/9315030311 must be absent from live tires post-promote.

- [ ] Implementer (Codex): write `scripts/boss-override-2026-08-05.mjs` reusing the exact stage/verify helpers of `scripts/tire-db-repair/10_promote_execute.mjs` (SCOUT-T item 1-2): fresh `backup` first; stage = update-in-place by item number (preserve `canonical_product_uid`): tires.barcode + barcode_ean13/upc updates for the 814 improved rows, insert any sheet1 row absent from live (expected ~0 per SCOUT-W continuity), provenance batch `boss_source_v2 / NEW_UPDATED_BOSS_DB.xlsx / batch 2026-08-05`, part-number aliases refresh; verify = exact counts + the 36 conflict pairs EXCLUDED (left for review) + old bogus codes (e.g. 3220015959) absent from tires; promote = atomic rename swap; rollback command printed.
- [ ] Dry-run mode (`--stage --verify` only) run by implementer with output in report. NO promote by the implementer.
- [ ] ORCHESTRATOR runs: fresh backup, stage, verify, then `PROMOTE_CONFIRM=YES ... promote`, then post-checks: `SELECT count(*) FROM tires`; `BH1600448 -> 8848116004480` present; `3220015959` absent; 1,463 pure-boss rows updated not orphaned.

### Task B4: Artifact rebuild with new pins (Codex + Sonnet)

- [ ] Copy `backups/claude-tire-db-handoff-2026-07-28/` (the two pinned inputs SCOUT-R names) AND `backups/boss-export-2026-08-05/` into `C:\tmp\scanbin-fix-diagnostic\backups\` (SCOUT-R blocker: worktree has no backups/).
- [ ] Update `scripts/build-tire-exact-index.mjs` in the worktree: point its boss input at `backups/boss-export-2026-08-05/boss_sheet1.csv`, update pinned SHA-256 + expectedCounts (from B1 meta), regenerate the conflict ledger with the 36 pairs.
- [ ] Rebuild in order with committed builders (SCOUT-R): `npm run build:tire-knowledge` -> tire JSON; exact-index build -> 64 shards + manifest (expect keys > 84,464 due to 814 improvements; record exact); `npm run build:knowledge-db` -> knowledge.generated.db.
- [ ] Gates: `npm run test:corpus-drift` and `npm run test:golden` Expected: PASS (golden = owner-loved slice, must not regress). `npx vitest run src/server/tire-knowledge/` PASS.
- [ ] Orchestrator commits artifacts + script pin changes.

### Task B5: Offline resolution proof (Sonnet)

- [ ] Node harness (read-only, no server): for ALL 3,504 boss barcodes + a 1,000-code random corpus sample, call the worktree's `resolveExactBarcode`/exact-index lookup directly; assert hit-rate: boss barcodes 100% minus the 36 conflict-pair codes (documented), corpus sample 100%. Write `backups/boss-export-2026-08-05/resolution_proof.json` + report totals (~80k tires total in tires table per B3 post-check).

### Task D1: Compose worktree .env.local (orchestrator, secrets)

- [ ] Build `C:\tmp\scanbin-fix-diagnostic\.env.local` from: inventory `.env.local` (TURSO_*, OPENAI_API_KEY, GO_UPC_API_KEY, FIRECRAWL keys) + `.superpowers/sdd/vercel-transfer-backup/env-production.env` (NEXT_PUBLIC_FIREBASE_*) + additions: `TRUSTED_EXACT_BOSS_BUSINESS_IDS=biz-e2e-fb`, `ENABLE_LIVE_AI_LOOKUP=1`, `ENABLE_OPENAI_LOOKUP=1`, `ENABLE_AUTO_DECODE_ON_SCAN=1`, `AI_LOOKUP_DAILY_LIMIT=2000`, `PORT=3050` (3000 occupied, SCOUT-L item 7), plus the existing `BOSS_EXACT_INDEX_HMAC_KEY` from the boss checkout's env. Never echo values; verify by variable NAME listing only.

### Task D2: Stack up + smoke (orchestrator + Sonnet)

- [ ] Start `npm run emulators` (Auth 9099 / Firestore 8080) then `npm run dev:emulator` on PORT=3050 in the worktree (background, logs captured). Seed the emulator fixture business `biz-e2e-fb`/`e2e-fb-user` via `e2e/firebase-phase2/admin.ts` helpers (SCOUT-L item 3).
- [ ] Smoke (Sonnet, browser via Playwright MCP): sign in as the fixture user; `GET /api/ai-lookup` shows goUpc.configured true, missingKeys empty for OPENAI, `trustedExact.allowlistConfigured: true`; `GET /api/health` firestore true, tireJsonIndex loaded with the NEW barcodeRows count; scan `8848116004480` (the corrected BH1600448) -> row appears instantly, decodes VERIFIED from corpus, session persists across a reload. Screenshot each step to `e2e/proof/localhost-2026-08-05/`.

### Task D3: Mass decode campaign (Sonnet batches)

- [ ] Generate `.superpowers/stress/codes.json` in the worktree: all 3,504 boss barcodes + 5,000 random corpus barcodes + edge sets (the 4 old bogus 10-digit codes, misread check-digit variants, 8/12/14-digit formats). Run `scripts/stress/decode-batch.mjs` against http://localhost:3050 in batches of 200 (small batches per owner), $10 hard stop armed, rung attribution on. Expected: boss + corpus codes settle on FREE corpus rungs (0 paid spend for them); bogus codes route honestly to review WITH ladder continuation visible; paid rungs fire only for the deliberate unknown-code edge subset. Full attribution report saved; any non-decoding DB code = defect -> fix loop.

### Task D4: Browser function fleet (parallel Sonnet batches, separate browser contexts per agent)

- [ ] Batch agents (Playwright MCP + chrome-devtools MCP + `npm run qa:bots` personas where they fit), each in its OWN browser context (SCOUT-L item 5: no shared tabs), covering: scan flow (known/unknown/rapid-10, Enter submit, refocus), Needs Review resolve/teach-alias, counts + mark-wrong transfer, CSV import/export, reconcile panel, settings (clear cache, AI toggle honesty), offline scan -> reconnect sync, History, multi-session isolation across two contexts, console-error sweep. Screenshots to `e2e/proof/localhost-2026-08-05/`. Every failure gets a fix loop with a failing-first test.

### Task D5: Sessions + performance (Sonnet)

- [ ] Persistence: scan 10 codes, kill the dev server, restart, reload - feed/counts/review intact (localStorage keys sis-scan-v1 etc.). Two parallel contexts do not cross-contaminate.
- [ ] Perf: chrome-devtools trace on the scan page (LCP, scan-to-feedback latency across 20 rapid scans), record numbers in the report; regression threshold: scan feedback under 100ms local.

## ADJUDICATED PLAN AMENDMENTS (2026-08-05, binding - from the Codex sol-xhigh plan attack)

These amendments OVERRIDE the corresponding task text above wherever they conflict. Full findings: `.superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/codex-plan-attack-2.md`.

- AM-A5 (executed status): the predicted mis-commit occurred (9af8b6c6 on the donor branch with a staged generated blob); docs were re-landed cleanly on master (ec0a3ba2) via explicit path lists before branch deletion; safety tag `archive/donor-final-9af8b6c6` preserves the branch tip. Residual: full SHA-256 donor inventory was not made; archives + 364KB patch + tag accepted as coverage.
- AM-B3-1 (semantics): B3 is a FULL-CLONE rename-swap. Copy all five live tables into schema-identical `staging_*` clones; apply boss actions ONLY inside staging while preserving UIDs. "Update-in-place" = mutating the staged clone, never live tables.
- AM-B3-2 (actions ledger): before staging, materialize `backups/boss-export-2026-08-05/boss_override_actions.jsonl` - one row per eligible boss row with item_number, desired_barcode, current_barcodes, match_basis, current_uid, action, old_keys_to_drop, part_number_alias_to_add, source_row, decision_reason. Exact closure of 3,429 into named buckets. Known offline classification vs the 07-30 snapshot: 2,663 same-UID updates, 9 cross-UID collisions, 1 part-number-only, 424 barcode-only, 332 matching neither key (inserts are NOT ~0). Any cross-UID disagreement not explicitly approved routes to review and blocks promote. The 13 Nexen drift collisions are a subset, not the whole story.
- AM-B3-3 (gate rewrite): replace the CLI's Gate G semantics with a barcode-replacement ledger check: every old live key survives unless listed exactly once in the ledger; every approved replacement key exists exactly once on its preserved UID; no unapproved key disappears.
- AM-B3-4 (roles): implementer = offline generation + unit tests + dry-runs labeled NOT EVALUATED only. Orchestrator alone: fresh backup, live stage, real verify, promote, post-checks - all bound to a fresh manifest SHA recorded outside the staging dir.
- AM-B4-1 (identity base): the raw boss_sheet1.csv CANNOT feed build-tire-exact-index.mjs. Preserve the prior reviewed reconciliation as the identity base; produce a deterministic Sheet1 overlay joined by source_part_number yielding a new reviewed reconciliation + repair snapshot with stable UIDs. Sheet2 = frozen unchanged. Preserve the 42 HMAC collision dispositions; add the 36 shared-barcode blocks as a separate reviewed class. Derive the builder's six expectedCounts from the completed projection; drop the ">84,464 keys" assertion, compute the exact projection diff instead.
- AM-B4-2 (pin order): record pre-build payload hash/count + current manifest FIRST; run build:tire-knowledge; fail if the global payload shrinks vs the floor without an approved diff; then update the global hash pin; generate the overlay; update source pins + cardinalities + production-proof assertions; run `node --test scripts/build-tire-exact-index.node-test.mjs`; build the index; run `node scripts/build-tire-exact-index.mjs --check`; then build knowledge.generated.db; then corpus-drift, golden, tire-knowledge vitest.
- AM-B5 (denominators + APIs): assert exactly 3,429 eligible rows hit via AUTHENTICATED `resolveTrustedExactBarcodeDecision`; 36 distinct shared barcodes produce the documented blocked/conflict result for all 72 rows; truncated + 2 placeholders miss into review; separately prove unauthenticated callers get no boss-only identity; the 1,000-code public sample runs through `resolveExactBarcode` with recorded seed + source hash.
- AM-D2 (env/launch): launch `npm run dev:emulator -- --port 3050` with NEXT_PUBLIC_AUTH_MODE=live (now in .env.local) and IS_E2E unset; gate on startup log + health at exactly http://localhost:3050; status assertions: e2e:false, openaiConfigured:true, goUpc.configured:true, trustedExact.allowlistConfigured:true; assert only that OPENAI_API_KEY is absent from missingKeys.
- AM-D3-1 (auth topology): extend decode-batch.mjs to acquire an Auth-emulator token in memory and send idToken + businessId=biz-e2e-fb with refresh; tokens never written to reports. Without this, the live-auth server rejects every batch call.
- AM-D3-2 (spend enforcement): D3's unknown/edge batch is BLOCKED until budget is enforced BEFORE dispatch: proven-free codes run separately; every unknown request atomically reserves documented worst-case cost pre-POST counting every billed unit (timeouts/aborts = worst case); concurrency 1 for unknowns until the guard has a concurrency proof; set and report GPT_LADDER_DAILY_USD explicitly (server pre-call default is $3 - AI_LOOKUP_DAILY_LIMIT is a count, not dollars); reconcile final spend against provider consoles before quoting numbers.
- AM-D4/D5 (tenancy/isolation): qa:bots runs its own mock stack on 3300 - it is a separate regression gate, NEVER port-3050 evidence. Parallel mutating browser workers get a unique user+business each, or shared-tenant mutations are serialized. Expected matrix: same-tenant contexts converge via Firestore with separate in-memory feeds; cross-tenant never leaks; reload restores namespace `sis-scan-<uid>` (e2e-fb-user) only after authenticated rehydration. Unique screenshot/report dirs per worker.
- AM-D6 (battery): closure requires boss-override unit tests; exact-index node-test + --check; `npm run proof:full`; `npm run test:ledger`; `npm run test:firebase`; corpus-drift; golden; tire-knowledge vitest; the authenticated D2 smoke receipt; B5 closure receipt; D3 batch closure with no unexplained errors/skips; D4/D5 proof inventory; every exclusion enumerated by source row + reason. No push and no "ready" verdict until all gates pass on the final combined worktree.

### Task D6: Phase close (orchestrator)

- [ ] Full gate battery re-run in the worktree (proof:local, ledger, corpus-drift, golden). Ultra review: slim adversarial pass over the phase diff (Codex + Sonnet lenses). PROGRESS.md + ledger checkpoint, spend report (decode-batch attribution + any paid rung totals vs the $10 stop), memory updates. Flag /code-review ultra moment for the owner. NO push.
