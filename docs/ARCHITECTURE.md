# Architecture Map

> Verified against the code on `feat/decode-ladder-goupc`, 2026-07-19; spot-checked (file paths +
> scanStore line count) against `feat/teach-bot` on 2026-07-22, corrections applied inline. This is
> the deep companion to the "Architecture at a Glance" section in `CLAUDE.md`. If this doc and the
> code disagree, the code wins; fix this doc in the same commit.

## 1. Directory map (`src/`, top 2 levels)

```
src/
├── app/                       Next.js App Router
│   ├── (app)/                 Authenticated app shell: business, products, reconcile,
│   │                          review, scan, settings pages (route group, shared layout)
│   ├── api/
│   │   ├── ai-lookup/         GET status peek / POST decode entry point (the ladder's front door)
│   │   ├── reconcile/match/   Server-side reconcile matcher (local tire corpus only, no paid calls)
│   │   └── resolve-scan/      Server-side deterministic resolve for the customer role (Firebase)
│   └── login/                 Login page
├── components/                React "use client" components: ScannerInput, LiveScanFeed, tables,
│                              StoreHydrator, AuthGuard. Co-located .test.tsx (jsdom project).
├── eval/                      Golden-baseline eval harness (npm run test:golden)
├── lib/                       Thin glue: auth.ts, firebaseAdmin.ts, firebaseClient.ts
├── seed/                      seedData.ts - verified seed products/aliases
├── server/                    SERVER-ONLY code (never imported by client files)
│   ├── decode/pipeline.ts     THE real decode orchestrator (see section 3)
│   ├── upc/                   ladder.ts rung driver + GoUpc/UpcItemDb/OpenFoodFacts providers,
│   │                          usage counters, storage.ts (Turso/file), timeouts
│   ├── tire-knowledge/        Tire corpus index (SQLite / Turso / generated-JSON fallback)
│   ├── retail-knowledge/      ~4M-row retail barcode index (Open Food Facts derived)
│   ├── knowledgeDb.ts         better-sqlite3 opener (decompresses .db.gz on Vercel)
│   ├── decodeCacheStore.ts    L2 persistent decode cache (Turso/libsql)
│   └── learnedProducts.ts     Server-persisted "learned products" suggestion tier
├── services/                  PURE SERVICES: no React, no next/* imports (convention enforced by
│   │                          file-header comments + keySafety.test.ts + importBoundary.test.ts)
│   ├── ai/                    decode.ts (decideDecode), evidenceVerifier.ts, crossCheckEngine.ts,
│   │                          gptFromScratch.ts, gptLadderRung.ts, decodeCache.ts (L1),
│   │                          decodeOrchestrator.ts (DEPRECATED - see traps)
│   ├── catalog/               brandFamilies, brandPrefixGeneral, identityMerge, prefixFirewall,
│   │                          prefixFloor, prefixLearning, evidenceScoring, sourceTrust
│   ├── upc/                   CLIENT-SAFE half: barcodeTrust.ts (trust gate), gtin.ts, misread.ts
│   ├── db/                    syncTarget.ts interface + db/firebase/* Firestore repositories
│   ├── security/              aiSpendGuard.ts (caps/kill switch), roleAccess.ts, sensitiveFields.ts
│   ├── fetchV2/               Fetch V2 open-web discovery engine (paid ladder rung)
│   ├── reconcile/             Shop-Ware CSV adapter, identityMatcher, variance report
│   ├── inventory.ts           THE COUNT LEDGER core (applyScanEventOnce, incrementInventoryCount)
│   ├── inventory.replay.ts    replayLedgerCounts - rebuilds counts from scanFeed for proofs
│   ├── resolver.ts            Deterministic-only resolver
│   ├── scanCleaner.ts         cleanScanCode / buildNormalizedCandidates
│   ├── aliasMatcher.ts        Alias / product-identifier matching
│   └── mockDb.ts              Local mock SyncTarget (the default backend)
├── stores/                    Zustand stores (see section 4) + scanGates.ts (pure gate logic)
├── test/                      server-only-stub.ts (vitest alias for the server-only package)
└── types.ts                   Domain entities (see section 5)
```

## 2. The scan flow, end to end

1. **Buffer and submit** - `src/components/ScannerInput.tsx`. An uncontrolled DOM input (ref, not
   per-keystroke React state) so rapid scanner injection never drops characters. `submit()` reads the
   DOM value, calls `onScan(raw)` (wired to `scanStore.processScan`), clears, refocuses.
