# Repo Health - sync truth

Regenerate from real git output, don't hand-drift. Last updated: 2026-08-19 (root-docs refresh;
every count below from `git branch`, `git rev-list --left-right --count`, `git worktree list` run
that day). Older branch-sweep history (the 2026-07-29 and 2026-08-09 deletion passes, the 44-branch
table) lives in this file's git history and in
`docs/archive/PROGRESS_HISTORY_2026-07_2026-08.md`.

## Branch truth 2026-08-19

- `origin/master` = `2150c17a` (PR #41); local `master` == origin/master. Master merges
  auto-deploy production (owner-gated, `docs/DEPLOY_TRUTH.md`).
- Merged and deleted this era: `feat/best-guess-identity-cache` (PR #38),
  `feat/post-pr38-consolidation` (PR #39), `chore/consolidation-2026-08-19` (PR #40),
  `test/harden-review-reason-wait` (PR #41). Pre-rebase originals preserved at tags
  `backup/pre-aws-cleanup-2026-08-19` and `backup/stash0-pre-aws-wip-2026-08-19`.

## CRITICAL callouts

1. **`benchmark-tire-db-automation` is PARKED. Do NOT delete or merge.** 6 ahead / 1,336 behind;
   merging would delete ~152k lines including the poison guard. Standing owner order.
2. `audit-fixes` false alarm resolved 2026-08-07: it was fully merged via PR #30 and deleted.
   (Kept as a reminder: verify ahead/behind with git before declaring work stranded.)

## Local branches (20 + master, verified 2026-08-19)

Ahead/behind = commits unique to the branch / commits it is missing vs `master`. Proposals only;
no deletion or push without per-branch owner approval.

| Branch | Ahead / Behind | Category / proposal |
|---|---|---|
| master | base | tip `2150c17a` |
| chore/root-docs-refresh | this branch | the root-docs refresh (this commit) |
| benchmark-tire-db-automation | +6 / 1336 | PARKED, never delete or merge (CRITICAL #1) |
| chore/lint-scripts-debt | +3 / 333 | valuable-unpushed; review + push/PR |
| codex/vercel-release-hardening | +2 / 264 | valuable-unpushed; upstream gone, review + re-push |
| docs/post-cutover-hygiene | +2 / 345 | valuable-unpushed; review + push/PR |
| fix/rate-limit-route-scopes | +3 / 322 | review; core fix was ported to master 2026-08-09, likely superseded |
| proof/git-deploy-e2e | +2 / 333 | valuable-unpushed; review + push/PR |
| feat/teach-bot-build | +5 / 631 | review; possible duplicate of feat/teach-bot-clean |
| feat/teach-bot-clean | +13 / 635 | review; possible duplicate of feat/teach-bot-build |
| audit/product-readiness-20260810 | +1 / 74 | review (2026-08-10 audit snapshot) |
| chore/tree-triage-2026-08-12 | +25 / 77 | review (tree-triage work, unmerged) |
| codex/boss-alias-normalization | +246 / 172 | review; boss-era Codex line, decide keep/extract/drop |
| codex/boss-barcode-fastpath | +6 / 172 | review; boss-era Codex line |
| codex/boss-barcode-fastpath-v2 | +38 / 172 | review; boss-era Codex line |
| codex/local-tire-demo | +236 / 172 | review; demo line |
| pr27-review-head | +157 / 172 | review artifact of the PR #27 era; likely deletable |
| add-claude-github-actions-1784520958618 | +3 / 1122 | dead-stale; likely superseded by shipped CI |
| feat/reverse-upc-heads-up | +1 / 1216 | dead-stale; delete if abandoned |
| fix/qa-report-2026-07-15 | +10 / 875 | dead-stale; delete if abandoned |
| strategy-bots-track2 | +1 / 1328 | dead-stale; delete if abandoned |

## Worktrees (9 registered, verified 2026-08-19)

Main tree plus: `C:/tmp/boss-alias-normalization`, `C:/tmp/inventory-local-tire-demo`,
`C:/tmp/inventory-release-repair` (feat/reverse-upc-heads-up), `C:/tmp/scanbin-boss-fastpath-v2`,
`C:/tmp/scanbin-boss-preview` (codex/boss-barcode-fastpath),
`C:/tmp/scanbin-product-readiness-20260810`, `C:/tmp/wt-lintdebt`, `C:/tmp/wt-teach-clean`.
Each pins its branch (a checked-out branch cannot be deleted). Triage the branch first, then
`git worktree remove`. The 2026-08-19 sweep already salvaged dirty diffs to
`C:/tmp/worktree-salvage-2026-08-19/<name>/`.

## Known issues / tech debt - fix, don't build on top

- **ODbL license obligation is untracked (High, from the retired risk register):** the ~4M-row
  retail corpus incorporates Open Food Facts data (ODbL: attribution + share-alike). No in-app
  attribution exists and no legal review has confirmed compatibility with a paid product. Needed
  before any paid go-live that exposes this corpus.
- **Master-catalog global trust has no revocation path:** one bad strong write replays globally to
  every tenant; dispute/tombstone is designed, not built. Owner decision + build approval needed.
- Old Vercel deployments stay publicly reachable at their unique URLs indefinitely; purge/expire
  policy undecided.
- `docs/GO_LIVE_CHECKLIST.md` is stale vs live truth (predates the PR #21/#24 cutover).
- A BOM character was found in the `NEXT_PUBLIC_AUTH_MODE` Vercel env value; strip it before it
  causes a string-comparison bug in auth-mode branching.
- `post-deploy-smoke.yml` still needs `ref: github.sha` hardening.
- Backup/recovery: VERIFIED 2026-08-07 (restore drill passed; weekly Sunday backup live, 28-day
  retention; see `docs/RECOVERY.md`, F-08 CLOSED).
- F-01/F-07 Firestore rules/indexes redeploy pending, owner-gated.
- `src/eval/eval.test.ts` still writes its mock-eval table to the deleted
  `docs/decode/eval-baseline.md` path (harmless, resurrects the file untracked); retarget in a code
  round.
- `src/services/decode/{index.ts,contract.ts,README.md}` comments cite the deleted
  `docs/decode/ARCHITECTURE.md`; repoint to `docs/DECODER_ARCHITECTURE.md` in a code round.
- `/api/health` rate-limit key from `x-forwarded-for` is client-spoofable; each allowed hit does a
  real Firestore+Turso read (low cost, follow-up hardening).
- `computeDollarVariance` drops reconcile lines whose `unitCost` is keyed by name-only identity
  from the dollar total; documented degradation, revisit.
- Scan feedback panel omits running quantity during "Looking up..."; cosmetic.
- `npm audit`: next 16.2.12 applied (7 CVEs closed); remaining majors need planned upgrades (sharp,
  exceljs - do NOT take the suggested downgrade blindly, firebase-admin storage chain, unused).
  See `docs/superpowers/reports/2026-07-29-npm-audit-triage.md`.
- backfill `--execute` against PRODUCTION is owner-gated and not yet run; legacy docs may still
  carry `disputedBy`/`auditLog` on public parents until it runs.
- `tireKnowledge.generated.json` (71 MB) is not LFS-tracked while the retail twin is; fixing it is
  a history rewrite on master, owner-gated.
