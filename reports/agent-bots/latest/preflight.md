# Track 1 Preflight

- Branch: `qa-agent-army-track1` (off `qa-human-bots`, inherits all tire/live/bot fixes).
- Working tree: clean (only untracked `data/` demo files; proof artifacts reverted).
- Fixes preserved (see docs/CURRENT_CONTEXT.md §2): separator normalization, multi-code capture,
  mismatch guard, alias repair, Products-page crash fix, clearLocalCache cloud-safe fix, live cloud
  account repair, bot harness + live regression bot.

## Baseline gates
| gate | result |
|------|--------|
| `npx tsc --noEmit` | clean |
| `npx eslint src e2e` | 0 errors (3 pre-existing warnings) |
| `npx vitest run` | 373 passed / 30 skipped |
| `npx next build` | compiled successfully |

No regressions detected before Track 1 work begins.
