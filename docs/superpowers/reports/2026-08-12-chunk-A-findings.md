# Chunk A Findings — Scan Core (2026-08-12)

Scope: `src/stores/scanStore.ts` (8,789 lines), `scanPersistStorage.ts` (798), `idbBacking.ts` (247),
`services/inventory.ts`, `inventory.replay.ts`, `resolver.ts`, `scanCleaner.ts`, `aliasMatcher.ts`.
Read-only analysis. Zero edits made.

## 1. Section map

Built via `grep -n '^export\|^function\|^const .*= ('` plus locating the returned state object
literal (avoids reading the file top to bottom).

### `src/stores/scanStore.ts` (8,789 lines)

| range | content |
|---|---|
| 1-110 | imports, `CsvImportSummary`/`CleanupBackup`/`ProductDeleteBackup` types |
| 111-259 | CSV import helpers (`parseUnitCost`, `importedRowCodes`, `applyImportedUnitCosts`), `DailyCapReachedError`, `DecodeAbortedError` |
| 260-687 | decode-gate pure helpers: `evaluateAutoDecode`, `isPlatformOwnerForGateBypass`, `applyGodGateOverride`, `tireAutoCountOk`, `honestReasonForBadge`, `decodeCorroborated` (re-export), `autoSuggestApplyOk`, token-bucket/decode-queue machinery (`makeTokenBucket`, `resetTokenBucket`, `drainDecodeQueue`, `enqueueDecode`), trust-gate helpers (`isWeakGuess`, `gateIdentityBarcodeFields`, `scrubSuggestedBarcode`, `trustedExactProbeCandidate`, `trustedExactCanonicalId`, `carriedProvisionalBarcode`, `provisionalPlaceholderName`) |
| 688-1630 | `ScanStoreDeps`, `DEFAULT_SETTINGS`, `ScanState` interface (all fields + every method signature — this is the store's full public contract), module-level pure helpers: `stampScanEventLocation`, `makeQueueItem`, `transferOrphanCount`, `pruneFinalCountsForRotation`, `buildOrphanTransferSyncOps`, `buildProductCodeAliases`, `buildAliasesForCodes`, `recomputeSyncStatus`, `idForReview`, `rescopeKey`, `rescopePlaceholderRecord`, `rescopePlaceholderQueueItem`, `buildAdoptionResyncItems` |
| 1631-2191 | `buildScanInitializer(deps)` setup: closures `clearTrustedExactProbes`, `enqueueAndSync`, `aiRequestAuth`, `syncDecodedState`, etc. (captured over `set`/`get`) |
| 2191-2243 | returned `ScanState` object's default field values |
| 2244-3163 | session/auth/hydration methods: `setHasHydrated` … `ensureAutoSession`, `refreshFromCloud`, `setLocation` |
| 3164-3744 | **`processScan`** (580 lines) — the scan intake path |
| 3745-4158 | `syncPending`, `retrySync`, `setOnline`, `setSimulateSyncFailure`, `setAiStatus`, `setEmergencyStop`, `refreshAiStatus`, `updateSettings`, `lookupUnknown`, `cloudCatalogResolve` |
| 4159-5449 | **`liveDecode` / `runLiveDecodeOnce`** (~1,290 lines) — the decode-ladder integration, evidence/auto-count gating |
| 5450-6163 | `ensureProvisionalCount` (the counting-law enforcement point), `enrichPrefixFloorLabel`, `markFeedRowVerified`, `applyDecodeFallback`, `backgroundVerifyDeep` |
| 6164-6984 | **`resolveUnknown`** (~820 lines) — human review resolution |
| 6985-7550 | `batchApprove`, `approveSuggestion`, `declineSuggestion`, `evaluateLinkMismatch`, `clearMismatchWarning`, `clearCategoryWarning`, `approveDiscoveredIdentifiers`, `clearAliasConflicts`, `unlinkAlias`, `moveAlias`, `removeFromCount`, `correctProduct`, `reopenNeedsReview`, `applyUniversalImport` |
| 7551-7822 | **`markWrong`** (~270 lines) — quantity transfer |
| 7823-8276 | `correctionRecheck`, `importProductsCsv`, `auditCsvExport`, `pendingCount`, `getProduct`, `clearSession`, `clearLocalCache`, `applyCleanupSelections`, `cleanupJunkCounts`, `undoCleanup`, `deleteProduct`, `purgePoisonedProducts`, `undoDeleteProduct`, `previewIdentifierBackfill`, `applyIdentifierBackfill`, `undoIdentifierBackfill` |
| 8277-8465 | module-level `productIdentityCodes`, `deleteProductsInternal` |
| 8541-8634 | `scanStoreMigrate` (persist-version migration) |
| 8635-8789 | `scanPersistBackingStorage`, `useScanStore` (the `create(persist(...))` call), `createTestScanStore` (test factory), `__resetGeneralDecodePacerForTest`, `__drainGeneralDecodePacerForTest` |

Natural "sections" line up closely with the brief's guess (intake / ledger-adjacent gates / needs-review
resolution / sync-drain / persistence), except the file has no ledger arithmetic of its own — that lives
in `services/inventory.ts` and is called from inside `ensureProvisionalCount`/`processScan`.

