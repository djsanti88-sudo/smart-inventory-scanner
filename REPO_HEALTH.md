# Repo Health — sync truth

Regenerate, don't hand-drift. Last updated: 2026-08-07

## CRITICAL callouts

1. **RESOLVED 2026-08-07: `audit-fixes` was fully merged into `master`, not stuck
   local-only.** Re-verified with `git rev-list --left-right --count master...audit-fixes`
   -> `100  0` (100 commits behind master, 0 ahead) — every commit on `audit-fixes`
   (tip `9a2a9030`) is already reachable from `master` (PR #30, merge commit
   `d80a34c5`). The prior "LOCAL-ONLY, 22 ahead, needs push/PR" callout below was stale
   from 2026-07-29, before that PR landed. The branch was deleted locally
   (`git branch -d audit-fixes`) on 2026-08-07 now that it is a strict subset of master.
2. **`benchmark-tire-db-automation` is PARKED. Do NOT delete or merge.** It is 1,112
   commits behind master and 6 ahead; merging it would delete ~152k lines including
   the poison guard, per standing owner order. Leave it exactly as is.

## Current branch truth (2026-08-07)

Active work lives on local branch `feat/tier3-hardening` (unpushed, owner-gated — push/PR
requires explicit owner approval). It contains the merged 2026-08-07 tier-3 trio via merge
commits `1e897480` (auth hardening trio), `a804fa64` (IndexedDB #27 persist migration),
`6e9d033b` (F-08 restore drill closure + weekly backup schedule):

- **IndexedDB #27**: scan-store persisted state moved off localStorage's ~5MB quota onto
  IndexedDB with a localStorage fallback and one-time forward migration.
- **F-08 restore drill closure**: Firestore restore drill passed end to end and a weekly
  Sunday backup schedule (28-day retention) is live on `(default)`.
- **Auth hardening trio**: fail-closed DELETE rate limit (3/hour), signup verification
  email, non-blocking verify banner on sign-in.

2026-08-07 housekeeping pass: merged tier-3 agent worktree
`.claude/worktrees/agent-a060cd1e7a15b8fa2` (F-08 docs, tip `ed62675b`) removed and its
branch `worktree-agent-a060cd1e7a15b8fa2` deleted (clean worktree, ancestor-verified against
`feat/tier3-hardening` HEAD). Two sibling tier-3 agent worktrees,
`.claude/worktrees/agent-afca4b13cfa5c4430` (IndexedDB, tip `b90ebfb0`) and
`.claude/worktrees/agent-a7033b7cd3086551b` (auth trio, tip `8d2ab358`), were left in place —
both have uncommitted changes to `testing/app-knowledge/*` files (teach-bot knowledge
artifacts) and were skipped per the no-force-delete rule, even though their commits are
already merged into `feat/tier3-hardening`. `worktree-agent-a47380b0deaa5e8d2` remains
untouched (unknown provenance, not in scope).

## Branch inventory (44 local branches, propose-only — no deletion or push without

per-branch owner approval)

