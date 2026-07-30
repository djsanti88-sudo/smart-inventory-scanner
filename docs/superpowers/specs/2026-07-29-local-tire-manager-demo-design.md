# Local Tire Manager Demo Design

**Status:** Approved by the owner on 2026-07-29

## Purpose

Build and certify the best local-only Scanbin demonstration for a manager or shop owner. The
application must run on localhost, decode tires exclusively from the checked-in local knowledge
database, and remain useful when a barcode cannot be identified. The owner will not perform any
testing: ChatGPT-controlled Chrome and rotated lower-tier agents own the complete test, fix, and
retest loop.

## Scope

- Use only tire barcodes selected from `src/server/knowledge.generated.db`.
- Certify 3,000 unique tire barcodes in 30 deterministic batches of 100.
- Run a production Next.js build locally on port 3400.
- Persist demo state only in the browser/local mock database.
- Exercise the real scan input, live feed, counts, review/correction, reload, history, report, and
  export workflows through Chrome.
- Fix confirmed product defects and repeat the affected Chrome batch.
- Produce a local evidence report and a concise manager walkthrough.

The work does not include GitHub, Vercel, cloud Firebase, cloud Turso, paid or free network decode
providers, retailer crawling, corpus enrichment, production deployment, or repository Playwright/E2E
suites.

## Safety Boundary

`SCANBIN_LOCAL_DEMO=1` is a server-only fail-closed mode. In this mode:

1. `npm run demo:local` builds and starts the app with the mock backend, auth bypass, and local-demo
   mode set explicitly.
2. Provider credentials and Turso/Firebase routing variables are removed from the child process
   environment before the build and server start.
3. A preflight requires a worktree-local `knowledge.generated.db`, verifies its SHA-256 and
   `PRAGMA quick_check`, and refuses to start when the database is absent or unreadable.
4. The decode route may resolve only an exact trusted tire-corpus barcode from that local SQLite
   database. Local-demo lookup never falls through to Turso or generated JSON.
5. A corpus miss returns an honest `needs_review` result immediately. It never proceeds to the retail
   corpus, learned catalog, cache, master catalog, UPCitemdb, Go-UPC, Fetch V2, Firecrawl, OpenAI, or
   another network/storage rung.
6. Decode-outcome telemetry, client telemetry, prefix-floor enrichment, global cloud-catalog reads,
   correction rechecks, catalog-dispute posts, paid counters, master-catalog appends, and persistent
   ladder/cache writes are disabled. Local correction still transfers quantity.
7. Vercel Speed Insights is not rendered, and the build uses local system fonts instead of
   `next/font/google`.
8. The AI-status, prefix-floor, and telemetry endpoints return inert local-demo responses without
   opening ladder storage.

The governing product law remains unchanged: every submitted physical scan appears in the live feed
and contributes one unit, even when identity resolution returns `needs_review`.

## Deterministic Dataset

The proof generator opens `src/server/knowledge.generated.db` read-only and records its SHA-256. It
selects 3,000 unique, checksum-valid UPC-A/EAN-13 tire barcodes using a fixed seed. A row is eligible
only when it has non-empty canonical product ID, brand, model, and size; is `active_retail`; is an
`auto_count_candidate`; and has `source_count >= 2`. The pinned database contains 4,873 rows that
meet this conservative predicate, so the generator has a measured safety margin. Selection is stable:

```text
SHA-256(seed + "|" + canonical_product_uid + "|" + barcode)
```

Rows are grouped so the same canonical product and valid UPC/EAN padding equivalence class cannot be
split across the sample. The manifest stores the source revision, database hash, seed, expected
identity fields, stratum, and assigned agent/batch. Existing golden codes are excluded from the
3,000-code sample and remain an independent regression set.

The sample contains ten deterministic, non-overlapping groups of 300:

- manufacturer-part-number topology: 250 repeated and 50 unique MPNs;
- winter/all-terrain identities;
- LT/flotation size forms;
- source count of at least five;
- `verified_1src_strong` confidence with at least two recorded sources;
- lower-completeness but still eligible records;
- source count exactly three;
- EAN-13;
- UPC-A;
- a remaining brand/size diversity holdout.

