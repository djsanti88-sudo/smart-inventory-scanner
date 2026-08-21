# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> History: `docs/archive/PROGRESS_HISTORY_2026-07_2026-08.md` (2026-07-08 to 2026-08-19, verbatim)
> and `docs/archive/PROGRESS_HISTORY_2026-06.md`. Branch/worktree truth: `REPO_HEALTH.md`.
> Last updated: 2026-08-21.

## Current phase

**Local decoder simplification complete on `fix/simple-gpt54-decode-audit`.** The branch is
uncommitted, unpushed, and undeployed. Production remains at the previously recorded `master`
release until the owner separately approves the Git and deployment gates.

The local branch now has one decode path:

1. Tire knowledge corpus.
2. Retail knowledge corpus.
3. Platform learned products.
4. Master catalog.
5. Positive persisted and memory caches.
6. One paid GPT-5.4 mini request when every free source misses.

All other executable provider rungs, clients, provider-specific scripts, environment switches,
and current operational docs were removed. GPT suggestions remain unverified until app evidence or
human approval verifies them. Negative results are not cached, every scan still counts before
decode, and charge/cap settlement happens at actual paid egress.

Local verification completed on this branch:

- `npm run proof:all`: passed (3,482 Vitest tests passed, 99 skipped; 117 Node tests passed,
  125 local-data skips; 268 teach tests passed; import graph and orphan checks passed).
- `npm run build`: passed.
- `npm run test:ledger`: passed (40 tests).
- `npm run test:firebase`: passed (136 tests).
- Focused customer-path Playwright proof: passed (8 tests covering GPT burst coalescing, mixed-tier
  count law, current decoder UI states, decode, IndexedDB persistence, and offline retry/idempotency).

## Next (owner-gated, none performed)

1. Review and commit this branch.
2. Push/open a PR only with explicit owner approval.
3. Remove retired provider credentials from the real deployment environment and deploy only with
   explicit owner approval. The local environment manifest now rejects those keys.
4. Run authenticated production smoke and billing-console reconciliation after deployment.

## Standing hazards

- `benchmark-tire-db-automation` is PARKED - do NOT delete or merge. Standing owner order; also in
  `REPO_HEALTH.md` CRITICAL callouts.
- Merging or pushing to `master` auto-deploys production - owner-gated, every time
  (`docs/DEPLOY_TRUTH.md`).

## Guardrails (do not violate)

- No deploy, no push, no paid/live API calls, no real-data writes without explicit owner approval.
- No keys in client code. No secrets committed. Automated tests never call live providers.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE; every scan appears and counts.
