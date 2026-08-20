# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> History: `docs/archive/PROGRESS_HISTORY_2026-07_2026-08.md` (2026-07-08 to 2026-08-19, verbatim)
> and `docs/archive/PROGRESS_HISTORY_2026-06.md`. Branch/worktree truth: `REPO_HEALTH.md`.
> Last updated: 2026-08-19.

## Current phase

**Consolidation SHIPPED.** `master` = `2150c17a` (PR #40 consolidation + PR #41 e2e flake
hardening), merged 2026-08-19, auto-deployed to production, smoke green. Before that, PR #38
(best-guess identity + honest shared decode cache) and PR #39 (post-PR38 consolidation) landed the
identity-philosophy decision (DECISIONS.md 2026-08-19).

What PR #40 shipped:

- One decode mode: `/api/ai-lookup` accepts `mode:"decode"` (+ `decode-deep` alias) only; the legacy
  `mode:"lookup"` path and every Gemini module are deleted.
- A daily-cap denial never discards a free identity already in hand and never mints a pay-once
  marker for it (`paidStep` in `src/server/decode/pipeline.ts`).
- `ENABLE_LIVE_AI_LOOKUP=false` is enforced server-side (`src/server/upc/paidWorkPossible.ts`).
- Turso `decode_cache` carries `source_tier` so a free title never overwrites a paid identity.
- CI runs `npm run proof:all`; repo shape cleanup (scripts catalog, prefix-mining grouped, dead
  trees deleted; recovery tag `backup/pre-aws-cleanup-2026-08-19`).

## Next (owner decides, none started)

1. Open decisions in DECISIONS.md 2026-08-19: (a) retail corpus = truth vs high-trust suggestion;
   (b) tenant approvals promoting into the platform learned tier.
2. Deep-verify multi-variant auto-apply gap (`backgroundVerifyDeep`) - small separate PR
   (DECISIONS.md FOLLOW-UP).
3. `scanStore.ts` `canon` TEMP stub (pre-existing on master since `0570ca9e`) disables the
   canonical-GTIN orphan dedup it documents - separate ticket.
4. Branch triage: 10+ unmerged local branches listed in `REPO_HEALTH.md` - decide deliberately,
   never drive-by.
5. Tier-3 followups backlog: `docs/superpowers/plans/2026-08-09-tier3-followups.md` (items 2-9,
   plus 10 charge-settlement hardening and 11 honest cap-scope reason code).
6. Deep-review residuals (a)-(e) recorded, not fixed, in DECISIONS.md "Consolidation pass" entry.

## Standing hazards

- `benchmark-tire-db-automation` is PARKED - do NOT delete or merge (merging deletes ~152k lines
  including the poison guard). Standing owner order; also in `REPO_HEALTH.md` CRITICAL callouts.
- Merging or pushing to `master` auto-deploys production - owner-gated, every time
  (`docs/DEPLOY_TRUTH.md`).

## Guardrails (do not violate)

- No deploy, no push, no paid/live API calls, no real-data writes without explicit owner approval.
- No keys in client code. No secrets committed. Automated tests never call live providers.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE; every scan appears and counts.
