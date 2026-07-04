# Task 6 Report: Ladder probe script (mock self-test)

## Status: DONE (mock-mode only; no live calls made)

## Files created
- `scripts/tmp-ladder-dryrun.mts` — the 3-stage ladder probe (Gemini guess -> cheap fetch-verify via
  real production modules -> gpt-5.5 boost), with `LADDER_MOCK=1` self-test mode.

## Wiring decisions (deviations from the brief's literal starting code)

1. **`detectCodeType` import path.** The brief's placeholder path
   `../src/services/codeType` does not exist. `grep -r "export function detectCodeType" src/`
   resolved it to `src/services/codeTypeDetector.ts`. Fixed the import to
   `../src/services/codeTypeDetector`.

2. **Real `CodeType` values (critical fix).** `src/types.ts` defines the `CodeType` union as
   `"upc_a" | "ean_13" | "gtin_14" | "numeric_sku" | "alpha_sku" | "vendor_label" | "messy" | "empty"`.
   The brief's placeholder "public barcode" allowlist (`["upc","ean","gtin","gtin14","barcode"]`)
   used values that never occur in the real union — with that list the `verified` branch would
   never fire on any real code. Replaced it with a `PUBLIC_BARCODE_TYPES = ["upc_a","ean_13","gtin_14"]`
   constant used in both stage-2 and stage-3 verified checks. Confirmed against `verifyEvidence`'s
   signature (`src/services/ai/evidenceVerifier.ts`), which also types its `codeType` param as
   `CodeType` — no other string shape is legal anywhere in this chain.

3. **Removed the placeholder `extraUrlsFirst` line.** The brief's own comment flagged this as
   "not a real param." `enrichWithPageFetch`'s actual signature (`src/services/ai/pageFetch.ts:244`)
   only accepts `code, codeType, extraUrls, maxPages, fetchImpl, signal, extract, corroborate`. The
   probe's stage-2 call now passes only `code, codeType, extraUrls, maxPages, fetchImpl` — no cast,
   no placeholder key.

4. **`selectBarcodeUrls` wiring.** `enrichWithPageFetch` builds its own candidate URL list
   internally from the OLD 5-host `barcodeDbUrls(code)` and merges it with whatever is passed as
   `extraUrls` (`uniq([...extraUrls, ...barcodeDbUrls(code)]).slice(0, maxPages)`). To actually
   exercise the new tiered pool (`selectBarcodeUrls`, up to 15 hosts across us/intl/case/generic
   tiers), stage 2 now builds
   `combinedUrls = [...new Set([...g.sourceUrls.slice(0,4), ...selectBarcodeUrls(code)])]`
   and passes that as `extraUrls`, with `maxPages: 8` capping the total fetched, per the brief.
   The mock run's `stage.fetch.pages` value of `8` for the verified row confirms the tiered pool
   (not just the old 5-host list) is what actually gets fetched and capped.

5. **`verifyAsinPage` deps shape** matches the real signature exactly
   (`deps?: { fetchImpl?: FetchImpl; signal?: AbortSignal }`) — no change needed from the brief.

