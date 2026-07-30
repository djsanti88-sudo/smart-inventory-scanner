# Branch Deletion Evidence — 2026-07-29

Evidence for the `merged` and `dead-stale` branches listed in `REPO_HEALTH.md`.
Method: `git cherry <base> <branch> | grep -c '^+'` counts unique unmerged commits
(patch-id compare, so cherry-picks/rebases that already landed count as 0, not just
same-hash matches). `af/*` branches are compared against `audit-fixes` (their real
merge target); all others against `master`. `benchmark-tire-db-automation` is
excluded entirely — PARKED, do not touch, per standing owner order.

## Table

| Branch | Category | Unique commits | Last activity | Verdict |
|---|---|---|---|---|
| docs/github-deploy-truth | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| feat/camera-scan | merged (master) | 0 | 2 weeks ago | SAFE-DELETE |
| feat/csv-import | merged (master) | 0 | 2 weeks ago | SAFE-DELETE |
| feat/decode-gpt-54-mini | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| feat/free-rungs | merged (master) | 0 | 2 weeks ago | SAFE-DELETE |
| feat/variance-report | merged (master) | 0 | 2 weeks ago | SAFE-DELETE |
| fix/deploy-tooling-hardening | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| fix/redo-round | merged (master) | 0 | 7 days ago | SAFE-DELETE |
| fix/release-stabilization | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| fix/rung-trust-and-resolve-stamp | merged (master) | 0 | 4 days ago | SAFE-DELETE |
| flip/vercel-git-enable | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| rescue/argus-cp1252 | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| rescue/phase3-followups | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| rescue/qafix | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| rescue/teach-bot | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| worktree-agent-a47380b0deaa5e8d2 | merged (master) | 0 | 2 days ago | SAFE-DELETE |
| af/01-scan-ledger | merged-into-audit-fixes | 0 | 5 hours ago | SAFE-DELETE |
| af/02-api-auth | merged-into-audit-fixes | 0 | 5 hours ago | SAFE-DELETE |
| af/03-turso-promote | merged-into-audit-fixes | 0 | 5 hours ago | SAFE-DELETE |
| af/04-corpus-provenance | merged-into-audit-fixes | 0 | 8 hours ago | SAFE-DELETE |
| af/05-firestore-infra | merged-into-audit-fixes | 0 | 5 hours ago | SAFE-DELETE |
| af/06-release-ci | merged-into-audit-fixes | 0 | 4 hours ago | SAFE-DELETE |
| af/07-platform-tooling | merged-into-audit-fixes | 0 | 4 hours ago | SAFE-DELETE |
| demo-readiness-vercel-partnumber | dead-stale | 0 | 6 weeks ago | SAFE-DELETE |
| fix/exact-code-evidence-verification | dead-stale | 0 | 5 weeks ago | SAFE-DELETE |
| test | dead-stale | 0 | 4 weeks ago | SAFE-DELETE |
| add-claude-github-actions-1784520958618 | dead-stale | 2 | 10 days ago | REVIEW |
| feat/reverse-upc-heads-up | dead-stale | 1 | 4 weeks ago | REVIEW |
| fix/qa-report-2026-07-15 | dead-stale | 8 | 2 weeks ago | REVIEW |
| strategy-bots-track2 | dead-stale | 1 | 6 weeks ago | REVIEW |
| benchmark-tire-db-automation | dead-stale | — (not evaluated) | — | PARKED — do not touch |