| Branch | Category | Last commit | Ahead/Behind master | Recommended action (proposal only) |
|---|---|---|---|---|
| master | active | — | — | base branch, tracks `origin/master` [behind 23] |
| audit-fixes | **DELETED 2026-08-07** | 2026-07-29 | 0 / -100 (re-verified) | fully merged into master via PR #30 (see CRITICAL #1); `git branch -d` |
| feat/tier3-hardening | active | 2026-08-07 | current | unpushed, owner-gated; see "Current branch truth" above |
| chore/docs-consolidation | active | 2026-07-29 | current | this doc-consolidation branch |
| af/01-scan-ledger | merged-into-audit-fixes | 2026-07-29 | +3 / -0 | delete once `audit-fixes` lands (content preserved there) |
| af/02-api-auth | merged-into-audit-fixes | 2026-07-29 | +3 / -0 | delete once `audit-fixes` lands |
| af/03-turso-promote | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/04-corpus-provenance | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/05-firestore-infra | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/06-release-ci | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/07-platform-tooling | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| docs/github-deploy-truth | **REMOVED 2026-07-29** | 2026-07-27 | +0 / -45 | worktree `wt-ci` removed (clean), 0 unique commits, deleted |
| feat/camera-scan | **REMOVED 2026-07-29** | — | merged | worktree `wt-camera` removed (clean), 0 unique commits, deleted |
| feat/csv-import | **REMOVED 2026-07-29** | — | merged | worktree `wt-csv` removed (clean), 0 unique commits, deleted |
| feat/decode-gpt-54-mini | **REMOVED 2026-07-29** | — | merged | worktree `wt-54mini` removed (clean), 0 unique commits, deleted |
| feat/free-rungs | **REMOVED 2026-07-29** | — | merged | worktree `wt-rungs` removed (clean), 0 unique commits, deleted |
| feat/variance-report | **REMOVED 2026-07-29** | — | merged | worktree `wt-variance` removed (clean), 0 unique commits, deleted |
| fix/deploy-tooling-hardening | **REMOVED 2026-07-29** | — | merged | worktree `wt-master-cert` removed (clean), 0 unique commits, deleted |
| fix/redo-round | **REMOVED 2026-07-29** | — | merged | worktree `wt-round2` removed (clean), 0 unique commits, deleted |
| fix/release-stabilization | merged (master) | — | merged | worktree `inventory-stabilization` DIRTY (untracked `.powercells/`, `e2e/qa-powercell.spec.ts`, `scripts/antigravity-qa-runner.mjs`, `scripts/qa-runner.mjs`) — SKIPPED, held |
| fix/rung-trust-and-resolve-stamp | merged (master) | — | merged | worktree `inventory-wt-diag` DIRTY (`M .superpowers/sdd/progress.md`) — SKIPPED, held |
| flip/vercel-git-enable | **REMOVED 2026-07-29** | — | merged | worktree `wt-flip` removed (clean, required `git worktree prune`), 0 unique commits, deleted |
| rescue/argus-cp1252 | merged (master) | — | merged | worktree `wt-argus-fix` DIRTY (untracked `dev/`) — SKIPPED, held |
| rescue/phase3-followups | **REMOVED 2026-07-29** | — | merged | worktree `wt-p3-follow` removed (clean), 0 unique commits, deleted |
| rescue/qafix | **REMOVED 2026-07-29** | — | merged | worktree `wt-qafix` removed (clean), 0 unique commits, deleted |
| rescue/teach-bot | merged (master) | — | merged | worktree `wt-rescue-teach` DIRTY (30 modified `e2e/*.spec.ts` + `testing/app-knowledge/*`) — SKIPPED, held |
| worktree-agent-a47380b0deaa5e8d2 | merged (master) | — | merged | worktree `.claude/worktrees/agent-a47380b0deaa5e8d2` DIRTY (modified `src/app/api/*` + `aiSpendGuard.test.ts`) — SKIPPED, held |
| chore/lint-scripts-debt | valuable-unpushed | 2026-07-27 | +3 / -109 | review + push/PR |
| codex/vercel-release-hardening | valuable-unpushed | 2026-07-28 | +2 / -63 | upstream `[gone]`; review + re-push/PR |
| docs/post-cutover-hygiene | valuable-unpushed | 2026-07-27 | +2 / -121 | review + push/PR |
| feat/teach-bot-build | valuable-unpushed | 2026-07-22 | +5 / -407 | review; possible duplicate of `feat/teach-bot-clean` |
| feat/teach-bot-clean | valuable-unpushed | 2026-07-22 | +13 / -411 | review; possible duplicate of `feat/teach-bot-build` |
| fix/argus-cp1252 | valuable-unpushed | 2026-07-20 | +3 / -496 | review; `rescue/argus-cp1252` already merged — may be superseded |
| fix/phase3-followups | valuable-unpushed | 2026-07-21 | +1 / -421 | review; `rescue/phase3-followups` already merged — may be superseded |
| fix/rate-limit-route-scopes | valuable-unpushed | 2026-07-27 | +3 / -98 | review + push/PR |
| hotfix/decode-auth | valuable-unpushed | 2026-07-26 | +1 / -137 | review + push/PR |
| proof/git-deploy-e2e | valuable-unpushed | 2026-07-27 | +2 / -109 | review + push/PR |
| add-claude-github-actions-1784520958618 | dead-stale | 2026-07-19 | +3 / -898 | review, likely superseded by shipped CI actions; delete if confirmed |
| benchmark-tire-db-automation | dead-stale (PARKED) | 2026-06-15 | +6 / -1112 | DO NOT delete or merge (see CRITICAL #2) |
| demo-readiness-vercel-partnumber | dead-stale | 2026-06-15 | +1 / -1097 | worktree `inventory-demo` DIRTY (staged/untracked `reports/*` proof artifacts) — SKIPPED, held |
| feat/reverse-upc-heads-up | dead-stale | 2026-06-29 | +1 / -992 | review; delete if abandoned |
| fix/exact-code-evidence-verification | **REMOVED 2026-07-29** | 2026-06-21 | +1 / -1067 | 0 unique commits vs master, no worktree — deleted (`git branch -D`) |
| fix/qa-report-2026-07-15 | dead-stale | 2026-07-15 | +10 / -651 | review; delete if abandoned |
| strategy-bots-track2 | dead-stale | 2026-06-15 | +1 / -1104 | review; delete if abandoned |
| test | **REMOVED 2026-07-29** | 2026-06-30 | +9 / -979 | 0 unique commits vs master, no worktree — deleted (`git branch -D`) |

Category counts (as of 2026-07-29 follow-up pass): 3 active, 13 merged (6 into
master still held on dirty worktrees + 7 into `audit-fixes`, all HELD — see below),
10 valuable-unpushed, 6 dead-stale remaining (1 of those, `demo-readiness-vercel-partnumber`,
held on a dirty worktree; `benchmark-tire-db-automation` parked/excluded), 13 removed.

**2026-07-29 deletion pass (owner-approved, local-only, no push):** Of the ~19
SAFE-DELETE branches identified in
`docs/superpowers/reports/2026-07-29-branch-deletion-evidence.md`, only 2 were
actually eligible at execution time — `fix/exact-code-evidence-verification` and
`test` — because every other SAFE-DELETE branch (all 16 merged-into-master branches
plus `demo-readiness-vercel-partnumber`) had an active worktree checked out
(`C:/tmp/wt-*`, `C:/tmp/inventory-*`, `.claude/worktrees/agent-a47380b0deaa5e8d2`)
and the standing rule forbids deleting a branch checked out in a worktree.

**2026-07-29 follow-up pass (Agent F8b, owner-approved, local-only, no push):**
Processed the 17 branches held above. For each: located its worktree, ran a dirty
check (`git status --porcelain`), and only removed the worktree + deleted the branch
if the worktree was completely clean. Result — **11 removed, 6 skipped-dirty**:

Removed (worktree clean, `git worktree remove` then re-verified 0 unique commits
then `git branch -D`): `docs/github-deploy-truth`, `feat/camera-scan`,
`feat/csv-import`, `feat/decode-gpt-54-mini`, `feat/free-rungs`,
`feat/variance-report`, `fix/deploy-tooling-hardening`, `fix/redo-round`,
`flip/vercel-git-enable`, `rescue/phase3-followups`, `rescue/qafix`. (Two worktrees,
`wt-csv`/`wt-rungs`/`wt-variance`/`wt-p3-follow`, failed `git worktree remove`'s
directory delete step with `Invalid argument` on Windows; the worktree was still
unregistered from `git worktree list`, so the leftover directory was removed manually
with `rm -rf` and confirmed gone. `wt-flip` needed an explicit `git worktree prune`
before its branch could be deleted.)

Skipped-dirty (worktree left untouched, branch held): `fix/release-stabilization`
(`inventory-stabilization`: untracked `.powercells/`, `e2e/qa-powercell.spec.ts`,
`scripts/antigravity-qa-runner.mjs`, `scripts/qa-runner.mjs`),
`fix/rung-trust-and-resolve-stamp` (`inventory-wt-diag`: modified
`.superpowers/sdd/progress.md`), `rescue/argus-cp1252` (`wt-argus-fix`: untracked
`dev/`), `rescue/teach-bot` (`wt-rescue-teach`: 30 modified `e2e/*.spec.ts` +
`testing/app-knowledge/*`), `worktree-agent-a47380b0deaa5e8d2`
(`.claude/worktrees/agent-a47380b0deaa5e8d2`: modified `src/app/api/*` routes +
`aiSpendGuard.test.ts`), `demo-readiness-vercel-partnumber` (`inventory-demo`:
staged/untracked QA-bot proof artifacts under `reports/*`). These need owner review
of the uncommitted content (commit, discard, or move it) before their worktrees can
be safely removed and the branches deleted.

The 7 `af/01`-`af/07` branches remain held — they land only after `audit-fixes`
itself is pushed/PR'd/merged (CRITICAL #1); deleting them now would leave no ref for
that work if `audit-fixes` is reworked. The 4 REVIEW branches
(`add-claude-github-actions-1784520958618`, `feat/reverse-upc-heads-up`,
`fix/qa-report-2026-07-15`, `strategy-bots-track2`) were never in scope — they carry
unique unmerged commits and need manual review, not deletion.

`git worktree prune` was run at the end of the follow-up pass; remaining registered
worktrees are unchanged apart from the 11 removed above.

## Known issues / tech debt — fix, don't build on top

- `GO_LIVE_CHECKLIST.md` is stale vs live truth (predates the PR #21/#24 cutover).
- A BOM character was found in the `NEXT_PUBLIC_AUTH_MODE` Vercel env value —
  strip it before it causes a string-comparison bug in auth-mode branching.
- `post-deploy-smoke.yml` still needs `ref: github.sha` hardening (pending).
- Backup/recovery: VERIFIED 2026-08-07. The Firestore restore drill passed end to end
  (PITR-window export -> import into scratch DB `drill-20260807`, 78,979 docs, spot-checked
  vs live source, cleaned up) and a weekly scheduled backup is now live on `(default)`
  (Sunday, 28-day retention). Root cause of the prior block: Firestore service agent missing
  `roles/datastore.importExportAdmin` (now granted, retained). See `docs/RECOVERY.md` (F-08 CLOSED).
- F-01/F-07 rules/indexes redeploy is pending, owner-gated (Firestore security rules
  and composite indexes not yet pushed live).
- ~30 local worktrees exist under `C:/tmp/*` and `.claude/worktrees/*`, one per
  in-flight or already-merged branch (see `git worktree list`). Several point at
  branches already merged into master — those worktrees are reclaimable disk/clutter
  once the branch is deleted (`git worktree remove`), propose-only, no action taken.
- `src/eval/eval.test.ts` still writes its mock-eval table to the deleted `docs/decode/eval-baseline.md` path (try/catch-wrapped, harmless, but will resurrect the file untracked) - retarget the output path in a code round.
- `src/services/decode/{index.ts,contract.ts,README.md}` comments cite the deleted `docs/decode/ARCHITECTURE.md` - repoint to `docs/DECODER_ARCHITECTURE.md` in a code round.
- health `/api/health` rate-limit key from `x-forwarded-for` is client-spoofable; each allowed hit does a real Firestore+Turso read (low cost, follow-up hardening) - L3 minor.
- `computeDollarVariance` drops reconcile lines whose `unitCost` is keyed by name-only identity (not partNumber) from the dollar total - documented degradation, revisit.
- scan feedback panel omits running quantity during `isDecoding` ("Looking up...") - cosmetic.
- `npm audit`: next 16.2.12 applied (7 CVEs closed); remaining majors need planned upgrades - sharp, exceljs (downgrade suggested - do NOT take blindly), firebase-admin storage chain (unused, grep-confirmed). See `docs/superpowers/reports/2026-07-29-npm-audit-triage.md`.
- backfill `--execute` against PRODUCTION is owner-gated and not yet run - legacy docs may still carry `disputedBy`/`auditLog` on public parents until it runs.
