# Repo Health — sync truth

Regenerate, don't hand-drift. Last updated: 2026-07-29

## CRITICAL callouts

1. **`audit-fixes` is LOCAL-ONLY.** Its `origin/audit-fixes` upstream ref shows
   `[gone]` and `git ls-remote origin audit-fixes` returns nothing — the branch is not
   on GitHub. It carries the current audit-fixes work (22 commits ahead of master,
   7 fully-merged `af/01`-`af/07` sub-branches folded in). Needs an owner push/PR
   decision before it can be reviewed or land.
2. **`benchmark-tire-db-automation` is PARKED. Do NOT delete or merge.** It is 1,112
   commits behind master and 6 ahead; merging it would delete ~152k lines including
   the poison guard, per standing owner order. Leave it exactly as is.

## Branch inventory (44 local branches, propose-only — no deletion or push without

per-branch owner approval)

| Branch | Category | Last commit | Ahead/Behind master | Recommended action (proposal only) |
|---|---|---|---|---|
| master | active | — | — | base branch, tracks `origin/master` [behind 23] |
| audit-fixes | active | 2026-07-29 | +22 / -0 | push + open PR (see CRITICAL #1) |
| chore/docs-consolidation | active | 2026-07-29 | current | this doc-consolidation branch |
| af/01-scan-ledger | merged-into-audit-fixes | 2026-07-29 | +3 / -0 | delete once `audit-fixes` lands (content preserved there) |
| af/02-api-auth | merged-into-audit-fixes | 2026-07-29 | +3 / -0 | delete once `audit-fixes` lands |
| af/03-turso-promote | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/04-corpus-provenance | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/05-firestore-infra | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/06-release-ci | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| af/07-platform-tooling | merged-into-audit-fixes | 2026-07-29 | +2 / -0 | delete once `audit-fixes` lands |
| docs/github-deploy-truth | merged (master) | 2026-07-27 | +0 / -45 | delete, fully merged |
| feat/camera-scan | merged (master) | — | merged | delete, fully merged |
| feat/csv-import | merged (master) | — | merged | delete, fully merged |
| feat/decode-gpt-54-mini | merged (master) | — | merged | delete, fully merged |
| feat/free-rungs | merged (master) | — | merged | delete, fully merged |
| feat/variance-report | merged (master) | — | merged | delete, fully merged |
| fix/deploy-tooling-hardening | merged (master) | — | merged | delete, fully merged |
| fix/redo-round | merged (master) | — | merged | delete, fully merged |
| fix/release-stabilization | merged (master) | — | merged | delete, fully merged |
| fix/rung-trust-and-resolve-stamp | merged (master) | — | merged | delete, fully merged |
| flip/vercel-git-enable | merged (master) | — | merged | delete, fully merged |
| rescue/argus-cp1252 | merged (master) | — | merged | delete, fully merged |
| rescue/phase3-followups | merged (master) | — | merged | delete, fully merged |
| rescue/qafix | merged (master) | — | merged | delete, fully merged |
| rescue/teach-bot | merged (master) | — | merged | delete, fully merged |
| worktree-agent-a47380b0deaa5e8d2 | merged (master) | — | merged | delete, fully merged |
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
| demo-readiness-vercel-partnumber | dead-stale | 2026-06-15 | +1 / -1097 | review; delete if abandoned |
| feat/reverse-upc-heads-up | dead-stale | 2026-06-29 | +1 / -992 | review; delete if abandoned |
| fix/exact-code-evidence-verification | dead-stale | 2026-06-21 | +1 / -1067 | review; delete if abandoned |
| fix/qa-report-2026-07-15 | dead-stale | 2026-07-15 | +10 / -651 | review; delete if abandoned |
| strategy-bots-track2 | dead-stale | 2026-06-15 | +1 / -1104 | review; delete if abandoned |
| test | dead-stale | 2026-06-30 | +9 / -979 | scratch branch; review; delete if abandoned |

Category counts: 3 active, 23 merged (16 into master + 7 into `audit-fixes`),
10 valuable-unpushed, 8 dead-stale (one of which, `benchmark-tire-db-automation`,
is explicitly parked and excluded from any delete proposal).

## Known issues / tech debt — fix, don't build on top

- `GO_LIVE_CHECKLIST.md` is stale vs live truth (predates the PR #21/#24 cutover).
- A BOM character was found in the `NEXT_PUBLIC_AUTH_MODE` Vercel env value —
  strip it before it causes a string-comparison bug in auth-mode branching.
- `post-deploy-smoke.yml` still needs `ref: github.sha` hardening (pending).
- A restore drill (Firestore backup/PITR recovery proof) has never been run —
  backup/recovery readiness is unverified.
- F-01/F-07 rules/indexes redeploy is pending, owner-gated (Firestore security rules
  and composite indexes not yet pushed live).
- ~30 local worktrees exist under `C:/tmp/*` and `.claude/worktrees/*`, one per
  in-flight or already-merged branch (see `git worktree list`). Several point at
  branches already merged into master — those worktrees are reclaimable disk/clutter
  once the branch is deleted (`git worktree remove`), propose-only, no action taken.
- `src/eval/eval.test.ts` still writes its mock-eval table to the deleted `docs/decode/eval-baseline.md` path (try/catch-wrapped, harmless, but will resurrect the file untracked) - retarget the output path in a code round.
- `src/services/decode/{index.ts,contract.ts,README.md}` comments cite the deleted `docs/decode/ARCHITECTURE.md` - repoint to `docs/DECODER_ARCHITECTURE.md` in a code round.