**af/* note:** the 7 `af/01`-`af/07` sub-branches are fully contained in `audit-fixes`
(0 unique commits each), which is itself unmerged into master (+22/-0, local-only,
`origin/audit-fixes` is `[gone]`). Deleting the `af/*` branches loses nothing today,
but do it only after `audit-fixes` itself is pushed/PR'd/landed per REPO_HEALTH.md
CRITICAL #1 — otherwise there is no remaining ref carrying that work if `audit-fixes`
is later reworked from scratch.

## REVIEW branches — unique commits (first 5, oldest-first)

**add-claude-github-actions-1784520958618** (2 unique per cherry; 3 shown by `git log`,
1 is a cherry-picked duplicate already in master):
```
36c237fb "Claude Code Review workflow"
d29d1ccd "Claude PR Assistant workflow"
e1579654 docs: add Full Tool Arsenal rule to CLAUDE.md (owner standing order)
```

**feat/reverse-upc-heads-up** (1 unique commit):
```
c66a06b9 feat(review): surface shop reverse-UPC conflict warning
```

**fix/qa-report-2026-07-15** (8 unique commits, first 5 shown):
```
bece7c44 docs(qa): QA fix round report + gate results (8 fixes + 1 regression fix)
f21d77aa fix(role): scope QA Task 6 local-runtime override to persist only, restore customer UI gating (QA regression)
8265b848 feat(resolver): review-only near-match SKU suggestion (distance<=1, single candidate, never auto-counts) (QA Task 8)
43592a1b fix(csv-import): re-import refreshes existing product fields with honest copy, never adds quantity (QA Task 7)
df9e7505 fix(persist): explicit local-mode flag so open-access runtime keeps aliases + barcodes across reload (QA Task 6)
```

**strategy-bots-track2** (1 unique commit):
```
181412ef Track 2: strategy bots (marketing, ROI, pricing, competition, buyer, monetization)
```

## Proposed `git branch -D` command list (SAFE-DELETE set — for owner approval, NOT executed)

```bash
# merged into master (16)
git branch -D docs/github-deploy-truth
git branch -D feat/camera-scan
git branch -D feat/csv-import
git branch -D feat/decode-gpt-54-mini
git branch -D feat/free-rungs
git branch -D feat/variance-report
git branch -D fix/deploy-tooling-hardening
git branch -D fix/redo-round
git branch -D fix/release-stabilization
git branch -D fix/rung-trust-and-resolve-stamp
git branch -D flip/vercel-git-enable
git branch -D rescue/argus-cp1252
git branch -D rescue/phase3-followups
git branch -D rescue/qafix
git branch -D rescue/teach-bot
git branch -D worktree-agent-a47380b0deaa5e8d2

# merged into audit-fixes (7) — hold until audit-fixes itself is pushed/PR'd/landed
git branch -D af/01-scan-ledger
git branch -D af/02-api-auth
git branch -D af/03-turso-promote
git branch -D af/04-corpus-provenance
git branch -D af/05-firestore-infra
git branch -D af/06-release-ci
git branch -D af/07-platform-tooling

# dead-stale, 0 unique commits (3)
git branch -D demo-readiness-vercel-partnumber
git branch -D fix/exact-code-evidence-verification
git branch -D test
```

Note: several of these branches have active `.claude/worktrees/*` or `C:/tmp/*`
worktrees attached (per REPO_HEALTH.md); `git branch -D` will refuse to delete a
branch checked out in a worktree until `git worktree remove` runs first.

## EXECUTED — 2026-07-29 22:21 CDT (Agent F8, owner-approved, local-only, no push)

Ran `git worktree list` immediately before deletion to re-check for conflicts, then
re-verified each candidate with `git cherry master <branch> | grep -c '^+'` right
before deleting it, per the owner's explicit rule: never delete a branch checked out
in a worktree.

Result: **all 16 "merged into master" branches, plus `demo-readiness-vercel-partnumber`,
had an active worktree attached** (`C:/tmp/wt-*`, `C:/tmp/inventory-*`, or
`.claude/worktrees/agent-a47380b0deaa5e8d2`) and were **SKIPPED** — not touched, per
rule. The 7 `af/*` branches were held per standing instruction (wait for `audit-fixes`
to land). Only 2 of the ~19 SAFE-DELETE branches were both cherry-clean and
worktree-free at execution time:

```bash
git branch -D fix/exact-code-evidence-verification   # 0 unique commits vs master, no worktree — DELETED
git branch -D test                                    # 0 unique commits vs master, no worktree — DELETED
```

Deleted:
1. `fix/exact-code-evidence-verification` (was `243ca442`) — 0 unique commits, no worktree.
2. `test` (was `68cccc65`) — 0 unique commits, no worktree.

Skipped (worktree conflict, held for owner to remove worktree first, then re-verify
and delete):
- `docs/github-deploy-truth` (`C:/tmp/wt-ci`)
- `feat/camera-scan` (`C:/tmp/wt-camera`)
- `feat/csv-import` (`C:/tmp/wt-csv`)
- `feat/decode-gpt-54-mini` (`C:/tmp/wt-54mini`)
- `feat/free-rungs` (`C:/tmp/wt-rungs`)
- `feat/variance-report` (`C:/tmp/wt-variance`)
- `fix/deploy-tooling-hardening` (`C:/tmp/wt-master-cert`)
- `fix/redo-round` (`C:/tmp/wt-round2`)
- `fix/release-stabilization` (`C:/tmp/inventory-stabilization`)
- `fix/rung-trust-and-resolve-stamp` (`C:/Users/djsan/inventory-wt-diag`)
- `flip/vercel-git-enable` (`C:/tmp/wt-flip`)
- `rescue/argus-cp1252` (`C:/tmp/wt-argus-fix`)
- `rescue/phase3-followups` (`C:/tmp/wt-p3-follow`)
- `rescue/qafix` (`C:/tmp/wt-qafix`)
- `rescue/teach-bot` (`C:/tmp/wt-rescue-teach`)
- `worktree-agent-a47380b0deaa5e8d2` (`.claude/worktrees/agent-a47380b0deaa5e8d2`)
- `demo-readiness-vercel-partnumber` (`C:/tmp/inventory-demo`)

Held per standing instruction (not attempted): `af/01-scan-ledger` through
`af/07-platform-tooling` (wait for `audit-fixes` to land),
`benchmark-tire-db-automation` (PARKED), the 4 REVIEW branches, `audit-fixes`,
`chore/docs-consolidation`, `master`.

No worktree conflicts were force-resolved and no worktrees were removed — the owner
did not authorize `git worktree remove` in this task, only branch deletion for
worktree-free branches.

## FOLLOW-UP EXECUTED — 2026-07-29 (Agent F8b, owner-approved, local-only, no push)

The owner authorized `git worktree remove` for this follow-up. Processed each of the
17 branches held above: found its worktree path (`git worktree list`), ran a dirty
check (`git -C <path> status --porcelain`), and only removed the worktree + deleted
the branch when it was completely clean.

**11 removed** (worktree clean → `git worktree remove` → re-verified
`git cherry master <branch>` = 0 unique → `git branch -D`):

| Branch | Worktree | Notes |
|---|---|---|
| docs/github-deploy-truth | C:/tmp/wt-ci | clean removal |
| feat/camera-scan | C:/tmp/wt-camera | clean removal |
| feat/csv-import | C:/tmp/wt-csv | `git worktree remove` errored `Invalid argument` deleting the dir on Windows but unregistered it; leftover dir confirmed empty of git metadata and removed with `rm -rf` |
| feat/decode-gpt-54-mini | C:/tmp/wt-54mini | clean removal |
| feat/free-rungs | C:/tmp/wt-rungs | same `Invalid argument` leftover-dir pattern as wt-csv; `rm -rf` after unregister confirmed |
| feat/variance-report | C:/tmp/wt-variance | same `Invalid argument` leftover-dir pattern; `rm -rf` after unregister confirmed |
| fix/deploy-tooling-hardening | C:/tmp/wt-master-cert | clean removal |
| fix/redo-round | C:/tmp/wt-round2 | clean removal |
| flip/vercel-git-enable | C:/tmp/wt-flip | same `Invalid argument` leftover-dir pattern; left `prunable` in `git worktree list` until `git worktree prune` ran, then `git branch -D` succeeded |
| rescue/phase3-followups | C:/tmp/wt-p3-follow | `git worktree remove` errored `Invalid argument`; leftover dir removed with `rm -rf` |
| rescue/qafix | C:/tmp/wt-qafix | clean removal |

**6 skipped-dirty** (worktree left untouched, branch NOT deleted, held for owner):

| Branch | Worktree | Dirty files (first 5) |
|---|---|---|
| fix/release-stabilization | C:/tmp/inventory-stabilization | `?? .powercells/`, `?? e2e/qa-powercell.spec.ts`, `?? scripts/antigravity-qa-runner.mjs`, `?? scripts/qa-runner.mjs` |
| fix/rung-trust-and-resolve-stamp | C:/Users/djsan/inventory-wt-diag | ` M .superpowers/sdd/progress.md` |
| rescue/argus-cp1252 | C:/tmp/wt-argus-fix | `?? dev/` |
| rescue/teach-bot | C:/tmp/wt-rescue-teach | 30 modified files: ` M e2e/auto-count-tire.spec.ts`, ` M e2e/auto-decode.spec.ts`, ` M e2e/auto-verify.spec.ts`, ` M e2e/batch-approve.spec.ts`, ` M e2e/count-always.spec.ts`, plus `testing/app-knowledge/*` |
| worktree-agent-a47380b0deaa5e8d2 | C:/Users/djsan/inventory/.claude/worktrees/agent-a47380b0deaa5e8d2 | ` M src/app/api/ai-lookup/route.ts`, ` M src/app/api/catalog-dispute/route.ts`, ` M src/app/api/catalog-review/[id]/route.ts`, ` M src/app/api/catalog-review/route.ts`, ` M src/services/security/aiSpendGuard.test.ts` |
| demo-readiness-vercel-partnumber | C:/tmp/inventory-demo | Staged/untracked QA-bot proof artifacts under `reports/agent-bots/latest/*`, `reports/demo-readiness/*`, `reports/human-bots/latest/*`, `reports/platform-security/*` (many `A`/`AM`/`AD` entries) |

Not touched (per rule, unchanged from the first pass): the main working tree,
`benchmark-tire-db-automation`, `audit-fixes`, `chore/docs-consolidation`, `master`,
`af/01-scan-ledger` through `af/07-platform-tooling`, and the 4 REVIEW branches.

`git worktree prune` ran at the end of this pass; no other worktrees were affected.

**Running tally:** 13 branches removed total across both passes (2 from the first
pass + 11 from this follow-up), 6 branches skipped-dirty and still held, 7 `af/*`
branches still held pending `audit-fixes` landing, 4 REVIEW branches still held
pending manual review, `benchmark-tire-db-automation` still parked.
