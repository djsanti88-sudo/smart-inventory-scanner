# Virtual Shops Harness

Four always-on, mock-only virtual "shops" that exercise Scanbin the way real different shops would,
day after day, and log every piece of friction they hit. Design doc:
`shops.config.mjs` is the current source of truth for the per-shop
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

4. **Drivers** (the daily-loop Playwright simulations, per shop): `drivers/rincon-tire.mjs`,
   `drivers/quickfix-auto.mjs`, `drivers/legacy-tires.mjs`, and `drivers/night-shift.mjs` all now read
   their matching fixture file(s) as the primary data source, each with a documented runtime-generation
   fallback for when a fixture is missing (see "Fixture contracts" below for the exact shape each driver
   consumes). All four drivers also share the same low-level helpers from `drivers/_shared.mjs`
   (`validateLocalTarget`, `installMockAiRoute`, `loginAndReachScan`, `scanCode`, `artifactPath`,
   `ensureDir`, `delay`, `sumCsvQuantities`, ...) instead of keeping local copies. Every driver:
   - loads fixture file(s) where wired up (`loadFixtureWithFallback` in `drivers/_shared.mjs`, or an
     equivalent local loader for non-JSON fixtures like the Legacy Tires CSV, falls back to a small
     built-in fixture if the file is missing, so a driver stays runnable standalone),
   - drives the mock backend on `http://localhost:3500` only,
   - asserts the TOP-LEVEL LAW after every scan (`assertLawHolds`: scan N = count N, always),
   - writes friction events + `report.json`/`report.md` into `reports/virtual-shops/<shop>/<runId>/`
     (gitignored via the repo's blanket `/reports/` rule - no per-shop `.gitignore` entry needed).

## Fixture contracts (exact shapes consumed today)

`drivers/rincon-tire.mjs` and `drivers/quickfix-auto.mjs` hardcode the fixture paths and read these
exact shapes (their `FALLBACK_FIXTURE` constants document the contract precisely):

- **`rincon-tire.json`**: `{ known: [{ code, label, brand, model, size, groupKey,
  sizeMergeGroupMember, canonicalProductUid, ... }], unknown: [codeString, ...] }`. The driver cycles
  `known[index % known.length].code` for the day's scans and takes the first two `unknown[]` entries
  daily. Extra fields beyond `code`/`label` are additive - the current driver ignores them; they exist
  for a future revision that wants to assert size-merge behavior directly (pair up entries sharing a
  `groupKey`, scan both, assert two distinct product rows).
- **`quickfix-auto.json`**: `{ items: [{ code, label, sku, category, brand, unitPrice, qtyOnHand }] }`.
  The driver iterates the full `items[]` array once per simulated day (defaulting `--scans-per-day` to
  `items.length`); `--scans-per-day` can still truncate to a shorter debug run.
- **`quickfix-auto-error-injection.json`**: consumed. `drivers/quickfix-auto.mjs`'s `buildDayPlan()` is
  a verbatim port of `generate-fixtures.mjs`'s day-plan algorithm (same seeded mulberry32, same
  per-item roll order, same dropped/extra-digit typo construction). At the default `--seed 20260729`
  and default rates (0.08 typo / 0.1 double-scan / 0.03 interrupt, matching this file's `rates`), the
  driver's runtime-computed plan for day N is byte-for-byte identical to day N in this file. When the
  file is present and the run's seed/rates/item-count match it, the driver additionally cross-checks
  the computed plan against the committed table and logs friction if they ever diverge - the file is
  both the reference *and* a runtime regression guard on the port, not just documentation.
- **`legacy-tires-level5.csv`** / **`legacy-tires-ground-truth.json`**: consumed. `drivers/legacy-tires.mjs`
  imports the checked-in CSV directly through Universal Import (no more runtime `generateInventorySheet`
  call in the normal path), and reads `legacy-tires-ground-truth.json`'s `perProduct[]` to drive the
  scan-variance step and to generate the Reconcile records CSV (via `generateShopwareCsv`, still reused
  as-is, now fed fixture data instead of an independent hardcoded product list). See "Known gaps" below
  for the one seeded SKU (`General AltiMAX RT43`, book 9 / physical 0, no barcode) this scan-only harness
  cannot fully reproduce - documented as a runtime `limitations[]` entry in `report.json`, not faked.
  Both files still fall back to the pre-fixture runtime-generation path if either is missing/unreadable.
- **`night-shift-scan-sequence.json`**: consumed. `drivers/night-shift.mjs` now iterates this fixture's
  `days[]` (offline-burst codes, refresh-mid-session, reconnect, retry-storm with the fixture's
  `retryCount`, and each day's `expected.totalScansThisDay`), running every fixture day in the SAME
  cumulative browser session and asserting the crown invariant against the running total after the
  final day. Two dedicated unknown codes per day are still injected on top of the fixture's known-code
  burst (not part of the fixture itself) for TOP-LEVEL LAW identity-gate coverage. Falls back to a
  synthetic single-day plan built from `tools/fable5/fixtures/stress-codes.json` (the pre-fixture
  behavior) if the phased fixture is missing/unreadable.

## Known gaps / honest limitations (do not silently paper over these)

- **Legacy Tires' one unreproducible seeded SKU.** The ground truth's `expected_not_counted` case
  (`General AltiMAX RT43`: book quantity 9, seeded physical quantity 0) has no barcode in the fixture,
  so this scan-only harness can neither push its counted quantity down to 0 (scanning only adds) nor
  scan it at all (no barcode). `drivers/legacy-tires.mjs` logs this explicitly in `report.json`'s
  `limitations[]` and `report.md`'s "Known limitations for this run" section every run - it is never
  silently treated as a match. Every other SKU in the fixture (including the one over-scanned SKU) is
  fully reproducible.
- **Legacy Tires' duplicate-row ground truth carries a documented assumption.** The generator injects
  one exact-duplicate CSV row (to exercise "duplicated rows" ugliness) but computes the ground-truth
  book quantity as if the importer collapses an exact duplicate to a single quantity (never drops it,
  never sums it again). See `duplicateRowAssumption` inside `legacy-tires-ground-truth.json` - verify
  this against the real import path before trusting the exact dollar variance in a demo.
- **Rincon Tire's ~800-row pull excludes rows with a blank `brand_normalized`/`model_normalized`/`size`**
  (there is a large "" / "" group in the corpus - 510 rows with no brand/model - deliberately skipped
  since a shop's inventory of literally-unbranded ghost SKUs isn't a realistic fixture).
- **QuickFix Auto's ~150 items are curated, not pulled from `src/decoding/server/knowledge/retail/`.** That
  corpus (`retailKnowledge.generated.json`, ~259 MB) is OpenFoodFacts-shaped grocery/consumer-goods data
  (mostly European food products) - it does not cover automotive shop-supply SKUs (oil filters,
  batteries, wiper blades). The design doc anticipates exactly this ("or a curated static fixture if the
  retail corpus does not cover the SKUs needed"), so `generate-fixtures.mjs` procedurally builds a
  deterministic 20-category x 20-brand catalog with valid UPC-A check digits instead.
- **No `npm run virtual-shops` command yet.** Per the design doc's "Launch model" section, that
  (plus the dev-server-spawning controller) is future work, not built this round.

## Regenerating fixtures after a corpus update

`rincon-tire.json` is pulled from `src/decoding/server/knowledge/knowledge.generated.db` (read-only). If that corpus DB is
rebuilt (`npm run build:knowledge-db`), re-run `node e2e/virtual-shops/fixtures/generate-fixtures.mjs`
and diff-review the new `rincon-tire.json` / `rincon-tire.meta.json` before committing - the fixture is
checked in for determinism, not auto-regenerated by any test run or CI job.
