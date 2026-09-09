# Repository health

This is a local checkout snapshot, not remote or deployment truth. Regenerate it from Git before any
branch deletion, merge, release, or cleanup decision.

Last refreshed: 2026-09-08.

## Current checkout

- Branch: `chore/reorg-project-a`
- HEAD at refresh: `c4b15958`
- Working tree: intentionally dirty with the owner-requested documentation consolidation plus
  pre-existing `.vscode/settings.json` and `fable5.cmd` changes. The removed root `fable5.toml`
  was replaced by `tools/fable5/default.toml` as Fable 5's packaged default config.
- Remote synchronization: not verified in this documentation pass.
- Local inventory at refresh: 22 branches and 9 worktrees.

These counts are observations, not cleanup permission. Re-run `git status`, `git branch -vv`, and
`git worktree list` before acting.

## Protected state

- `benchmark-tire-db-automation` remains parked. Do not delete or merge it without a new owner order.
- Dirty or untracked work in any worktree belongs to its owner until proven otherwise.
- A branch with unique commits, backups, generated corpora, repair inputs, or active consumers needs
  an exact manifest and recovery proof before deletion.
- Never infer GitHub, CI, Vercel, Firebase, or Turso state from local Git alone.

## Release relationship

`master` is the production branch and merging or pushing to it deploys production. Follow
`docs/DEPLOY_TRUTH.md`; every such action remains owner-gated. This snapshot does not certify the
current remote `master`, branch protection, deployment revision, or production data.

## Known maintenance

- The current workflow-folder reorganization requires path-keyed test/config consumers to stay
  synchronized. `npm run proof:all` remains the final full-project guard and was skipped by explicit
  owner request during this documentation handoff.
- Historical branch tables and audit reports were removed from the working tree; Git preserves them.
- The local RAG index was regenerated as 125 valid JSONL chunks; its LM Studio adapter regression
  tests pass.
- Focused local proof on this cleanup passed `npm run test:firebase`, `npm run proof:local`,
  `python -m unittest discover -s tools/fable5/tests -v`, `python -m tools.fable5 selftest`,
  `python -m tools.fable5 doctor --json`, `python open-source-agents/test_rag_index.py`, and
  `git diff --check`.
