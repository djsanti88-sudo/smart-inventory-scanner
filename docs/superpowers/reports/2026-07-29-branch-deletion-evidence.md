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