2. **Clean** - `src/services/scanCleaner.ts`. Strips invisible chars, builds an ordered list of
   normalized candidates (AIM prefix, hyphens/spaces). Raw value is always preserved.
3. **Resolve (deterministic, never AI)** - `src/services/resolver.ts` + `aliasMatcher.ts` +
   `codeTypeDetector.ts`. `known` ONLY from an approved alias or a verified product identifier.
4. **Count (synchronous, before any network)** - `src/stores/scanStore.ts` `processScan` (~line 1340):
   - Known and countable: `services/inventory.ts` `incrementInventoryCount` delegates to
     `applyScanEventOnce`; `InventoryCount.scanEventIds` dedupes so re-applying an event id is a
     no-op. `quantityDelta` (1, or 0 for non-countable rows) drives the delta.
   - Not deterministically known: `ensureProvisionalCount(cleanCode, reason)` runs synchronously
     BEFORE any decode/AI/network work. This ordering IS the enforcement of the TOP-LEVEL LAW
     (every scan appears and counts). There is no named guard function to grep for.
   - Every branch pushes the ScanEvent onto `scanFeed` (append-only; the ledger replays against it).
5. **Sync queue** - `enqueueAndSync` pushes `PendingSyncItem`s, then `syncPending()`. Two drains:
   synchronous mock drain against `mockDb.ts`, and `drainCloudOnce` (a promise-chain mutex so
   overlapping drains never race one Firestore doc) against `db/firebase/firebaseSyncTarget.ts`.
   Idempotency keys are minted once at scan time (`services/idempotency.ts`) and reused on retry.
6. **Decode dispatch (enrichment only, never a count decision)** - `liveDecode` feeds a bounded
   module-level queue (max 2 concurrent, deduped by reviewId) -> `runLiveDecodeOnce` -> gate check
   (`stores/scanGates.ts`) -> `POST /api/ai-lookup` with an AbortController budget.
7. **Approval loop** - `resolveUnknown` / `approveSuggestion` teach a permanent alias and flip
   provisional -> verified. `markWrong` (~line 4535) is a quantity TRANSFER: it deactivates the bad
   aliases, un-verifies the product, and repoints the feed events onto a fresh "Unidentified item"
   provisional through `incrementInventoryCount` again. Total physical quantity is invariant across
   an identity correction. It uses the id RETURNED by `ensureProvisionalCount`, never a re-lookup by
   barcode (that re-lookup was the D2 double-count bug, fixed in 4990687).
8. **Replay proof** - `services/inventory.replay.ts` `replayLedgerCounts` rebuilds finalCounts purely
   from scanFeed; the invariant suite proves sum(feed deltas) == finalCounts and exact scanEventIds
   set equality. Gate: `npm run test:ledger`.

## 3. The decode ladder (server side)

**The real orchestrator is `src/server/decode/pipeline.ts` (`runDecodePipeline`)**, fronted by
`src/app/api/ai-lookup/route.ts` (POST `mode: "decode"`). The rung driver `src/server/upc/ladder.ts`
is pure and framework-free: a rung returns `{settled, payload?, reason}`; the first settled rung stops
the ladder; `deadlineAt` + `perRungTimeoutMs` (AbortController) bound wall-clock (the D7 never-hang fix).

Cheapest-first order as actually wired in pipeline.ts:

| # | Stage | Where | Cost |
|---|---|---|---|
| 1 | L1 in-memory cache | `services/ai/decodeCache.ts` | free |
| 2 | Tire corpus exact hit | `server/tire-knowledge/TireKnowledgeProvider.ts` | free |
| 3 | Retail corpus (GTIN-shaped only) | `server/retail-knowledge/retailKnowledgeIndex.ts` | free |
| 4 | Learned-products tier (always `suggested`, never `verified`) | `server/learnedProducts.ts` | free |
| 5 | L2 persistent cache (re-validated against misread/example guards) | `server/decodeCacheStore.ts` | free |
| 6 | Free ladder half: `upcitemdb` -> `openfoodfacts` (GTIN + valid check digit only; own counters, never the daily cap) | `server/upc/` providers | free |
| 7 | LAZY daily-cap gate: `readDailyUsed`/`chargeDailySlot` (`services/security/aiSpendGuard.ts` via `server/upc/storage.ts`, Turso or file) - sits BETWEEN the free and paid halves | pipeline.ts ~1217-1229 | charged only here, once |
| 8 | Paid ladder half: `goupc` (GTIN-gated) -> `fetchv2` (open-web discovery) -> `gpt` | pipeline.ts ~1246+ | paid |

