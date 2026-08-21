# Architecture Map

> Decode and persistence boundaries re-verified on 2026-08-21. This is
> the deep companion to the "Layout and boundaries" section in `AGENTS.md`. If this doc and the
> code disagree, the code wins; fix this doc in the same commit.

## 1. Directory map (`src/`, top 2 levels)

```
src/
├── app/                       Next.js App Router
│   ├── (app)/                 Authenticated app shell: business, products, reconcile,
│   │                          review, scan, settings pages (route group, shared layout)
│   ├── api/
│   │   ├── ai-lookup/         GET status peek / POST decode entry point
│   │   ├── reconcile/match/   Server-side reconcile matcher (local tire corpus only, no paid calls)
│   │   └── resolve-scan/      Server-side deterministic resolve for the customer role (Firebase)
│   └── login/                 Login page
├── components/                React "use client" components: ScannerInput, LiveScanFeed, tables,
│                              StoreHydrator, AuthGuard. Co-located .test.tsx (jsdom project).
├── eval/                      Golden-baseline eval harness (npm run test:golden)
├── lib/                       Thin glue: auth.ts, firebaseAdmin.ts, firebaseClient.ts
├── seed/                      seedData.ts - verified seed products/aliases
├── server/                    SERVER-ONLY code (never imported by client files)
│   ├── decode/                pipeline.ts orchestrator + storage.ts counters/outcomes
│   ├── tire-knowledge/        Tire corpus index (SQLite / Turso / generated-JSON fallback)
│   ├── retail-knowledge/      ~4M-row retail barcode index (Open Food Facts derived)
│   ├── knowledgeDb.ts         better-sqlite3 opener (decompresses .db.gz on Vercel)
│   ├── decodeCacheStore.ts    L2 persistent decode cache (Turso/libsql)
│   └── learnedProducts.ts     Server-persisted "learned products" suggestion tier
├── services/                  PURE SERVICES: no React, no next/* imports (convention enforced by
│   │                          file-header comments + keySafety.test.ts + importBoundary.test.ts)
│   ├── ai/                    decode/trust rules, gptDecodeClient + policy, decodeCache (L1),
│   │                          decodeProviderStatus types
│   ├── catalog/               brandFamilies, brandPrefixGeneral, identityMerge, prefixFirewall,
│   │                          prefixFloor, prefixLearning, evidenceScoring, sourceTrust
│   ├── upc/                   CLIENT-SAFE half: barcodeTrust.ts (trust gate), gtin.ts, misread.ts
│   ├── db/                    syncTarget.ts interface + db/firebase/* Firestore repositories
│   ├── security/              aiSpendGuard.ts (caps/kill switch), roleAccess.ts, sensitiveFields.ts
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
4. **Count (synchronous, before any network)** - `src/stores/scanStore.ts` `processScan` (~line 3181):
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
   provisional -> verified. `markWrong` (~line 7792) is a quantity TRANSFER: it deactivates the bad
   aliases, un-verifies the product, and repoints the feed events onto a fresh "Unidentified item"
   provisional through `incrementInventoryCount` again. Total physical quantity is invariant across
   an identity correction. It uses the id RETURNED by `ensureProvisionalCount`, never a re-lookup by
   barcode (that re-lookup was the D2 double-count bug, fixed in 4990687).
8. **Replay proof** - `services/inventory.replay.ts` `replayLedgerCounts` rebuilds finalCounts purely
   from scanFeed; the invariant suite proves sum(feed deltas) == finalCounts and exact scanEventIds
   set equality. Gate: `npm run test:ledger`.

## 3. Decode enrichment (server side)

`src/server/decode/pipeline.ts` (`runDecodePipeline`) is the only orchestrator, fronted by
`src/app/api/ai-lookup/route.ts`. It stops at the first usable identity:

| # | Stage | Where | Cost |
|---|---|---|---|
| 1 | Tire corpus exact match | `server/tire-knowledge/TireKnowledgeProvider.ts` | free |
| 2 | Retail corpus exact GTIN match | `server/retail-knowledge/retailKnowledgeIndex.ts` | free |
| 3 | Shared learned-products match | `server/learnedProducts.ts` | free |
| 4 | Owner-approved master catalog | `server/catalog/masterLookup.ts` | free |
| 5 | Positive persisted cache | `server/decodeCacheStore.ts` | free |
| 6 | In-process positive cache and in-flight coalescing | `services/ai/decodeCache.ts` | free |
| 7 | One GPT-5.4 mini Responses API call with bounded web search | `services/ai/gptDecodeClient.ts` | paid |

The cap is settled lazily at actual GPT egress through one sticky authorization promise. Free sources
remain available when a global or account cap is exhausted. Example/test codes and likely misreads stop
before egress. Only positive GPT identities are persisted; misses are not cached. GPT output is always
suggested or Needs Review and never app-verifies itself. Full semantics live in
`docs/DECODER_ARCHITECTURE.md`.
  re-checkable GroundTruth (physical scan / app-verified evidence / corpus) can promote a verdict.

## 4. State (Zustand)

| Store | File | localStorage | Notes |
|---|---|---|---|
| scanStore | `src/stores/scanStore.ts` (~9,200 lines) | key `sis-scan-v1`, version 7 | Role-aware partialize via `scanPersist.ts` |
| reconcileStore | `src/stores/reconcileStore.ts` | own key, version 1 | Strips raw CSV field before persist |

- Migration (`scanStoreMigrate`): version < 5 hard-resets learned data to seed; >= 5 is additive only
  (structured-field backfill, countSnapshots default). Never clobbers an already-migrated install.
- Persistence goes through `scanPersistStorage.ts`: coalesced (~6 writes/scan -> 1/tick), fail-soft on
  quota errors (a quota throw out of processScan used to brick scanning).
- Backing store (#27): IndexedDB is the PRIMARY persist backing (db `sis-persist`, store `kv`, via
  `idbBacking.ts` + `createAsyncCoalescedFailSoftPersistStorage`), removing localStorage's ~5MB quota
  wall that bricked large real-backend sessions around 500 scans. localStorage is the FALLBACK when
  IndexedDB is absent (SSR/jsdom/lockdown browsers) - byte-for-byte the previous behavior. A legacy
  localStorage `sis-scan-v1` blob is migrated forward on first read (copy-then-clear: the legacy key is
  removed only after IDB provably holds the value). The per-uid namespace/adopt subsystem
  (`scanPersistNamespace.ts`: adopt banner, alreadyOwn check, once-guard, clear-cache) is IDB-aware and
  reads/wipes BOTH stores. Pagehide flush is best-effort under IDB (started synchronously; the browser
  usually completes an already-started transaction) - the one bounded trade vs localStorage's fully
  synchronous write, at most one coalesced tick of data.
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
| `GET/POST /api/ai-lookup` | GET = config/status peek (no secrets). POST = decode-only entry (abuse guards -> `runDecodePipeline`) |
| `POST /api/reconcile/match` | Pure identityMatcher against the local tire corpus; no keys, no paid calls |
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

1. `services/decode/` no longer exists (deleted 2026-08-18). It was a zero-importer barrel whose
   README described the superseded concurrent flow as current. Canonical decode doc:
   `docs/DECODER_ARCHITECTURE.md`.
2. The decode cap is settled lazily inside `server/decode/pipeline.ts` immediately before GPT egress.
   A free hit never touches the cap and a route-level pre-cap would be a regression.
3. The count ledger is not in any file named "ledger": pure math in `services/inventory.ts`, stateful
   wiring in scanStore `processScan`/`markWrong`, proofs in `stores/ledgerInvariants.store.test.ts`.
4. `scanStore.ts` is a ~9,200-line monolith. Grep for symbols; do not expect file-per-concern.
5. "Every scan counts" is enforced by ORDERING (`ensureProvisionalCount` before any network), not by
   a named guard. Moving that call below an await is a law violation that no grep will catch.
6. Brand-prefix conflict alone is advisory; only the evidence-weighted prefixFirewall hard-blocks,
   and strong app-verified evidence overrides even that.
7. `markWrong` transfers quantity via repointed ScanEvents; it never zeroes or deletes.
8. Two DB layers coexist on purpose: better-sqlite3 (knowledge corpus, local file / .db.gz on
    Vercel) and Turso/libsql (decode cache and usage counters). Do not unify them casually.
9. `services/upc/*` is deliberately client-safe barcode-shape logic. Server decode code remains under
    `src/server/decode/`; client code must never import it.
10. The pure-services rule (no React / next/* in `src/services`) is convention + spot tests, not a
    lint rule. Keep honoring it.
11. `next.config.ts` `serverExternalPackages` (firebase-admin, better-sqlite3, @libsql/client) is
    load-bearing: bundling them broke native modules and silently fell through to PAID AI (2026-07-09).
12. `cloudDrainRace.store.test.ts` is timing-flaky only under full parallel vitest load; it passes in
    isolation. Do not "fix" it blind.
