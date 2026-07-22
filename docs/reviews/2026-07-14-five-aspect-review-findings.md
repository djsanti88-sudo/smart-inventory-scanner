# Five-Aspect Review Findings (2026-07-14)

> Read-only review, branch `feat/decode-ladder-goupc`. NOTHING here is built yet.
> Owner order: save ALL findings for a later master plan. Ranked per aspect, most severe first.
> Review method: orchestrator deep-read of the ladder + 4 read-only subagent reviews.

## Aspect 1: Decode ladder (orchestrator deep-read of pipeline.ts / ladder.ts / gtin.ts / aiSpendGuard.ts / decodeCache.ts / decodeCacheStore.ts)

| # | Sev | Finding | Where | Fix direction |
|---|-----|---------|-------|---------------|
| L1 | HIGH | `no_result_receipt` permanently masks corpus growth: L2 receipt replay happens BEFORE the free corpus peek inside computeDecode; receipts have `createdAt` but no expiry/invalidation. Weekly DT-harvest corpus additions can never heal frozen codes (only manual forceRetry). | pipeline.ts:263 vs :405; decodeCacheStore.ts (no TTL) | Run the $0 corpus/retail exact peek BEFORE replaying a receipt, or TTL receipts / invalidate on corpus import |
| L2 | HIGH | No total ladder deadline. Rung timeouts exist (FetchV2 25s, page 8s) but nothing bounds the SUM (Plan D + 2 free rungs + Go-UPC + FetchV2 + GPT sequential). The one budget check is dead code: `runGpt` calls `maybeGptLadder({ timedOut: false })` hardcoded. | pipeline.ts:772 | Request-scoped deadline checked before each rung starts; longer-term async job model |
| L3 | HIGH | Concurrent scans of the same unknown code double-spend: `withDecodeCache` has no in-flight coalescing (cache set only after compute). Both requests charge a cap slot, both crawl FetchV2, both can call GPT. Only Go-UPC is deduped (GoUpcGate). Cap check itself is read-then-increment (non-atomic check). | decodeCache.ts:64-77; pipeline.ts:820-826 | In-flight promise map keyed by canonical code inside withDecodeCache |
| L4 | MED (owner call) | A free-rung SUGGESTION blocks a paid VERIFICATION: "first settled rung stops" treats a UPCitemdb needs_review suggestion as equal to a Go-UPC exact verified match. Saves ~$0.01, costs a human review row. Biggest verified-rate lever for non-corpus codes. | pipeline.ts:589-605 | Opt-in "escalate past suggestions" mode: free suggestion -> still try Go-UPC; keep suggestion as fallback |
| L5 | MED | No UPC-E expansion: `isGtinShaped` accepts 8 digits, but UPC-E check digit computes over the EXPANDED UPC-A; unexpanded UPC-E fails the gate or misses every GTIN DB. Camera scan can emit UPC-E. | services/upc/gtin.ts | Pure UPC-E->UPC-A expansion function in the gate |
| L6 | MED | Cap slots burn on $0 "paid" phases: slot charged before knowing whether any paid rung can run (no keys configured -> brocade + pattern URLs + GPT skip still eats a slot). | pipeline.ts:820-826 | Charge only when a genuinely paid rung is about to execute |
| L7 | LOW | Observability thin: `latencyMs: 0` hardcoded for upcitemdb/OFF/go-upc statuses; no per-rung cost in debug; no aggregated rung hit-rate/cost metrics; rung order static (no category-aware ordering). | pipeline.ts rung status blocks | Real latency stamps + a rung-metrics rollup |
| L8 | LOW | Free rungs run sequentially; UPCitemdb + OFF (+ retail peek) are independent HTTP lookups. | pipeline.ts:801-802 | Run free rungs concurrently |

## Aspect 2: Size-aware identity merge (subagent)

