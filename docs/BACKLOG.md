Refreshed 2026-07-29

# Backlog (current-state, 2026-07-29)

> **The $150/mo roadmap is now the priority ordering.** For sequenced, owner-approved next work, use
> `docs/superpowers/plans/2026-07-29-product-readiness-master-plan.md` first - it supersedes this list
> for prioritization. This file stays as the secondary, lower-level punch list of hygiene and
> code-health items that plan doesn't itemize individually.

Re-grounded against the repo on 2026-07-29 (`REPO_HEALTH.md`, `PROGRESS.md`, `docs/RECOVERY.md`,
git history). Roughly half of the 2026-07-12 version of this list was already done; the rest is
verified still open below. Execution order and proof rules follow `ENGINEERING_DOCTRINE.md`. Nothing
here is approved to run yet; the owner picks items.

## Removed from the old plan (wrong or already done)

- ~~Move off OneDrive~~ - the repo already lives at `C:\Users\djsan\inventory`, local, non-synced.
- ~~Rewrite README~~ - done 2026-07-12 (commit cf23841).
- ~~Consolidate 24 root docs into docs/archive/~~ - done 2026-07-12 (cf23841 + b74215c).
- ~~Review the "trust the AI + fast" decode brain~~ - obsolete; ladder v2 with strict evidence
  gates replaced that architecture (see `docs/DECODER_ARCHITECTURE.md`).
- ~~Secrets hygiene check~~ - verified 2026-07-12: `.env.local` and `firestore-debug.log` are
  untracked; `.gitignore` covers `.env*`.

## TIER 0 - protect the work (done 2026-07-29)

- ~~Back up / push `feat/decode-ladder-goupc`~~ - **DONE**: that branch no longer exists locally or
  remotely; its content is long since merged into `master` (the ladder v2 architecture is now the
  live decode pipeline per `docs/DECODER_ARCHITECTURE.md`).
- ~~Restore `.gitattributes`~~ - **DONE**: verified present with `* text=auto eol=lf`, CRLF exceptions
  for `.ps1/.bat/.cmd`, binary rules for `.png/.webp/.pdf/.db/.gz`, and the LFS rule for
  `src/server/retail-knowledge/retailKnowledge.generated.json`.

## TIER 1 - foundation and hygiene (low risk, high leverage)

- ~~Firebase doc-vs-reality~~ - **DONE**: `CLAUDE.md`/`AGENTS.md` now accurately state Firebase
  Auth/Firestore is wired (mock-default, opt-in emulator/prod modes).
- ~~Untrack `reports/`~~ - **DONE**: 0 files under `reports/` are tracked by git.
- ~~Root artifact sweep~~ - **DONE**: no stray root `.png` files are tracked; the old proof-PNG/report
  clutter is gone.
- [ ] **scripts/ sweep**: 25 `tmp-*` files still present under `scripts/` (verified 2026-07-29, down
  from the original 78 but not zero). Archive the historically valuable ones (benchmark result JSONs)
  into `docs/archive/`, delete the rest, add a one-line `scripts/README.md` listing the living scripts.
- [ ] **Delete strays**: root `auth` and `auth-wal` (both still present, 0-byte, verified 2026-07-29).
  Low risk, low priority.
- [ ] **Branch + worktree pruning**: superseded as an ongoing tracked item by `REPO_HEALTH.md`, which
  now maintains the live branch inventory (44 local branches as of 2026-07-29) and worktree list with
  per-branch recommendations. Treat `REPO_HEALTH.md` as the source of truth for this item going
  forward rather than re-deriving it here; still propose-only, no deletion without per-branch owner
  approval. `benchmark-tire-db-automation` stays PARKED - do not touch.
- [ ] **data/ snapshot audit**: `data/tire-knowledge/` is still ~119MB of tracked CSVs/HTML (verified
  2026-07-29). Keep live corpus files, archive/delete old snapshots - owner call (data deletion gate).

## TIER 2 - code health

- [ ] **Split `scanStore.ts`**: now **7,368 lines** (verified 2026-07-29, grew from 4,511 in
  2026-07-12 rather than shrinking). Core store / actions / auto-count gate rules split is still
  needed and now higher-value than before.
