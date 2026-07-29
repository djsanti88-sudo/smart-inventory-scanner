# CRIB: CSV/Import Analyst

Verified against source (not memory). Files: `src/services/reconcile/shopwareCsvAdapter.ts`,
`src/components/UniversalImportPanelContainer.tsx`, `src/components/UniversalImportPanel.tsx`,
`src/services/columnIntelligence.ts`, `src/services/importSchema.ts`,
`src/services/reconcile/identityMatcher.ts`, `src/services/reconcile/importFuzzyMatcher.ts`,
`src/services/reconcile/reconcileReport.ts`, `src/services/security/sensitiveFields.ts`,
`src/stores/scanStore.ts` (`applyUniversalImport`, `resolveUnknown`).

## Two separate import paths (do not conflate)
1. **Universal import** (the live UI path): `UniversalImportPanel.tsx` -> `readUniversalFile` ->
   `inferColumnMapping` (`columnIntelligence.ts`) -> `mapUniversalRows`/`buildImportPreview`
   (`universalImportPreview.ts`) -> `POST /api/reconcile/match` -> `applyUniversalImport` in
   `scanStore.ts`. Supports CSV, TSV, XLSX, XLS (`UploadKind`).
2. **Shop-Ware CSV adapter** (`parseShopwareCsv`, `shopwareCsvAdapter.ts`): a fixed-shape
   reconcile-report input, CSV only, own header map (`SHOPWARE_COLUMN_MAP`). Feeds
   `matchExpectedRow`/`buildReconcileReport`, NOT the universal-import apply path.

## Header mapping (`columnIntelligence.ts`)
`HEADER_SYNONYMS` gives exact matches per `ImportField` (partNumber/brand/model/size/quantity/uom/
barcode/name/category). `normalizeImportHeader` lowercases, expands `#`->" number ", `&`->" and ",
strips non-alphanumerics. Exact synonym match = tier `"high"`. Below that, `fuzzyFieldForHeader`
scores `0.6*tokenOverlap + 0.4*editSim` (or `0.9*editSim`), plus a cue-token bonus
(`FIELD_TEXT_CUES`), against `FUZZY_HEADER_THRESHOLD = 0.6` -> tier `"medium"` (UI pre-fills but
requires a one-tap confirm, `mappingMode` in `UniversalImportPanel.tsx`). Auto-map to preview only
fires when EVERY mapped field is `"high"` tier (`allHigh` check in `onFile`). Shop-Ware adapter uses
its own independent synonym list (`SHOPWARE_COLUMN_MAP`), not `HEADER_SYNONYMS`.

## Identity: barcode vs SKU vs PN
`ExpectedInventoryRow.partNumbers` is an array (primary + `alias_part_numbers` split on `[|;]`).
`matchExpectedRow` (`identityMatcher.ts`) resolution order, **PN namespaces collide across
manufacturers so a bare PN hit alone is never trusted**:
1. PN hit (`lookupByPartNumber`) -> `matched` ONLY if corroborated by brand-equal-or-family
   (`sameBrandFamily`) AND/OR exact size-token equality; multiple hits with no unique
   barcode-narrowing -> `ambiguous`. `tirePartNumberCore` (affix-stripped) hits are
   `viaAffixCore: true`, discovery-only, never outrank a base hit.
2. Identity match: exact `tireSizeToken` + brand-family + `nameTokens` Jaccard >=
   `IDENTITY_JACCARD_THRESHOLD` (0.75) + not `plusGenerationDiff` -> `matched` if exactly one
   candidate, else `ambiguous`.
3. Character-fuzzy fallback (`importFuzzyMatcher.matchImportFuzzy`) only when step 2 found zero
   candidates AND same-size candidates exist; `autoApprove: false` always.
4. No size/tire signal -> `non_tire`; otherwise -> `unmatched`.
Trust rule stated in source comments: "wrong product identity is FAILURE; unmatched/ambiguous is
ACCEPTABLE. When in doubt between matched and ambiguous, the answer is ambiguous."

## Duplicate-row handling
Shop-Ware adapter: rows are aggregated by `partNumber` (Map keyed on primary PN), summing `qty`
across duplicate/multi-location rows, unioning `aliasPartNumbers`. A non-"each" UOM on ANY
duplicate-location row flags the whole aggregate for `uomReview`.
Universal import (`applyUniversalImport` in scanStore.ts): aggregated by `aggKeyFor(rawCode)`
(canonical-GTIN-collapsed, so zero-padded EAN-13 and UPC-A of the same product share one key; PNs
are never canonicalized). A second `identitySignature` check (`uid:` / `catalog:` / `raw:brand|pn|
barcode|name`) detects a DIVERGENT collision (same raw key, different resolved product) and routes
BOTH rows to separate Needs Review entries with an honest conflict reason instead of silently
merging or dropping either quantity.

