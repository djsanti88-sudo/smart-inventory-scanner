# Progress Checkpoint

> Live status checkpoint. Update after every phase so a fresh session continues without guessing.
> The full 2026-06 phase log is archived verbatim in `docs/archive/PROGRESS_HISTORY_2026-06.md`.
> Last updated: 2026-07-12.

## 2026-07-12 free-work plan (in progress)

- Phase 0 done: LFS fix landed, branch `feat/decode-ladder-goupc` pushed to origin for the
  first time, remote tip verified against local HEAD with `git ls-remote`.
- Phase 1 cleanup underway: `reports/` untracked (kept on disk), root artifacts archived to
  `docs/archive/`, 78 `scripts/tmp-*` probe scripts archived to `scripts/archive-tmp-2026-07/`
  with a README, doc truth fixes in progress (this task).
- Phases 2 and 3 next: code health pass, then camera scan, free decode rungs, variance
  report, and CSV import, each on its own separate branch.

## Current phase

**DECODE LADDER + SIZE-MERGE FIX: BUILT AND UI-PROVEN ON PREVIEW. NOT PUSHED, NOT DEPLOYED.**

- **Branch:** `feat/decode-ladder-goupc`, 163 commits ahead of `master`, NOT pushed (push and any
  deploy are owner-gated). Working tree also carries uncommitted scratch scripts (`scripts/tmp-*`),
  proof screenshots, `mockups/`, and this docs reorganization.
- **Decode ladder (BUILT, `src/server/upc/ladder.ts`):** the route resolves an unknown code in order:
  1. Local tire corpus / decode cache (Turso + local SQLite; free, ~143ms on preview).
  2. `goupc` rung: Go-UPC API, gated to real GTIN shapes with a valid GS1 check digit.
  3. `fetchv2` rung: Fetch V2 trusted-door discovery.
  4. `gpt` rung: GPT-5.5 (`OPENAI` ladder end). First settled rung stops the ladder; every rung's
     reason is recorded and surfaced. Gemini is permanently OUT of decode (Settings labels it
     "not used for decode"). Daily AI cap charges ONLY paid rungs, never corpus/cache hits
     (`2dcf714`); cap default raised 200 -> 500 (owner authorized 2026-07-10, `456b8a7`); the cap
     counter is an atomic storage-backed increment charged inside the paid rung (fixes the
     double-billing + "cap consumed before cache read" class).
- **Size-merge + brand-family fix (2026-07-10, 4 reviewed commits `a67c490`..`1782c11`):**
  `findIdentityMerge` is size-aware via product `specsShort`/`specsFull` (corpus names are slugs, so
  sizes never appear in names); same-model-different-size tires mint distinct products instead of
  collapsing into review suggestions. `brandFamilies.ts` gained evidenced corporate families
  (Michelin owns BFGoodrich/Uniroyal-NA; Continental owns General; Goodyear owns Cooper/Dunlop-history
  per 2025 Sumitomo purchase), ending the `086699*` false prefix conflicts. scanStore passes decoded
  specs into the merge (`1782c11`).
- **Decode UX fixes (2026-07-09, 16 reviewed commits):** honest failure reasons on the feed, suggested
  identities shown on the scan page with confidence-aware "(suggested)" tag (threshold 0.8), Brand
  column on the feed, scanned Barcode column on Your counts and Needs Review (all roles), Status
  column + suggested-identity display on Your counts, prettified corpus slug names, auto-apply
  high-trust suggestions (>=0.8 or app-verified exact) to the counted row (`c232b5d`), ladder + daily
  counter exposed in Settings.
- **UI PROOF (owner-loved baseline, 2026-07-10):** preview `inventory-5tk3c3vxf`, 100 owner codes
  through the real UI: **100/100 verified, 0 review, 98s**. This is the LOVED reference build; never
  regress it. (Prior run on `inventory-8lnprljm7` had shown 40/100 with 59 size-collapse reviews and
  1 false Michelin/BFGoodrich conflict; both classes fixed above.)
- **Tire corpus:** on Turso + local SQLite; DT harvest COMPLETE 2026-07-09 (+2029 GTINs, 0-block
  crawl); weekly harvest job built, schedule = owner decision.

### Pending owner decisions (blockers for next steps)
1. **Push / deploy gate:** 163 commits are local-only. Production still runs the pre-ladder build.
   Push, PR, and any promote need explicit owner word.
2. **T9 paid backfill:** owner-gated script (`83d3d62`) for the 16 missing tire codes hits paid rungs.
3. **Access model:** preview is open access (owner decision "no login, no shop selection for now");
   the platformOwner/customer role foundation stays DEFERRED (docs/HOTFIX_FOLLOWUPS.md).
4. **Weekly DT-harvest schedule** and merging the harvest branch.

### Latest gates
- Unit suite green on the branch at each reviewed commit (vitest node+jsdom projects); tsc/eslint
  clean; Playwright bot proof through the real preview UI (screenshots `owner-100-ui-*.png`,
  `preview-scan-proof*.png`). `cloudDrainRace.store.test.ts` remains timing-flaky only under full
  parallel load (passes isolated).
- Live-provider calls happen only in owner-authorized manual runs; automated tests stay mocked.

---

## Phase history (condensed; full detail in `docs/archive/PROGRESS_HISTORY_2026-06.md`)

| When | Phase | Outcome |
|---|---|---|
| 2026-07-08..10 | Decode ladder + Go-UPC + UX + size-merge (this branch) | See current phase above |
| 2026-07-03 | Consensus cross-check decode | MERGED to master (PR #10 + #7); production NOT deployed (`vercel.json` blocks master auto-deploy) |
| 2026-07-01..02 | Count-decouple + grounding ladder + corpus lookup (Plans A-D) | Shipped to preview; grounding hallucination class closed by consensus + refusal rejection |
| 2026-06-29 | SQLite corpus + tire hotfix | Shipped |
| 2026-06-14..15 | V1 build, resolver trust hotfix, evidence verification, auto-decode, catalog + cleanup, benchmark harness, Supabase -> Firebase foundation pivot | All complete; see archive |

## Guardrails (do not violate)
- No deploy, no push, no paid/live API calls, no real-data writes without explicit owner approval.
- No keys in client code. No secrets committed. Automated tests never call live providers.
- Wrong product identity is FAILURE; Unknown is ACCEPTABLE.