- ~~Split `app/api/ai-lookup/route.ts`~~ - **substantially improved**: now 588 lines (was 1,097 in
  2026-07-12); the real decode orchestration already lives in `src/server/decode/pipeline.ts`
  (`runDecodePipeline`) per `CLAUDE.md`. Remaining thinning is optional polish, not a blocker.
- [x] **Remove dead code**: `autoAcceptVerifiedDecodes` (types.ts + defaults; gated nothing) - done
  2026-07-12.
- ~~Deprecate `decodeOrchestrator.ts`~~ - **DONE**: `CLAUDE.md` confirms it is types-only/deprecated,
  superseded by the ladder in `src/server/decode/pipeline.ts`.
- [ ] **Archive `geminiProvider.ts`**: `src/services/ai/geminiProvider.ts` still exists on disk
  (verified 2026-07-29) even though `GEMINI_DECODE_DISABLED = true` permanently gates it out of
  decode. Low priority - it survives intentionally for legacy lookup/correction re-check per
  `CLAUDE.md`; only archive if that legacy path is also retired.
- [ ] **Add missing unit tests**: `fetchV2/scoring.ts`, `fetchV2/siblingGuard.ts`,
      `fetchV2/index.ts`, `tire/tirePrefixHints.ts` - not re-verified this pass; treat as still open.
- [ ] **Full proof run**: `npm run proof:full` + `npm run test:e2e` + `npm run qa:bots` before any
      push decision - now a standing, repeatable gate (`npm run qa:revision` runs the full handoff
      gate in one command) rather than a one-time TIER 2 task.
- [ ] **Dependency review**: `npm audit` (re-run 2026-07-29) currently reports **13 vulnerabilities
      (1 low, 8 moderate, 4 high)**, concentrated in `firebase-admin`'s `@google-cloud/storage` /
      `retry-request` transitive chain. Needs a scoped review before `npm audit fix --force` (which
      would pull breaking changes) - owner call on timing given `firebase-admin` is load-bearing.

## TIER 3 - product gates (owner decisions)

- [ ] **Role gating P0**: not reverified this pass; the original concern (every authenticated user
      can see raw codes/aliases) predates production auth mode going live (`NEXT_PUBLIC_AUTH_MODE=live`,
      verified 2026-07-29 - see `docs/GO_LIVE_CHECKLIST.md`), which makes this more relevant now, not
      less. Keep open and prioritize a fresh check.
- [ ] **Production promotion**: still open. See `docs/GO_LIVE_CHECKLIST.md` "Open - owner-gated" for
      the current exact remaining steps (restore drill, F-01/F-07 redeploy, Vercel dashboard
      Git-connect, uptime monitor, data cleanup).
- [ ] **T9 paid backfill** of the 16 missing tire codes (owner-gated script 83d3d62) - not reverified,
      treat as still open.
- [ ] **Weekly DT-harvest schedule** + harvest-branch merge decision - still an open owner decision
      per project memory.
- ~~Firebase Phase 2 completion~~ - **DONE**: `CLAUDE.md` confirms accounts, tenancy derivation, and
      the two-DB model are complete (not greenfield); production auth mode is verified live.

## TIER 4 - lock it in

- ~~CI on GitHub~~ - **DONE**: `docs/DEPLOY_TRUTH.md` confirms branch protection + 5 required checks
      (typecheck, unit-tests, build, lint, Mock E2E) are live on `master`, `strict: true`,
      `enforce_admins: true`.
- [ ] **Knowledge-data relocation**: `src/server/knowledge.generated.db` (365MB) +
      `knowledge.generated.db.gz` (136MB) are still present under `src/server/` (verified 2026-07-29).
      Turso is confirmed live as the runtime source (project memory: "Tire DB SHIPPED... Turso live,
      4.13M rows"), so this is now mostly a repo-bloat cleanup rather than a runtime-risk item - verify
      Vercel runtime dependency is fully off the local file before moving/deleting anything.

## Definition of done (every item)

Branch + proof (build/test/E2E output + screenshots where UI) + `PROGRESS.md` updated + no
destructive action without explicit owner approval (deletion items above are flagged).
