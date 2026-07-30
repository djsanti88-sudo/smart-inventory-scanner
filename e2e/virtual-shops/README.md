# Virtual Shops Harness

Four always-on, mock-only virtual "shops" that exercise Scanbin the way real different shops would,
day after day, and log every piece of friction they hit. Design doc:
`docs/superpowers/specs/2026-07-29-virtual-shops-design.md` (read that first for the full per-shop
spec: goal, daily loop, data sources, success metrics).

Not a replacement for the human-bot QA fleet (`e2e/human-bots/`) or Teach Bot (`e2e/teach/`, learns
the LIVE deployed app). Virtual shops are deterministic, repeatable, mock-backend load/behavior
simulators that build a long-running friction and confidence record per shop archetype.

## Hard rules (never relaxed, matching Teach Bot / Fable 5 manual drivers)

- **Mock-only, always.** No `TEACH_ALLOW_LIVE_DECODE`, no real API keys, no `playwright.teach.config.ts`,
  no production/preview URL. Any observed live `/api/ai-lookup` POST reaching a real provider during a
  virtual-shops run is a blocking safety incident.
- **Port 3500, hard-enforced.** `e2e/persona-drive.mjs` owns 3400, `e2e/stress-drive.mjs` owns 3400,
  `playwright.bots.config.ts` owns 3300. Virtual shops get the next slot, **3500**, and every driver
  must hard-throw off-localhost or off-3500 the same way those two already do (see
  `drivers/_shared.mjs` `validateLocalTarget`). Port 3500 is not yet reserved in `docs/COMMANDS.md` -
  that's design-doc build task 1, someone else's lane; don't add it here.
- **New files only, this round.** This directory (fixtures, `shops.config.mjs`, this README) and the
  sibling `drivers/` directory (built in the same wave by a different agent) are additive. No existing
  file outside `e2e/virtual-shops/` was touched to produce any of this.
- **No live Playwright runs from the fixture layer.** `generate-fixtures.mjs` is a plain Node script
  (SQLite read + file writes) - it never launches a browser. The drivers under `drivers/` are the
  Playwright pieces; they point at an already-running mock-backend dev server on port 3500 (not spawned
  by this round's work - the launcher/controller is design-doc task in the future "commands to add"
  list).

## What's in this directory

```
e2e/virtual-shops/
  fixtures/
    generate-fixtures.mjs            <- run this to (re)produce every fixture below
    rincon-tire.json                 <- { known: [...], unknown: [...] }  (~800 real tire SKUs)
    rincon-tire.meta.json            <- generation provenance + the size-merge group list
    quickfix-auto.json               <- { items: [...] }  (150 mixed retail items)
    quickfix-auto.meta.json          <- generation provenance
    quickfix-auto-error-injection.json  <- reference typo/double-scan/interrupt table (see "Known gaps")
    legacy-tires-level5.csv          <- the ugly legacy spreadsheet (via e2e/teach/sheets.mjs)
    legacy-tires-ground-truth.json   <- book vs physical counts + exact seeded dollar variance
    night-shift-scan-sequence.json   <- offline/refresh/retry-storm phase sequence, 3 simulated days
  shops.config.mjs                   <- the 4 shop persona configs (fixture paths + behavior knobs)
  drivers/                           <- Playwright drivers (built by a sibling wave-2 agent)
    _shared.mjs, rincon-tire.mjs, quickfix-auto.mjs, legacy-tires.mjs, night-shift.mjs
  README.md                          <- this file
```

## How the pieces fit together

