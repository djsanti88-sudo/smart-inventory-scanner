# Progress checkpoint

This is the current local-work checkpoint. Branch/worktree truth lives in `REPO_HEALTH.md`; deployment
truth lives in `docs/DEPLOY_TRUTH.md`; the active-plan pointer lives in `docs/plans/ACTIVE.md`.

Last updated: 2026-09-08.

## Current phase

Documentation consolidation is complete locally on `chore/reorg-project-a` at recorded HEAD `c4b15958`.
The owner authorized removal and consolidation of stale Markdown. No commit, push, deployment, paid
API call, production query, or real-data mutation is part of this phase.

Completed locally in this phase:

- living documentation consolidated into explicit topic owners;
- historical plans, specs, reviews, reports, and archive material summarized in `docs/HISTORY.md` and
  removed from the working tree;
- an explicit no-active-plan state added at `docs/plans/ACTIVE.md`;
- stale references migrated to canonical docs;
- testing, recovery, progress, and repository-health documents refreshed against the current tree;
- the LM Studio RAG adapter repaired and its 125-chunk JSONL index regenerated;
- Fable 5 now uses `tools/fable5/default.toml` as its packaged default config when no root override
  exists, and writes its latest pointer to `reports/fable5/LATEST.json`;
- focused Firebase, Fable, RAG, command, link, JSON, and documentation checks passed.

Latest focused verification:

- `npm run test:firebase`: 20 files passed, 143 tests passed.
- `npm run proof:local`: TypeScript plus Vitest passed, 424 files passed and 3488 tests passed.
- `python -m unittest discover -s tools/fable5/tests -v`: 258 tests passed.
- `python -m tools.fable5 selftest`: 5 of 5 canaries detected.
- `python -m tools.fable5 doctor --json`: passed using the packaged default config.
- `python open-source-agents/test_rag_index.py`: 2 tests passed.
- `git diff --check`: passed after cleanup.
- Deleted-path sweep: no live consumers found for the removed documentation paths; remaining hits are
  intentional references to optional root `fable5.toml` overrides, test fixtures, or Git-history paths.

## Verification boundary

The owner explicitly requested focused verification instead of `npm run proof:all`. That full gate
was not run, so this documentation handoff is not a full product or release certification. Focused
results are recorded in the handoff response.

## Standing gates

- Every physical scan appears and counts exactly once; retry is not another scan.
- No deploy, push, paid/live API, production credential, or real-data action without explicit approval.
- `benchmark-tire-db-automation` stays parked.
- Historical documents and dated drafts never grant execution authority.