Gemini is hard-disabled for decode (`GEMINI_DECODE_DISABLED = true`, owner order 2026-07-06); it
survives only in the legacy `lookup` mode and the correction re-check. `GET /api/ai-lookup` reports
config booleans + `geminiUsedForDecode: false` and never leaks secrets.

**Trust and evidence chain** (all in the decode result path):

- `services/ai/evidenceVerifier.ts` - independently confirms the exact scanned code appears in real
  evidence text; provider self-claims are never trusted. Strength: none < url_only < snippet <
  grounding_chunk < fetched_source. Detects invalidating and recycled/multi-product pages.
- `services/ai/crossCheckEngine.ts` - structural comparison of two provider results:
  agree | conflict | single_provider | weak.
- `services/ai/decode.ts` `decideDecode` - final decision (verified | suggested | conflict |
  needs_review). Verified requires: public barcode shape (never X00/FNSKU/vendor/internal), strong
  app-verified evidence, non-empty identity, confidence >= 0.8.
- `services/catalog/brandPrefixGeneral.ts` `prefixBrandConflict` - ADVISORY brand-sanity signal
  (Plan C), not a hard block. `brandFamilies.ts` clears corporate siblings.
- `services/catalog/prefixFirewall.ts` `evaluatePrefixFirewall` - the evidence-weighted HARD block,
  override-aware: strong app-verified exact-code evidence clears it.
- `services/catalog/identityMerge.ts` - auto_link (canonical-GTIN equality only) vs suggest_link
  (fuzzy, SIZE-AWARE for tires) vs none, so re-decodes link instead of minting duplicates.
- `services/upc/barcodeTrust.ts` - barcode-shape trust gate (rejected | suggested | verified); only
  re-checkable GroundTruth (physical scan / app-verified evidence / corpus) can promote a verdict.

## 4. State (Zustand)

| Store | File | localStorage | Notes |
|---|---|---|---|
| scanStore | `src/stores/scanStore.ts` (~6,500 lines) | key `sis-scan-v1`, version 7 | Role-aware partialize via `scanPersist.ts` |
| reconcileStore | `src/stores/reconcileStore.ts` | own key, version 1 | Strips raw CSV field before persist |

- Migration (`scanStoreMigrate`): version < 5 hard-resets learned data to seed; >= 5 is additive only
  (structured-field backfill, countSnapshots default). Never clobbers an already-migrated install.
- Persistence goes through `scanPersistStorage.ts`: coalesced (~6 writes/scan -> 1/tick), fail-soft on
  quota errors (a quota throw out of processScan used to brick scanning).
- Role-aware partialize: a customer browser NEVER persists aliases, catalog, scanFeed,
  needsReviewQueue, feedback, or cleanup backups. Caps: syncedScanEventIds 1000, feedbackEvents 500;
  customer count data is never capped.
- `skipHydration: true` + explicit rehydrate in `StoreHydrator.tsx`.
- Dev-only: `window.__scanStore` is exposed when not production (Playwright proof harness reads it).

## 5. Domain types (`src/types.ts`)

- `Product` - countable catalog item. `verified` (human/seed only; resolver requires it),
  `provisional` (minted from a weak suggestion, counted but unconfirmed), `provenanceTier`,
  structured-name fields (`structuredBy: "human"` is a permanent lock).
- `Alias` - code -> productId. `approved` (human/verified-seed only; resolver requires it).
- `ScanEvent` - one scan on the feed; the ledger's atomic unit (`quantityDelta`, `decodeStatus`,
  inline `suggestion` tag).
- `InventoryCount` - THE LEDGER ROW: `quantity`, `scanEventIds[]` (dedupe set),
  `appliedIdempotencyKeys[]`.
- `InventorySession` - counting session; `locked`/`lockedAt` implement the owner-PIN read-only lock.
- `UnknownCodeReview` - Needs Review row; carries suggested* fields, evidence/trust metadata,
  `provisionalProductId` (stable link back to the placeholder product), `reopenedFromWrong`.

## 6. API routes