1. **`fixtures/generate-fixtures.mjs`** is the only thing in this round that touches a data source. It
   is a plain, dependency-light Node ESM script - no Playwright, no network. Run it any time to
   regenerate every fixture:

   ```
   node e2e/virtual-shops/fixtures/generate-fixtures.mjs
   ```

   It is **deterministic**: every "random" choice is a seeded PRNG (mulberry32, same algorithm as
   `drivers/_shared.mjs`'s `createSeededRandom` and `e2e/teach/sheets.mjs`'s `seededRng`) or a pure
   function of stable inputs - never `Math.random()`, never `Date.now()` in any output value. Re-running
   it against an unchanged corpus DB reproduces byte-identical files (verified: sha256 of every fixture
   file matched across two consecutive runs during this round's build).

2. **Fixtures are generated but checked in.** The design doc calls for this explicitly ("fixtures are
   generated but committed for determinism") so every shop's inventory is stable and reviewable, not
   regenerated per CI run. All 8 generated files total **~429 KB** (largest is `rincon-tire.json` at
   ~323 KB), each comfortably under the ~500 KB per-file budget.

3. **`shops.config.mjs`** is the single source of truth mapping each shop key to its fixture paths,
   behavior knobs, success metrics, and report directory. It is pure config (no filesystem writes, no
   Playwright). A future combined "run all 4 shops" command (design doc task 10) is the intended first
   real importer.

4. **Drivers** (the daily-loop Playwright simulations, per shop) were built concurrently by a sibling
   agent this same wave: `drivers/rincon-tire.mjs`, `drivers/quickfix-auto.mjs`, `drivers/legacy-tires.mjs`,
   and `drivers/night-shift.mjs` all now exist. Because fixtures and drivers were built in parallel,
   contract alignment varies per shop - see "Known gaps" below for exactly which fixtures each driver
   currently reads versus generates/reuses on its own. Every driver:
   - loads fixture file(s) where wired up (`loadFixtureWithFallback` in `drivers/_shared.mjs` falls back
     to a small built-in fixture if the file is missing or not yet consumed, so a driver stays runnable
     standalone even mid-build),
   - drives the mock backend on `http://localhost:3500` only,
   - asserts the TOP-LEVEL LAW after every scan (`assertLawHolds`: scan N = count N, always),
   - writes friction events + `report.json`/`report.md` into `reports/virtual-shops/<shop>/<runId>/`
     (gitignored via the repo's blanket `/reports/` rule - no per-shop `.gitignore` entry needed).

## Fixture contracts (exact shapes consumed today)

`drivers/rincon-tire.mjs` and `drivers/quickfix-auto.mjs` already hardcode the fixture paths and read
these exact shapes (their `FALLBACK_FIXTURE` constants document the contract precisely):

- **`rincon-tire.json`**: `{ known: [{ code, label, brand, model, size, groupKey,
  sizeMergeGroupMember, canonicalProductUid, ... }], unknown: [codeString, ...] }`. The driver cycles
  `known[index % known.length].code` for the day's scans and takes the first two `unknown[]` entries
  daily. Extra fields beyond `code`/`label` are additive - the current driver ignores them; they exist
  for a future revision that wants to assert size-merge behavior directly (pair up entries sharing a
  `groupKey`, scan both, assert two distinct product rows).
- **`quickfix-auto.json`**: `{ items: [{ code, label, sku, category, brand, unitPrice, qtyOnHand }] }`.
  The driver cycles `items[index % items.length].code`.
- **`legacy-tires-level5.csv`** / **`legacy-tires-ground-truth.json`**: `drivers/legacy-tires.mjs` (built
  concurrently this same wave) does not read either file yet - it calls `generateShopwareCsv` from
  `e2e/teach/sheets.mjs` directly at runtime to build its own reconcile-target CSV. The ground-truth
  file's `perProduct[]` (exact book quantity, physical/scan-plan quantity, dollar delta per product,
  `totalDollarVariance`, `narrative`) remains available for a future revision that wants a pre-committed,
  reviewable variance target instead of a runtime-generated one - same pattern as the QuickFix Auto gap
  below.
- **`night-shift-scan-sequence.json`**: `drivers/night-shift.mjs` (built concurrently this same wave)
  reads `tools/fable5/fixtures/stress-codes.json` directly and does not consume this file either. This
  fixture's phased structure (`offline-burst` with explicit codes, `refresh-mid-session`, `reconnect`,
  `retry-storm`, each with an `expected` block) stays available for a future revision that wants the
  richer multi-day phase/expectation contract instead of the driver's current single-pass flow.

## Known gaps / honest limitations (do not silently paper over these)

- **`quickfix-auto-error-injection.json` is not consumed yet.** The design doc asks for "an
  error-injection table (typo positions, double-scan pairs, interrupt points) checked into the fixture
  so runs are reproducible." `drivers/quickfix-auto.mjs` (built by the sibling driver-owning agent this
  same wave) instead computes its own error class per scan slot **at runtime** via a seeded RNG and
  CLI-tunable rates (`--typo-rate`, `--double-scan-rate`, `--interrupt-rate`, `--seed`) - which is also
  fully deterministic and reproducible, just not driven by this pre-committed table. Both approaches
  satisfy "reproducible"; they simply diverge on where the seed lives. This file exists as (1) the
  design-doc-literal artifact and (2) a ready-made input if a future revision prefers a reviewable,
  diffable error pattern over runtime-only randomness. Flagged here rather than silently discarded.
- **Legacy Tires' duplicate-row ground truth carries a documented assumption.** The generator injects
  one exact-duplicate CSV row (to exercise "duplicated rows" ugliness) but computes the ground-truth
  book quantity as if the importer collapses an exact duplicate to a single quantity (never drops it,
  never sums it again). See `duplicateRowAssumption` inside `legacy-tires-ground-truth.json` - verify
  this against the real import path before trusting the exact dollar variance in a demo.
- **Rincon Tire's ~800-row pull excludes rows with a blank `brand_normalized`/`model_normalized`/`size`**
  (there is a large "" / "" group in the corpus - 510 rows with no brand/model - deliberately skipped
  since a shop's inventory of literally-unbranded ghost SKUs isn't a realistic fixture).
- **QuickFix Auto's ~150 items are curated, not pulled from `src/server/retail-knowledge/`.** That
  corpus (`retailKnowledge.generated.json`, ~259 MB) is OpenFoodFacts-shaped grocery/consumer-goods data
  (mostly European food products) - it does not cover automotive shop-supply SKUs (oil filters,
  batteries, wiper blades). The design doc anticipates exactly this ("or a curated static fixture if the
  retail corpus does not cover the SKUs needed"), so `generate-fixtures.mjs` procedurally builds a
  deterministic 20-category x 20-brand catalog with valid UPC-A check digits instead.
- **No `npm run virtual-shops` command yet.** Per the design doc's "Launch model" section, that
  (plus the dev-server-spawning controller) is future work, not built this round.

## Regenerating fixtures after a corpus update

`rincon-tire.json` is pulled from `src/server/knowledge.generated.db` (read-only). If that corpus DB is
rebuilt (`npm run build:knowledge-db`), re-run `node e2e/virtual-shops/fixtures/generate-fixtures.mjs`
and diff-review the new `rincon-tire.json` / `rincon-tire.meta.json` before committing - the fixture is
checked in for determinism, not auto-regenerated by any test run or CI job.