| # | Sev | Finding | Where | Fix direction |
|---|-----|---------|-------|---------------|
| M1 | HIGH | Asymmetric-size auto-link: GTIN match + only ONE side has tire size -> `tireSizeAgrees` true -> auto_link (generic no-specs product collapses with fully-specced decode). | identityMerge.ts:140-150 | Require both sides sized for auto_link; downgrade to suggest_link on asymmetry |
| M2 | HIGH | Brand normalization inconsistent across modules: identityMerge `normBrand()` does NOT strip tire/tyre/inc/co suffixes; brandPrefixGeneral + brandFamilies DO. "General Tire" = "general tire" vs "general". Merge and firewall can disagree. | identityMerge.ts:54 vs brandPrefixGeneral.ts:16, brandFamilies.ts:60 | One shared normalizer |
| M3 | HIGH | Hercules missing from Goodyear family (present in KNOWN_TIRE_BRANDS) -> same false-conflict class as the original Michelin/BFGoodrich defect. | brandFamilies.ts:25-32 | Add hercules to the Goodyear family |
| M4 | MED | Zero non-tire merge tests: all 15 cases are tires; fuzzy brand+name collapse for retail/auto-parts untested (e.g. two different Dorman parts with high Jaccard). | identityMerge.test.ts | Add non-tire high-overlap test cases |
| M5 | MED | No doc of deliberately-independent brands (Pirelli, Yokohama, Nokian, Kumho, Nexen, ...) vs FAMILIES; maintenance risk both directions. | brandFamilies.ts:24-53 | Comment block + evidence threshold for adding families |
| M6 | LOW | Fuzzy path allows asymmetric size (blocks only when BOTH sized AND disagree) - probably intentional (suggest-only) but undocumented. | identityMerge.ts:158 | Comment the asymmetry rationale |

## Aspect 3: Owner-loved baseline regression protection (subagent)

Protections that EXIST: benchmarks/phase1_100_codes.csv + scripts/benchmark-decodes.ts (manual), src/eval/eval.test.ts (HARD invariant: 0% false auto-count), per-defect regression tests (identityMerge.test.ts, scanStore.decodeCap.test.ts, poisonGuard.store.test.ts, ladder.test.ts, evidenceVerifier.test.ts), docs/REVISION_GATE.md, scripts/weekly-accuracy.ts (manual, spend-capped), scripts/verify-live-scans.ts, mocked Turso fallback tests.

| # | Sev | Gap | Fix direction |
|---|-----|-----|---------------|
| B1 | HIGH | No automated golden-file gate for the 100/100 baseline - benchmark is a manual script, never auto-compared to a committed snapshot; a verdict-distribution regression passes all gates. | Commit golden JSON (100 codes + expected verdicts), replay vs MOCKED rungs in `npm run test:benchmark`, fail on shift |
| B2 | HIGH | No corpus DB drift detection: Turso rows can corrupt/shrink with no failing test (regresses baseline with zero code change). | Schema validator + 10 hardcoded spot-check barcodes + row-count floor, in unit suite |
| B3 | MED | No env-var behavior gate (stale TURSO_CONNECTION_URL, leftover IS_E2E, model-name drift shift behavior silently). | One-time env assertion test in the suite |
| B4 | MED | No provider contract snapshots (Go-UPC/Firecrawl response-shape drift passes mocked tests, fails live). | Committed known-good response fixtures + shape assertions per provider |
| B5 | MED | Auto-count false-positive harness covers ONE poison code; no edge-case battery (vendor label, conflicted brand, junk source, no specs, low-conf single provider). | 10-case autoCountRegressionGuard.test.ts asserting never-auto-count + honest reason |
| B6 | LOW | No decode budget clamp regression test (clamp [5000,20000] unguarded). | 2 assertions in decodeBudget.test.ts |
| B7 | LOW | No specs-extraction regression battery from full product names. | 15 real tire names in tireSpecs.test.ts |
| B8 | LOW | No daily-cap atomicity/race test (parallel charge sum). | Mocked-storage race harness |

## Aspect 4: Free-work features (subagent)

