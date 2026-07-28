# Current Context (working memory)

_Last updated: 2026-07-12. Keep this current as facts change. The 2026-06 Track-1/QA-army context
this file previously held is superseded; its durable outcomes are folded in below._

> **2026-07-28 correction:** the `git.deploymentEnabled.master=false` flag cited below was removed by
> PR #21. That alone does not make deploys fire - the Vercel dashboard Git connection (Production
> Branch = `master`) is still a pending owner action. See `docs/DEPLOY_TRUTH.md` for the current state.

## 1. Branches
- `master` - has consensus cross-check decode merged (2026-07-03, PR #10 + #7). NOT deployed to
  production (`vercel.json` sets `git.deploymentEnabled.master=false`).
- `feat/decode-ladder-goupc` - **THE ACTIVE BRANCH**, 163 commits ahead of master, NOT pushed.
  Carries: decode ladder (corpus -> Go-UPC -> Fetch V2 -> GPT-5.5), Gemini removed from decode,
  atomic paid-rung-only daily cap (default 500), decode UX fixes (16 commits), size-aware identity
  merge + evidenced brand families, suggested-identity display + high-trust auto-apply.
- `benchmark-tire-db-automation` - PARKED, do NOT delete or merge (merging deletes 152k lines incl.
  the poison guard); keep the idle pipeline for later.

## 2. Current truth (must preserve)
- **Owner-loved baseline:** preview `inventory-5tk3c3vxf` at the size-merge fix, 100/100 verified /
  0 review / 98s on the 100 owner codes. Never regress it.
- **Decode ladder** lives in `src/server/upc/` (`ladder.ts`, `GoUpcProvider.ts`, `goUpcUsage.ts`,
  `storage.ts`). First settled rung stops the ladder; Go-UPC only runs for real GTINs with a valid
  check digit; per-rung reasons surface in the payload and Settings.
- **Tire corpus** on Turso + local SQLite (~$0, ~143ms on preview). DT harvest complete 2026-07-09
  (+2029 GTINs); weekly job built, schedule undecided.
- **Cap counter** charges only paid rungs, once, inside the rung, after the free corpus/cache peek
  (see LESSONS_LEARNED L12).
- Falken/Camel regression codes (all must NOT resolve to Camel): `2881-6861`, `28816861`,
  `2881 6861`, `2881/6861`, `2881\6861`, `2881_6861`, `2881.6861`, `848983012906`. The live cloud
  alias was repaired in 2026-06 and is proven by `qa:bots:live`.

## 3. Pending owner decisions
1. Push the branch / open the PR (163 commits local-only).
2. Production promotion (go-live checklist: sign-off + prod env keys + `vercel promote`).
3. T9 paid backfill of the 16 missing tire codes (owner-gated script `83d3d62`).
4. Weekly DT-harvest schedule + harvest-branch merge.
5. Access model timing: preview stays open access for now (owner decision); role foundation deferred.

## 4. Access model (platformOwner vs customer) - TARGET, not built
- **platformOwner / Santiago**: raw/clean/normalized codes, aliases, global catalog, source
  evidence, provider diagnostics, internal exports, global alias repair.
- **businessOwner / admin**: scan/count/manage shop data + product-facing info ONLY; no raw
  barcode/alias DB, no provider/AI/decode-trace/source-evidence.
- **counter**: scan/count, product-facing only. **viewer**: read-only product-facing only.
- _Current reality:_ role gating is NOT implemented; every authenticated user can see codes. This is
  the known P0 gap of the deferred data-protection foundation (docs/HOTFIX_FOLLOWUPS.md).

## 5. Standing safety rails
- No push/deploy/paid-live calls/real-data writes without explicit owner word.
- Wrong identity is FAILURE, Unknown is ACCEPTABLE; automated tests never call live providers.
- Human-bot UI proof required for resolution-path changes (docs/REVISION_GATE.md); unit green is
  not sufficient (LESSONS_LEARNED L13).