GTIN-14 is deliberately excluded from the 3,000 positive-decode certification: all 20 current
GTIN-14 rows have `source_count=0` and a non-zero packaging indicator. Those values receive a
separate fail-closed contract test proving they remain `needs_review`; they are never described as
verified tire-unit identities.

Invalid checksums, near matches, examples, and known conflicts form a separate adversarial set. They
do not replace any of the 3,000 valid tire rows.

## Chrome Certification

Ten distinct lower-tier agents rotate through the available worker slots. Each agent owns three
100-code batches and one primary test angle:

1. canonical identity;
2. brand/model diversity;
3. tire size/specification accuracy;
4. UPC/EAN normalization and GTIN-14 false-verified prevention;
5. scanner focus and rapid submission;
6. quantity, duplicate, and ledger invariants;
7. trust classification and false-verified prevention;
8. review, correction, reload, offline, and retry;
9. latency and long-session stability;
10. manager workflow, report, export, accessibility, and presentation clarity.

Only one agent manipulates the shared Chrome state at a time. Other active agents may analyze the
completed batch or implement disjoint fixes. Every Chrome agent:

1. launches or attaches to the localhost demo;
2. confirms the visible local-demo/offline state;
3. submits its assigned codes through the real scanner input;
4. records visible identity, status, live-feed presence, and quantities;
5. captures browser console and request evidence;
6. compares the UI outcome with the locked manifest;
7. writes its batch result and screenshots;
8. reports exact failures with barcode, expected value, observed value, and reproduction steps.

No agent may silently relabel an unresolved or wrong result as passing.

## Fix Loop

For every confirmed defect:

1. preserve the Chrome reproduction evidence;
2. add the smallest focused regression test when practical;
3. implement a root-cause fix in a disjoint file lane;
4. run the focused non-browser regression check;
5. rebuild/restart localhost;
6. rerun the failed 100-code batch in Chrome;
7. assign an independent agent to verify the repair;
8. rerun all 3,000 codes when shared decode/counting behavior changed.

Tests are never weakened or deleted to obtain a pass.

## Acceptance Criteria

The final green report requires:

- exactly 3,000 unique database tire barcodes submitted through Chrome;
- 30 complete results files containing exactly 100 inputs and 100 terminal outcomes each;
- zero incorrect verified canonical identities;
- 100% exact-corpus coverage for the eligible sample;
- every submission present in the live feed and total counted quantity equal to total submissions;
- one machine-readable, manifest/hash-bound ledger artifact per batch containing physical event IDs,
  matched product IDs, final counts, and independently replayed counts;
- replayed ledger totals and event-ID membership equal visible final counts, with zero missing,
  duplicate, or unexpected physical scan events;
- all current GTIN-14 rows are rejected from verified local-demo resolution;
- zero non-local HTTP requests, provider calls, cloud reads, cloud writes, or paid calls;
- no uncaught browser exceptions;
- warm submit-to-visible-feedback p95 at or below 250 ms and p99 at or below 500 ms;
- no count drift and no more than 20% p95 degradation between the first and final performance batch;
- review/correction transfers quantity instead of deleting it;
- reload, local offline/retry, history, report, and export workflows pass;
- the manager walkthrough passes twice after a clean local restart;
- a final local report lists the database hash, branch/commit, batch results, screenshots, defects,
  fixes, timings, and explicit READY/NOT READY verdict.

## Local Deliverables

- `npm run demo:local` one-command local production build/start.
- `scripts/local-demo-environment.mjs` fail-closed environment builder.
- `scripts/local-demo.mjs` local build/start orchestrator.
- `scripts/tire-demo-proof/` deterministic manifest, batch, and report tooling.
- `src/server/localDemo.ts` shared server-only mode helper.
- focused tests for local-demo egress blocking and deterministic batching.
- `docs/LOCAL_MANAGER_DEMO.md` manager walkthrough and reset instructions.
- generated evidence under `reports/local-tire-demo/`, kept local and uncommitted.