| Route | Purpose |
|---|---|
| `GET/POST /api/ai-lookup` | GET = config/status peek (no secrets). POST = decode entry (abuse guards -> `runDecodePipeline`); legacy `mode:"lookup"` single-provider path still exists |
| `POST /api/reconcile/match` | Pure identityMatcher against the local tire corpus; no keys, no paid calls |

### Local hybrid identity preview boundaries

The local-only identity preview accepts at most 5,000 returned source rows. Browser shaping preserves every physical row and source order, then `POST /api/identity/preview` accepts a separately bounded 32 MiB input. The response is a stateless ordered set of HMAC-signed chunks: each emitted token is measured after signing and limited to 512 KiB, while the complete set is capped at 32 MiB. Apply recomputes and verifies the signed root, row IDs, decision fingerprints, scope, and versions; it never needs source bytes again.

Preview identity and inventory counting are intentionally separate. A physical-count apply creates aggregate import ledger events only after signed-preview verification; reconcile creates an expected-inventory view and does not alter scan counts. Browser long-task evidence is BLOCKED: this owner-forbidden task does not run E2E or Playwright, so Node timing is not claimed as browser responsiveness proof.
| `POST /api/resolve-scan` | Customer-role server-side resolve: verifies Firebase token + membership, resolves via Admin SDK, returns sanitized result (customer browsers never download the alias/catalog DB) |

## 7. Test layout

- Unit tests co-located next to source (`*.test.ts(x)`). Vitest projects: `unit` (node env:
  services/eval/server/app/scripts) and `dom` (jsdom: components/stores/camera).
- E2E: `e2e/*.spec.ts` + `e2e/human-bots/` (QA bots) + `e2e/firebase-phase2/` + proof artifacts in
  `e2e/proof/`. Four Playwright configs (see `docs/COMMANDS.md` for the port map).
- The crown invariant suite = `npm run test:ledger` (8 pinned files; `ledgerInvariants.store.test.ts`
  proves books balance and retry-is-no-op). Ledger E2E: `e2e/ledger-markwrong.spec.ts`.
- Other named gates: `test:golden`, `test:corpus-drift` (live Turso, self-skipping), `test:firebase`,
  `proof:local`, `release:check`.

## 8. Traps a fresh session falls into (verified 2026-07-19)

1. `services/ai/decodeOrchestrator.ts` is `@deprecated` with no live runtime callers (types only).
   The live orchestrator is `server/decode/pipeline.ts`. Do not extend the deprecated one.
2. `services/decode/README.md` describes the deprecated flow, not the pipeline. The folder is a barrel.
3. `checkAndIncrementDaily()` is the LEGACY file-only cap used by lookup mode. The real decode cap is
   `readDailyUsed`/`chargeDailySlot`, charged lazily right before the paid rungs. A free hit never
   touches the cap. Do not add `checkAndIncrementDaily` callers.
4. The count ledger is not in any file named "ledger": pure math in `services/inventory.ts`, stateful
   wiring in scanStore `processScan`/`markWrong`, proofs in `stores/ledgerInvariants.store.test.ts`.
5. `scanStore.ts` is a ~6,500-line monolith. Grep for symbols; do not expect file-per-concern.
6. "Every scan counts" is enforced by ORDERING (`ensureProvisionalCount` before any network), not by
   a named guard. Moving that call below an await is a law violation that no grep will catch.
7. Gemini is wired but dead for decode; status responses can look like it participates. It does not.
8. Brand-prefix conflict alone is advisory; only the evidence-weighted prefixFirewall hard-blocks,
   and strong app-verified evidence overrides even that.
9. `markWrong` transfers quantity via repointed ScanEvents; it never zeroes or deletes.
10. Two DB layers coexist on purpose: better-sqlite3 (knowledge corpus, local file / .db.gz on
    Vercel) and Turso/libsql (decode cache, ladder usage). Do not unify them casually.
11. `server/upc/importBoundary.test.ts` statically fails the suite if client code imports
    `@/server/upc`. `services/upc/*` is the deliberately client-safe half. Same-sounding paths,
    different trust levels.
12. The pure-services rule (no React / next/* in `src/services`) is convention + spot tests, not a
    lint rule. Keep honoring it.
13. `next.config.ts` `serverExternalPackages` (firebase-admin, better-sqlite3, @libsql/client) is
    load-bearing: bundling them broke native modules and silently fell through to PAID AI (2026-07-09).
14. `cloudDrainRace.store.test.ts` is timing-flaky only under full parallel vitest load; it passes in
    isolation. Do not "fix" it blind.
