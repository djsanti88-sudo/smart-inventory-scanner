# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> History: `docs/archive/PROGRESS_HISTORY_2026-07_2026-08.md` (2026-07-08 to 2026-08-19, verbatim)
> and `docs/archive/PROGRESS_HISTORY_2026-06.md`. Branch/worktree truth: `REPO_HEALTH.md`.
> Last updated: 2026-08-21.

## Current phase

**Navigation/isolation train + no-candidate abolition SHIPPED.** `master` = `828b74ce` (PR #43 +
PR #44), merged 2026-08-21, both auto-deployed to production, smoke green.

What PR #43 shipped (`fix/navigation-sync-account-isolation`):

- Business context stays mounted across History/Reconcile/Settings/Scan navigation (double-bootstrap
  reload glitch gone); pending local data survives stale cloud snapshots; per-UID and per-business
  persistence isolation with a same-browser A-B-A Firebase emulator proof; product sync ordering,
  payload-versioned idempotency, and durable review decisions hardened; unresolved History rows count.
- Review follow-ups landed on the same train: a server-side `decisionUpdatedAt` clock in the
  `SAVE_UNKNOWN_SCAN` transaction (a retried stale decision can never overwrite a newer one), a
  narrowed `countsFromTimeline` filter (conflict/quantity-less events stay out of archived-session
  tables), and the two-account e2e seed made run-relative (it was a wall-clock time bomb).

What PR #44 shipped (`chore/abolish-no-result-receipts`, owner ruling 2026-08-20 in DECISIONS.md):

- ALL negative-result decode memory is abolished: no `no_result_receipt` rows (kind narrowed to
  `result`, legacy rows read back as a miss), no L1 miss TTL (successes-only cache; in-flight map
  still coalesces concurrent scans), no Go-UPC 30-day miss cache (LadderStorage seam pruned).
- Production data cleaned with owner approval: 91 receipt rows deleted from Turso `decode_cache`
  (458 result rows untouched, via `scripts/purge-decode-cache-receipts.mjs`), `goupc_miss_cache`
  table (409 rows) dropped.
- A failed decode stores NOTHING; every rescan re-runs the full ladder; the ladder's own cost gates
  still bound spend and every real egress is metered. Never rebuild negative memory (GUARDRAILS.md).

Earlier this cycle: PR #40/#41 consolidation (one decode mode, Gemini deleted, cap never discards a
free identity, `source_tier` on Turso, CI runs proof:all) and PR #42 root-docs refresh - history in
`docs/archive/PROGRESS_HISTORY_2026-07_2026-08.md`.

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