## Trust rules for imported identifiers (VERIFY, do not assume auto-verified)
`applyUniversalImport` calls `get().reopenNeedsReview(...)` for every aggregated row, then, ONLY for
rows whose preview `status === "exact"`, calls
`get().resolveUnknown(reviewId, "create_new", { origin: "human", applyToCount: true, newProduct: {...} })`.
This is the SAME code path a human clicking "Approve suggestion" uses (`origin: "human"`) — it DOES
write an approved alias and, unless `isWeakGuess` fires (accepted an evidence-less suggestion: no
brand, no gtin/upc/ean, no source URL), DOES call `upsertVerified` on the shared catalog
(scanStore.ts ~line 5025). So an exact-matched CSV row IS auto-verified/auto-approved on apply —
this is a deliberate exception to "AI suggestions never auto-verify," justified because `status:
"exact"` already passed the deterministic matcher, not an AI guess. Non-`"exact"` rows (fuzzy,
review) are queued to Needs Review only (`summary.queuedForReview`) and stay unverified until a
human resolves them there. `reject` rows never reach resolveUnknown at all
(`summary.rejected`, counted before any store write).

## The persist-stripping trap (real past defect, now fixed — verify it stays fixed)
`src/services/security/sensitiveFields.ts` originally stripped `barcode`/`gtin`/`upc`/`ean`/
`verified`/`businessId` from customer-persisted product rows via a denylist-style strip, which
broke a shop's OWN scanned barcode display and (separately) broke `verified`/`businessId` surviving
reload — both fixed by commits `13adbdd`/`4807e16`/`8e9c87b` ("a shop's own product identifiers
survive customer-level persistence" / "verified + businessId"). Current allowlists
(`CUSTOMER_SAFE_PRODUCT_FIELDS`, `CUSTOMER_SAFE_REVIEW_FIELDS`, `CUSTOMER_SAFE_SCANEVENT_FIELDS`)
now explicitly INCLUDE `primaryBarcode`/`gtin`/`upc`/`ean`/`verified`/`businessId`/`cleanCode` as a
shop's own data. `SENSITIVE_FIELDS` (the platform-only denylist: `rawScannedCode`, `aliases`,
`sourceUrls`, `providerName`, `decodeTrace`, etc.) is the reusable corpus/decode-internals list —
never the shop's own already-resolved product/review/scan-feed fields. When reviewing any
persistence or serializer change touching import-derived rows: check it uses the allowlist
(`CUSTOMER_SAFE_*`), not a denylist strip, and that CSV-derived barcodes/verified flags are not
newly excluded.

## Variance-report semantics (`reconcileReport.ts`, Shop-Ware path only)
Buckets: `variance`, `agreement`, `expected_not_counted`, `ambiguous`, `unmatched`, `non_tire`,
`uom_review`, `unparseable`. Core rule (AM-R8): a matched product NOT counted this session is
`expected_not_counted`, **never** `variance` — a partial count session must not scream fake
shrinkage for everything outside its scope. `variance`/`agreement` only exist for matched products
present in `countedByUid` (delta = counted - expectedQty; 0 = agreement). Uses
`Object.prototype.hasOwnProperty.call` (not bracket access) to avoid a corpus uid literally named
`"constructor"`/`"toString"` silently reading the inherited prototype method as a truthy "counted"
value.

## Routes to Needs Review
- `unparseable` rows (bad CSV, missing part number, unparseable/missing quantity) — reported with a
  1-based `line` number and a `reason` string, never silently dropped (`shopwareCsvAdapter.ts`).
- `uomReview` rows (UOM present and not `"each"`, case-insensitive).
- Universal import: any preview `status !== "exact"` (`fuzzy`, `review`) and any divergent-identity
  collision row.
- Shop-Ware matcher: `ambiguous` and `unmatched` statuses (never silently guessed).

## Untrusted-data handling
Both adapters treat every CSV cell as plain text (`sanitizeCell`), never as an instruction, even if
a cell literally reads "ignore previous instructions." Price/cost columns
(`SHOPWARE_COLUMN_MAP.priceCostColumns`: cost/retail/price/unit_cost/list_price/msrp) are excluded
from `raw` before anything is stored, regardless of column mapping.