### Smaller files
- `services/inventory.ts` (95 lines): `createInventoryCount`, `applyScanEventOnce`, `incrementInventoryCount` — pure, minimal, no redundancy.
- `services/inventory.replay.ts` (27 lines): `replayLedgerCounts` — pure, minimal.
- `services/resolver.ts` (184 lines): `findNearMatchSuggestion`, `resolveScan`, `resolveRawScan`.
- `services/scanCleaner.ts` (112 lines): `cleanScanCode`, `buildNormalizedCandidates`.
- `services/aliasMatcher.ts` (295 lines): `matchAlias`, `matchProductByIdentifiers`, `collectAllIdentifierHits`, `resolveScanToProduct`, `resolveScanToProductTiered`, `needsReview`.
- `stores/idbBacking.ts` (247 lines): `openDb`, `runTx`, `runTxMulti`, `tx`, `txMulti`, `createIdbBacking`, `probeIdbBacking`.
- `stores/scanPersistStorage.ts` (798 lines): `createCoalescedFailSoftPersistStorage`, stamp encode/decode helpers, `readNewestPersistedRaw`, `createAsyncCoalescedFailSoftPersistStorage`.

## 2. Findings

| id | category | evidence | claim | change | confidence | blast radius | LOC delta |
|---|---|---|---|---|---|---|---|
| A-1 | Duplicated logic | `src/services/aliasMatcher.ts:115-121` and `:157-163` | The 5-entry `tiers` array (`primary_barcode`/`primary_sku`/`gtin`/`upc`/`ean` field pickers) is written out twice, verbatim, in `matchProductByIdentifiers` and `collectAllIdentifierHits`. Same field list, same order, same picker closures. | Hoist the array literal to a module-level `const IDENTIFIER_TIERS = [...]` above both functions; both functions reference it. This is de-duplicating a literal, not adding a layer. | proven | `npm run test:ledger` + `npx vitest run src/services/aliasMatcher.test.ts src/services/resolverTier.test.ts` | -7 |

## 3. Escalations (found, not actioned — touches counting law or would require touching a test file)

| id | note |
|---|---|
| A-E1 | `resolveScanToProduct` (`src/services/aliasMatcher.ts:185`) has **zero production callers** — `resolver.ts` calls `resolveScanToProductTiered` exclusively (confirmed by grep across `src/`, `scripts/`, excluding `.next/`). Its only callers are `src/services/aliasMatcher.test.ts` and `src/services/resolverTier.test.ts`, where it is deliberately kept as the "legacy" oracle that `resolverTier.test.ts` diffs the tiered resolver against ("matches today's resolveScanToProduct output when no master candidates are supplied"). Removing it requires editing those two test files, which brief section 2 forbids outright. Reported per section 3's dead-code protocol, not touched. |
| A-E2 | `export const decodeCorroborated = decodeCorroboratedGate;` (`scanStore.ts:385`) is a one-line re-export kept explicitly (per its own comment) because `scanStore.autocount.test.ts` imports it from `./scanStore` rather than `./scanGates`. Same shape as A-E1: the "fix" is importing from the real module in a test file, which is off-limits. Not actioned. |

## 4. Notes

- **`buildScanInitializer` / `processScan` / `liveDecode`+`runLiveDecodeOnce` / `resolveUnknown` /
  `markWrong`**: these are the five largest blocks (580, ~1,290, ~820, and ~270 lines respectively) and
  they are exactly where the TOP-LEVEL LAW, `ensureProvisionalCount` ordering, and the `markWrong`
  transfer semantics live. Every helper checked from these regions (`evaluateAutoDecode`,
  `applyGodGateOverride`, `honestReasonForBadge`, `tireAutoCountOk`, `autoSuggestApplyOk`,
  `isPlatformOwnerForGateBypass`) has 4-5 real call sites across the decode/gate paths, is documented
  with a specific historical bug it fixes, and is not a single-caller wrapper. No dead code, no
  duplicated decision logic, and no over-layering was found in these regions on the pattern-level pass
  performed (full line-by-line read of all ~3,000 lines was not attempted given the low-risk/high-cost
  tradeoff on the counting-law core — see honesty note below).
- `services/inventory.ts`, `inventory.replay.ts`, `services/scanCleaner.ts`, `stores/idbBacking.ts` were
  read in full: all are small, single-purpose, and carry no redundancy. Each function earns its place;
  several have comments documenting a specific historical defect (torn reads, non-durable IDB commits)
  that the current shape exists to prevent — removing "unnecessary-looking" branches there would
  reintroduce proven bugs.
- `stores/scanPersistStorage.ts` was spot-checked (symbol map only, not read in full) — it has the same
  dense, defect-annotated style as `idbBacking.ts` and no obvious redundancy surfaced, but it was not
  exhaustively read line-by-line; treat as "not fully audited" rather than "clean."
- **Honesty check on scale**: given the file's role (this is where the counting law lives, per the
  brief's own instruction to be conservative here), the highest-value use of analysis effort was
  confirming the hot paths are NOT bloated with dead/duplicated code rather than forcing a large finding
  count. The one proven finding (A-1) is small and outside the counting-law regions entirely. A more
  exhaustive line-by-line pass across `liveDecode`/`resolveUnknown` (~2,100 combined lines) could
  surface more, but doing that safely (i.e., without misreading gate-ordering nuance as "duplication")
  was judged to need more budget than a first-pass read allows — flagging this as an open area for a
  deeper follow-up pass rather than guessing.

## 5. Estimated total LOC removable this pass

~7 lines (A-1 only). This is a legitimately small chunk: the file is large but, on the sections actually
inspected, it earns its length — dense inline documentation of real historical bugs, not accidental
complexity. The one duplication found is real but minor.