Camera scan - verdict MINOR GAPS:
| # | Sev | Finding | Where |
|---|-----|---------|-------|
| C1 | HIGH | No HTTPS check before getUserMedia -> silent permission failure on non-HTTPS prod. | CameraScanButton.tsx:50-55 |
| C2 | MED | No torch/zoom constraints (dim warehouses). | cameraScanner.ts:33,42 |
| C3 | LOW | Mobile viewport not optimized (60vh cramped; playsInline present, no orientation handling). | CameraScanButton.tsx:131,158-165 |
Verified solid: 1.5s duplicate-frame debounce, zxing-wasm fallback + failure path, raw value preserved, refocus after close, comprehensive unit/component/E2E mocks.

Variance report - verdict SOLID:
| # | Sev | Finding | Where |
|---|-----|---------|-------|
| V1 | MED | Snapshot interfaces not readonly; stray mutation would corrupt history (no defensive copies in compute). | varianceReport.ts:6-10 |
| V2 | MED | Snapshots read finalCounts only; pending-sync scans invisibly excluded (off-by-N surprise mid-sync). | varianceSnapshot store | 
Verified solid: delta math, UTC ISO timestamps, CSV export via firewall-hardened buildCsv, 12-snapshot cap, E2E flow.

CSV import - verdict MINOR GAPS (MVP-acceptable):
| # | Sev | Finding | Where |
|---|-----|---------|-------|
| I1 | MED | `file.text()` loads entire file into memory - big CSV on a phone hangs/crashes; csv-parse streaming unused. | CsvImportPanel.tsx:144 |
| I2 | LOW | Non-transactional apply (documented; idempotency lets re-import finish remainder). | csvImport.ts:397-403 |
Verified solid: formula-injection defusal (= + - @ single-quote prefix), control-char strip + 500-char cap, content-hash idempotent import IDs (re-import = no-op), header synonyms, 1-based error lines, alias merge (no dupes), conflict detection, 39 unit tests + E2E.

## Aspect 5: Decode UX fixes (subagent) - verdict HOLDING

All four fix classes verified in code: single lazy cap charge per paid compute; honest non-nullable reasons rendered on every row (LiveScanFeed.tsx:126) incl. specific cap copy; blocking POST fixed at UX layer (synchronous count + bounded decode queue MAX_CONCURRENT_DECODES=2, burst-test proven); late/dup decode responses no-op via review.status guard.

| # | Sev | Residue | Where |
|---|-----|---------|-------|
| U1 | MED | Deprecated `checkAndIncrementDaily` still exported - future caller could resurrect double-billing. | aiSpendGuard.ts:118-162 |
| U2 | LOW | Route-level cap gate is legacy-lookup-only; asymmetry uncommented. | route.ts:230-240 |
| U3 | LOW | reasonText fallback chain could mismatch server reason if response shape drifts. | scanStore.ts:2387-2395 |
| U4 | LOW | File-storage cap adapter non-atomic RMW (documented serverless caveat). | aiSpendGuard.ts |

## Addendum (same day): ladder deep-dive round 2

See `2026-07-14-ladder-improvement-report.md` for the full ladder-focused follow-up: the PROVEN
leading-zero root cause (Z1-Z5: corpus exact-string mixed-length keys, fetchV2 missing stripped
variant, raw-code cache keys, GPT prompt literal encoding, no UPC-E expansion), GPT rung
model/prompt assessment (G1-G5), "never fully unknown" prefix-floor gaps (P1-P6), and the
new-tools research verdict. Those findings supersede/extend L1-L8 below where they overlap.

## Cross-cutting priority (for the master plan)

1. B1+B2 - golden-file baseline gate + corpus drift check (nothing fails today when the loved baseline regresses)
2. L1 - receipts mask corpus growth (weekly harvest can't heal frozen codes)
3. M1+M2+M3 - the size/brand defect class, round two
4. L3+L2 - in-flight dedup + ladder deadline (money + throughput)
5. C1+I1 - one-liner guards (HTTPS check, CSV size cap)
