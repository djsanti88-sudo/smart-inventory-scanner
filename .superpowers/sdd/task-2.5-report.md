# Task 2.5 Report - Carve the pure auto-count gate out of scanStore.ts

**Branch:** feat/decode-ladder-goupc
**Scope (YAGNI):** extract ONLY the decode auto-count gate + high-trust suggestion auto-apply rule into
pure functions. Actions/sync/everything else stays in scanStore.ts. Zero behavior change.

## New module: `src/stores/scanGates.ts` (142 lines, pure - no store/React imports)

Extracted function signatures:

- `isPublicBarcodeShape(codeType: string): boolean` - the `upc_a|ean_13|gtin_14` set (was inlined 4x).
- `decodeCorroborated(decision): boolean` - app-verified exact code OR `internet_two_source_size`. Moved
  from scanStore; scanStore re-exports it (`export const decodeCorroborated = decodeCorroboratedGate`) so
  the existing `scanStore.autocount.test.ts` import from `./scanStore` keeps working unchanged.
- `canAutoCount(input: AutoCountInput): { allowed: boolean; reason: string }` - the full Phase-7 evidence
  gate (the old `evidenceGatePassed` conjunction) INCLUDING the GPT-ladder trust tier and the T20/code-1225
  public-barcode-shape firewall. `AutoCountInput = { codeType, decision, productName, productNameUsable,
  tireOk, contextConflict }`. The store computes `tireOk` (tireAutoCountOk) and `contextConflict`
  (detectScanContextConflict) with its own services and passes the booleans in, keeping the function pure.
- `shouldAutoApplySuggestion(input: AutoApplySuggestionInput): boolean` - the old `autoSuggestApplyOk`
  logic (confidence>=0.8 on a non-"verified" decode OR app-verified-exact "verified" decode; requires
  autoAddOn + usable name + no context conflict). Takes `productNameUsable` instead of a raw name.

### Behavior-equivalence note

The old `evidenceGatePassed = gptTrusted || (verified && corroborated && conf>=0.8 && usableName && tireOk
&& !contextConflict)` where `gptTrusted` shared the same 4 trailing clauses (conf/usableName/tireOk/
!conflict). `canAutoCount` factors those 4 shared clauses into early not-allowed returns, then branches on
the corroboration/gpt difference - identical boolean result. Reason strings are new (used only for
logging; the boolean `.allowed` is what gates).

## Call sites replaced (call-site-only diff in scanStore.ts)

- `src/stores/scanStore.ts:~2168` (liveDecode / `runLiveDecodeOnce`): the `gptTrusted` + `evidenceGatePassed`
  inline conjunction replaced with `canAutoCount({...}).allowed`.
- `src/stores/scanStore.ts:~2768` (backgroundVerifyDeep): the identical inline conjunction replaced with
  `canAutoCount({...}).allowed`.
- `autoSuggestApplyOk` (module-level helper, both its call sites in liveDecode + backgroundVerifyDeep
  unchanged) is now a thin wrapper that computes `productNameUsable` and delegates to
  `shouldAutoApplySuggestion`.
- scanStore.ts: 4510 -> 4475 lines (-35).

## New test: `src/stores/scanGates.test.ts` (177 lines, 25 tests)

Ports the existing gate coverage to hit the pure functions directly:
- All 4 `decodeCorroborated` cases from scanStore.autocount.test.ts + null/undefined.
- `canAutoCount`: exact-code, two-source, gpt-self-report-on-public-barcode (auto-counts), and the
  code-1225 firewall (gpt_self_report on numeric_sku/alpha_sku/vendor_label/messy REFUSED), plus each
  refusal clause (non-verified, conf<0.8, unusable name, tireOk false, context conflict).
- `shouldAutoApplySuggestion`: applies non-verified conf>=0.8 and app-verified-exact; REFUSES the
  high-confidence non-app-verified "verified" decode (T20/1225 class), autoAddOn off, conflict, etc.

The store integration tests (`scanStore.gptLadder.test.ts`, `scanStore.autocount.test.ts`, etc.) stay
unchanged as the integration lock.

## Gate results

| Gate | Command | Result |
|------|---------|--------|
| Baseline store suite | `npx vitest run src/stores` | 43 files / 234 tests PASS (before) |
| Store suite (+ new) | `npx vitest run src/stores` | 44 files / 259 tests PASS |
| Full unit suite | `npm run test` | 191 files, 1816 passed, 30 skipped PASS |
| Typecheck | `npx tsc --noEmit` | exit 0, clean |
| Data-integrity bot | `npm run qa:bots:data` | 1 passed (real UI, IS_E2E webServer) PASS |

## Protections preserved (verbatim)

- 1225 lesson: a GPT self-report on a vendor-shaped code NEVER auto-counts (public-barcode-shape gate,
  now `isPublicBarcodeShape` inside `canAutoCount` + tested).
- Wrong identity is FAILURE, Unknown is ACCEPTABLE: `canAutoCount` is a conjunction; when in doubt it
  returns `allowed: false`.
- `autoAddDecodedProducts` defaults true and remains the master gate, applied by the CALLER (not moved
  into the pure functions).

## Concerns

None. The `isPublicCode` origin-decision duplicates (`["upc_a","ean_13","gtin_14"]`) in the catalog-write
branches were left in place - they are not part of the gate and deduping them is out of this task's narrow
scope.
