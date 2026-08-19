# Consolidation map (2026-08-19)

Audit of `master` @ 6f65039c plus the rebased `refactor/pre-aws-cleanup` (now
`chore/consolidation-2026-08-19`). Five read-only audits (money path, src duplication, scripts and
configs, docs and repo shape, rebase forecast) fed this map. Each item names its proof.

Scope rule: behavior is preserved unless an item is a verified contradiction or bug. Prefer deletion
over new abstraction. Anything not listed below was judged "leave alone" on purpose.

## A. Must fix (verified contradictions, money path, data integrity)

| # | Finding | Fix | Proof |
|---|---|---|---|
| A1 | Legacy `mode:"lookup"` in `/api/ai-lookup` charges two cap slots before any work (a `provider:"mock"` POST pays for nothing) and is the last live paid Gemini surface, contradicting "Gemini is out of decode". Its only client (`scanStore.lookupUnknown`) has no UI caller. | Delete the legacy mode, its route-level charge block, `selectProvider`/`lookupChain`, `geminiProvider`/`openaiProvider`, `lookupUnknown`, and the legacy-only tests. Unknown `mode` -> 400 `unsupported_mode`. | route + store tests, `proof:all` |
| A2 | `decode_cache` on Turso never stores `sourceTier`, so `pipeline.ts` "a free title must not overwrite a paid identity" is inverted in production (the file backend keeps it). | Additive `source_tier` column (idempotent `ALTER TABLE`), written and read on Turso. Rollback = ignore the column. | `decodeCacheStore.test.ts` fake Turso client |
| A3 | A daily-cap block during paid ESCALATION discards the free suggestion already in hand (and the Plan D stash on the total-miss branch) and answers `cap_blocked`. Contradicts "free resolution is never blocked" and "always attach the best available identity". | Cap denial inside the escalation branch keeps the free suggestion (reason recorded, pay-once marker NOT set); total-miss branch falls back to the Plan D stash; `cap_blocked` only when nothing free exists. | `pipeline.test.ts` new cases |
| A4 | `ENABLE_LIVE_AI_LOOKUP=false` is reported to the client but not enforced on the server: a direct POST still runs paid rungs. Preview lockdown relies on key removal. | `paidWorkPossible()` returns false when the flag is `"false"` (one place decides paid eligibility). | `paidWorkPossible.test.ts` |
| A5 | CI did not run `npm run proof:all` while `proof-all.mjs` claimed CI set its knobs; master's `proof-all.mjs` also listed 11 suites that only exist on the branch. | CI runs `proof:all` with the documented knobs, no browser install (owner 2026-08-19: fast PR gate). Node:test suites that need gitignored `backups/` data self-skip visibly instead of throwing. | CI run on the PR |
| A6 | `displayName.ts` and `productDedup.ts` use two different regexes for the legacy `UPC <code> - name` prefix (en dash accepted by one, not the other): a product renders clean but is skipped by identifier backfill. | One shared matcher. | unit tests |

## B. Safe consolidation (proven-unused or byte-duplicate)

- Dead modules: `src/components/HistoryView.tsx` (+test; the history page is `app/(app)/history`),
  `src/services/ai/{sizeRace,asinVerify,fallbackRunner,groundedSpecFinder,flashLiteGrounding}.ts`
  (+tests), `runDecode` in `decodeOrchestrator.ts`, the permanently disabled Gemini grounding arm in
  `pipeline.ts`/`parallelResolve.ts`, `trustedExact{Authorization,Membership}Cache.ts` (unwired,
  kept in history at `backup/pre-aws-cleanup-2026-08-19`), `@playwright/cli` devDependency,
  the 5 leftover `scripts/tmp-*.mjs` whose inputs were already deleted, 13 one-off scripts with zero
  live references (one-time migrations, superseded probes).
- Reported-only env flags removed from the GET status and the settings page: `ENABLE_GEMINI_LOOKUP`,
  `ENABLE_OPENAI_LOOKUP`, `ENABLE_PREMIUM_MODEL_FALLBACK`, `AI_LOOKUP_MODE`,
  `GEMINI_*`/`OPENAI_*_MODEL` report fields, `TRUSTED_EXACT_BOSS_BUSINESS_IDS` (no longer gates
  anything), `proRecheck`/`deep` body fields. `env-manifest.json` follows.
- `FinalCountTable`/`SessionCountsTable`/`LiveScanFeed` duplicated `resolved*` display helpers ->
  `src/services/format/productDisplay.ts`.
- `correctionRecheck` no longer requires a Gemini key (it runs the decode pipeline, which never uses
  Gemini).
- Root: `archive/` (dead Supabase foundation), `proof-archive/`, `deploy-proof/` PNGs, `plans/`
  (one June file) removed or archived under `docs/archive/`; `tire_prefixes_*.csv` move to
  `data/tire-knowledge/prefixes/`; 61 MB of regenerable tire-knowledge snapshots dropped (gitignored).
- Branch blob `docs/analysis/retail-corpus-v2-2026-08-03/review.jsonl.gz` (17 MB, never pushed)
  excised from the branch history before the first push.
- Docs: stale references fixed (`docs/COMMANDS.md` teach files, `docs/README.md` index,
  `ARCHITECTURE.md` "Architecture at a Glance" pointer, spec-count claims replaced by a scope note,
  `scripts/README.md` rewritten from the real tree).

## C. Structural (navigation only)

- One-off prefix-mining scripts grouped under `scripts/prefix-mining/` with a README (outputs are
  committed; scripts kept for regeneration).
- Playwright configs stay separate: each differs in port, backend, and auth-bypass env, and those
  differences are safety-relevant (mock vs real Firebase). Documented in `docs/COMMANDS.md`.

## D. Leave alone (and why)

- `scanStore.ts` (8.9k lines): the counting law depends on call ordering inside it; 135 co-located
  tests are the safety net. Carve out pure logic opportunistically only.
- The four decode cache layers and the three cooldown clocks: each has a distinct job.
- Five tire-size parsers: identity-critical; consolidate one at a time behind tests, not in a sweep.
- Metering asymmetry (one slot for the whole paid ladder on a total free miss vs one slot per rung on
  escalation) and Fetch V2 charging before it knows it will pay: money-policy decisions for the
  owner, recorded in `docs/DECODER_ARCHITECTURE.md`, not changed here.
- `POST /api/resolve-scan` and `/api/account/export`: built, documented, not yet wired to a UI
  (customer-role gating is deferred). Not dead by intent.
- `tireKnowledge.generated.json` (71 MB) is not LFS-tracked while the retail twin is: fixing it is a
  history rewrite on master (owner-gated). Recorded in REPO_HEALTH.md.
- Open product decisions stay open: retail corpus as verified truth vs high-trust suggestion;
  tenant approvals promoting into the learned tier.