6. **Output shape.** Per the brief's "Produces" contract
   (`{ spent, rows: [...] }`), the write now uses `JSON.stringify({ spent, rows: results }, null, 2)`
   for both mock and live output files (the brief's literal code used a `results` key in the object
   but `rows` in prose/Task-8 contract — used `rows` to match what Task 8's grader reads).

## detectCodeType / CodeType resolution (explicit, since the brief called it out as required)

- Real module: `src/services/codeTypeDetector.ts`, exporting `detectCodeType(code: string): CodeType`.
- Real `CodeType` union (`src/types.ts:32-40`): `upc_a`, `ean_13`, `gtin_14`, `numeric_sku`,
  `alpha_sku`, `vendor_label`, `messy`, `empty`.
- Consumers that also key off these exact strings and were checked for consistency:
  `evidenceVerifier.ts` (`verifyEvidence(code, codeType, ...)`), `decode.ts`'s public-barcode
  gate (`isPublicBarcodeType`-style checks reference the same union). The probe's
  `PUBLIC_BARCODE_TYPES` list mirrors the real "public barcode" shapes (upc_a/ean_13/gtin_14) —
  `numeric_sku`, `alpha_sku`, `vendor_label`, `messy`, `empty` are all correctly excluded from
  auto-verify, matching production's "never auto-verify a non-barcode shape" rule.

## Import chain check (tsx / `@/` alias)

Traced every import reachable from the 5 consumed modules before writing the script:
`pageFetch.ts` -> `provider.ts` (-> `snippetCap.ts`), `evidenceVerifier.ts`, `decode.ts`
(-> `crossCheckEngine.ts`, `evidenceVerifier.ts`, `tireSpecs.ts`, `tirePrefixLookup.ts` ->
`tirePrefixHints.ts`), `tireSpecs.ts`, `crossCheckEngine.ts`; `asinVerify.ts` -> `pageFetch.ts`;
`barcodeSources.ts` (no internal imports); `codeTypeDetector.ts` (type-only import from
`@/types`). None import `next/*`, `react`, or anything DOM/browser-only. tsx (v4.23.0, esbuild
under the hood) resolved every `@/*` alias against `tsconfig.json`'s `paths` with zero errors —
not blocked.

## Mock self-test run (LADDER_MOCK=1, $0, no live calls)

Command: `$env:LADDER_MOCK='1'; npx tsx scripts/tmp-ladder-dryrun.mts`

```
[upcEan] 078742028477 -> verified "Member's Mark Purified Water 40 pack 16.9 oz" | expected verified-ok | $0.000 | 0.0s | spent $0.00
[fnsku] X00MOCK111 -> suggested "Mock FNSKU product" | expected suggest-only | $0.000 | 0.0s | spent $0.00
[canary] 749000000010 -> suggested "Imaginary Thing" | expected must-refuse | $0.000 | 0.0s | spent $0.00
MOCK SELF-TEST PASS
```
Exit code: 0 (confirmed via `$LASTEXITCODE` in the same PowerShell invocation).

Inspected the written `tmp-ladder-mock-results.json` (deleted after inspection, per "no stray
build artifacts" cleanup — it is a generated temp file, not part of the deliverable) to confirm
the REAL modules actually ran, not a shortcut:
- `codeType` for `078742028477` = `"upc_a"` (real `detectCodeType`), for `X00MOCK111` =
  `"vendor_label"` (real vendor-label regex correctly classified the 10-char X0-prefixed code).
- `stage.fetch.strength` = `"fetched_source"` and `stage.fetch.pages` = `8` for the verified row —
  proves `enrichWithPageFetch` actually fetched the tiered URL pool (capped at maxPages=8) and
  `EvidenceVerifier` (`verifyEvidence`) returned real `fetched_source` strength from the mock HTML,
  not a hardcoded value.
- `stage.fetch.product` = `"Member's Mark Purified Water 40 pack 16.9 oz"` — pulled from the real
  `extractTitleProduct()` HTML-title heuristic in `pageFetch.ts`, exactly matching the mock page's
  `<title>` tag, not the AI's guess text ("Purified Water 40 Pack") — proving the fetch-verify
  stage's product identity is independent of the Gemini guess, as designed.
- `X00MOCK111` never entered the ASIN short-circuit path (`stage.asin` absent) because
  `looksLikeAsin` correctly requires a `B0` prefix, not `X0` — the real regex, not a stub.
- `stage.agreeWithGemini` = `false` on the verified row — the real `crossCheck` engine's jaccard
  token-overlap logic did not consider "Purified Water 40 Pack" vs "Member's Mark Purified Water
  40 pack 16.9 oz" a strict "agree" (this is a real algorithmic result, not a bug in the probe —
  the probe records whatever `crossCheck` actually decides).

## TypeScript check (extra self-review beyond the brief's requirements)

Ran a scratch `tsconfig` extending the project's real `tsconfig.json` (same `strict`, same `@/*`
paths) with the probe file plus all of `src/**/*.ts` included, then `npx tsc --noEmit`. Zero
errors reported against `scripts/tmp-ladder-dryrun.mts` or any file in its import chain. (Scripts
dir is normally excluded from the project's `tsconfig.json`, so this ad hoc check exceeds the
brief's own bar — done because tsx's esbuild transform only strips types, it does not
type-check, and I wanted real proof the types line up, not just "it ran.")

## Concerns

1. **The mock self-test's "must-refuse" case never actually reaches the `outcome: "refused"`
   branch.** `mockGemini` always returns a non-empty `productName` ("Imaginary Thing") for any
   code that isn't the two special-cased ones, so `best` is never empty for the canary code, and
   the self-test's own assertion is only `by["749000000010"] !== "verified"` (true, since it's
   `"suggested"`) — it does not assert `=== "refused"`. This is exactly the code given in the
   brief (I did not alter this behavior), so the `refused` outcome branch (`best` empty) is
   implemented and reachable in principle but is NOT exercised by this specific 3-code mock set.
   Flagging per instructions rather than silently "fixing" the brief's own fixture design — if a
   true refuse-path proof is wanted, a 4th mock code whose `mockGemini` branch returns an empty
   `productName` would be needed, but that's a scope change from what was specified.
2. Live path code (`geminiGuess`, `gpt55Guess`) was not executed or smoke-tested in this task, per
   the "NO live API calls in this task" instruction — it is wired but unproven until Task 9 (owner-
   authorized live run).
3. `.env.local` was not present in this environment (checked: `readFileSync` failed silently as
   designed, falling back to `process.env`), so `GEMINI_KEY`/`OPENAI_KEY` are empty strings here.
   This has zero effect on the mock self-test and is expected/fine per the task instructions.

## Proof type
- Automated proof: mock self-test (`LADDER_MOCK=1`), exit code 0, all three outcome branches
  (`verified`, `suggested` x2) confirmed routing through the real `enrichWithPageFetch` +
  `EvidenceVerifier` + `crossCheck` + `detectCodeType` modules (inspected the written JSON, not
  just the console PASS line).
- No live proof (explicitly out of scope for this task).
- No manual/browser proof needed (no UI surface).

## Not pushed
Per instructions, nothing was pushed. Local commit only, on branch `feat/option-b-dryrun`.
