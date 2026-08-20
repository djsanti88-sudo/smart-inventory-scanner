# Architecture layers: business logic vs. infrastructure

Written 2026-08-18 on branch `refactor/pre-aws-cleanup`, from a five-agent read-only audit of the
tree at `96995da7`, with every claim checked against the code rather than against older docs.

**What this document is for.** `docs/ARCHITECTURE.md` answers "how does a scan flow through this
app?". This one answers a different question, the one that matters before an infrastructure
migration: **which code would a provider change touch, and which code would not notice?**

It is deliberately separate from `ARCHITECTURE.md` because it has a different lifetime. The flow
map stays true as long as the product behaves the same way; this map changes every time a seam
moves, and it should be re-verified — not trusted — at the start of the migration.

---

## The short answer

The business core is already clean. `src/services/` contains no React, no `next/*`, no `@/server`
imports, and no `@/app` imports — verified by directional grep, not by convention. Counting,
resolution, alias matching, scan cleaning and CSV export are pure functions over plain types. **A
provider migration does not touch them.**

The coupling is concentrated in four places, and only four:

| Concentration | Where | Migration weight |
|---|---|---|
| Firestore reads/writes | `src/services/db/firebase/`, 12 API routes via the Admin SDK | Heavy but bounded |
| Firebase Auth | `src/lib/auth.ts`, `src/lib/firebaseClient.ts` | Bounded — one adapter |
| Turso/libsql + SQLite corpus | `src/server/` (6 modules) | Medium |
| Vercel filesystem assumptions | `src/server/knowledgeDb.ts` | **The single hardest item** |

Everything else the audits examined was portable.

---

## Layer map

Each row states what implements the layer, whether it is pure, and what separates it from its
provider. "Seam" means a named contract a replacement would have to satisfy.

### Pure business logic — a migration does not touch these

| # | Layer | Files | Seam |
|---|---|---|---|
| 2 | Core domain | `services/inventory.ts` (the count ledger), `services/inventory.replay.ts` | none needed — no provider dependency exists |
| 3 | Barcode resolution / alias matching | `services/resolver.ts`, `services/aliasMatcher.ts`, `services/scanCleaner.ts`, `services/codeTypeDetector.ts` | none needed |
| 4 | Inventory counting | `services/inventory.ts` — `applyScanEventOnce` is the whole ledger | none needed |
| 8 | Roles / access level | `services/security/roleAccess.ts` | `Identity` / `AccessLevel` types |
| 14 | Idempotency | `services/idempotency.ts` | keys are minted once at scan time, reused on every retry |
| 16 | Exports | `services/csvExport.ts`, `services/csvImport.ts`; `services/exportFormats.ts` lazy-loads `exceljs`/`jspdf` | dynamic `import()` (bundle size, not portability) |

These are the crown jewels and they are provider-free today. That is the single most important
fact in this document.

### Provider-coupled — a migration touches these

| # | Layer | Files | Coupled to | Seam |
|---|---|---|---|---|
| 1 | UI | `components/`, `app/(app)/**/page.tsx` | React/Next (expected) | talks to the store and services, never to a provider SDK |
| 5 | Scan handling | `ScannerInput.tsx` → `scanCleaner` → `resolver` → `scanStore.processScan` | none | the store injects a `SyncTarget` |
| 6 | Scan sessions | session logic in `scanStore.ts`; `app/(app)/sessions/[id]/page.tsx` | Firestore, in the detail page only | `ScanSessionRepository` |
| 7 | **Authentication** | `lib/auth.ts`, `lib/firebaseClient.ts` | **Firebase Auth** | `AuthService` / `WorkspaceService` (added 2026-08-18) |
| 9 | Tenant persistence | `services/db/types.ts` (neutral shapes), `services/db/firebase/repositories.ts` | Firestore | `InventoryRepository`, `BarcodeRepository` |
| 10 | Database access | `services/mockDb.ts`, `services/db/firebase/firebaseSyncTarget.ts` | Firestore | **`SyncTarget` + `DatabaseService`** |
| 11 | External API clients | `services/ai/*Provider.ts`, `services/upc/*Client.ts` | OpenAI, Go-UPC, UPCitemdb, OpenFoodFacts | `AiProvider`; UPC clients have no shared interface |
| 12 | Decode ladder | `server/decode/pipeline.ts` fronted by `app/api/ai-lookup/route.ts`; driver `server/upc/ladder.ts` | providers | `LadderRung` / `RungOutcome` — the cleanest seam in the codebase |
| 13 | Offline | `pendingSyncQueue` in `scanStore.ts`, `scanPersistStorage.ts`, `idbBacking.ts` | IndexedDB, localStorage fallback | `SyncTarget.apply()` |
| 15 | Logging / telemetry | `components/SpeedInsightsTelemetry.tsx`; `services/audit/audit.ts` | **Vercel** Speed Insights | `DatabaseService.audit` — a no-op on mock |
| 17 | Deployment | `next.config.ts` `serverExternalPackages`; `server/knowledgeDb.ts` | **Vercel** | none — see the lock-in section |

---

## The seams that exist

Six named contracts. Three predate this cleanup; three were added by it.

| Seam | File | Status |
|---|---|---|
| `SyncTarget` | `services/db/syncTarget.ts` | Pre-existing. The real one — two live implementations, selected at one wiring point |
| `AiProvider` | `services/ai/provider.ts` | Pre-existing. Honored structurally, but `pipeline.ts` calls providers by name rather than dispatching over a list — **do not assume polymorphism** |
| `LadderRung` | `server/upc/ladder.ts` | Pre-existing and pure — imports only the GTIN gate helpers |
| `AuthService` / `WorkspaceService` | `services/auth/authService.ts` | **Added.** Auth previously had no abstraction of any kind |
| `DatabaseService` | `services/db/databaseService.ts` | **Extracted** from `ScanStoreDeps`, which was already a working DI seam buried in a 9,222-line file |
| `InventoryRepository`, `BarcodeRepository`, `CatalogRepository`, `AuditRepository`, `ScanSessionRepository` | `services/db/repositories.ts` | **Added.** The Firestore implementations already spoke in neutral shapes; nothing stated the contract |

All six are **types only**. There is no registry, no factory, no runtime dispatch — with exactly one
implementation of each, that would be indirection nobody can follow. Conformance is enforced by
`tsc --noEmit` through two contract tests (`lib/auth.contract.test.ts`,
`services/db/repositories.contract.test.ts`), both verified to actually fail when an implementation
drifts.

### The one wiring point

`src/stores/scanStore.ts` picks the backend once, at module load:

```
const useFirebaseBackend = isCloudBackendEnabled();
const appDeps: ScanStoreDeps = { db: useFirebaseBackend ? new FirebaseSyncTarget(...) : getMockDb(), ... };
```

A replacement backend is a new `SyncTarget` plus a branch here. That is the shape a migration wants.

---

## Where provider code still reaches past the seams

Honest inventory. These are the migration's real work items.

1. **The server/Admin SDK surface has no abstraction at all.** Twelve API routes call
   `getAdminAuth()` / `getAdminDb()` directly, and `server/business/provisioning.ts`,
   `server/catalog/masterAppend.ts`, `masterLookup.ts`, `catalogDispute.ts` and
   `services/security/accountDeleteRateLimit.ts` issue Firestore transactions inline. The
   client-side path has repositories; the server-side path has nothing equivalent.
2. **The read-side bootstrap is a free function, not part of any port.**
   `services/db/firebase/businessDataLoader.ts` `loadBusinessData` is called directly. It is now
   *typed* by `DatabaseService.loadBusinessData`, but the implementation is still Firestore-shaped.
3. **The session detail page builds its own `FirebaseSyncTarget`** rather than going through the
   store's single wiring point (`app/(app)/sessions/[id]/page.tsx`).
4. **Five modules write raw SQL inline**: `tireKnowledgeIndex.ts`, `retailKnowledgeIndex.ts`,
   `decodeCacheStore.ts`, `learnedProducts.ts`, `shareTokenStore.ts`. The *driver* is now behind one
   seam (`server/db/tursoClient.ts`), but the queries are hand-written at each site. Only
   `server/upc/storage.ts` sits behind a real interface (`LadderStorage`, with file and Turso
   implementations) — that is the pattern the other five should follow.
5. **AI provider keys are read at each call site** rather than through one client factory per
   vendor; `flashLiteGrounding.ts` and `groundedSpecFinder.ts` duplicate the Gemini call shape.

---

## Configuration

**Still ad hoc.** `process.env.*` is read directly in ~38 files. This cleanup centralized exactly one
flag — the cloud-backend selector, which had been compared literally in six places — into
`services/config/backend.ts`. The rest is untouched, deliberately: most of those reads are a single
variable used in one module, where a central registry would add a hop without removing a decision.

Two real mitigations already exist and should not be mistaken for a config layer:

- `docs/COMMANDS.md` documents variable names centrally (documentation, not code).
- `src/services/keySafety.test.ts` statically forbids `*_API_KEY` and `firebase-admin` from appearing
  in client-facing directories. **This is an enforced guardrail**, and it is a blocklist over grep
  patterns — it stops known-bad names, it does not stop a new variable being read ad hoc.

---

## Dependency direction

Verified, not assumed:

- `src/services` → `@/server`: **zero**
- `src/services` → `@/app`: **zero**
- `src/services` → `react` / `next/*`: **zero**
- `@/server` → `@/services`: 19 files, all one-directional

No cycle exists between `services` and `server`. Cycles *within* `src/services/*` or *within*
`src/server/*` were not ruled out — `madge` is not installed and no cycle scan was run. Treat
"no circular dependencies" as proven for the layer boundary only.

---

## Platform lock-in, ranked

| Rank | Item | Why it binds |
|---|---|---|
| 1 | `server/knowledgeDb.ts` `/tmp` decompression | Decompresses a ~125 MB `.gz` corpus into `os.tmpdir()` on cold start and reuses it across warm invocations. This assumes Vercel Fluid Compute's persistent-`/tmp`-across-warm-instances behavior plus a writable filesystem. Classic Lambda and Cloudflare Workers provide neither. **This is the single hardest thing to move.** |
| 2 | `.vercelignore` + the Turso split | The corpora live in Turso *because* they exceeded Vercel's function bundle limit (2026-07-09). Another host without that cap would not need the split — but unwinding it now is a migration, not a config change. |
| 3 | `vercel.json` `ignoreCommand` | Vercel-exclusive Ignored Build Step; a doc-only PR would rebuild everywhere else. |
| 4 | `@vercel/speed-insights` | Inert off-platform. Already has a `NEXT_PUBLIC_DISABLE_TELEMETRY` kill switch. |
| 5 | Deploy tooling | `deploy-preview.mjs`, `check-env-parity.mjs`, `smoke-fingerprint.mjs`, `vercel-inspect.mjs` shell the `vercel` CLI or hardcode `*.vercel.app`. Tooling, not product. |

**What is NOT locked in**, checked and confirmed absent: no `middleware.ts`, no
`runtime = "edge"` anywhere, no ISR/`revalidate`, no Vercel crons, no `waitUntil` background work,
no other `@vercel/*` package. The 17 routes that declare `runtime = "nodejs"` are opting *out* of
edge, which is portable. `VERCEL_GIT_COMMIT_SHA` in `/api/health` degrades to `GIT_COMMIT_SHA` then
`"dev"`.

---

## Known debt this cleanup surfaced but did not change

Each of these is a real finding with evidence; none was fixed, because each is either out of scope
or carries behavior risk that belongs in its own change with its own proof.

| Item | Evidence | Why not fixed here |
|---|---|---|
| **Two `ScanEvent` types** | `@/types` has `matchedProductId: string \| null`; `services/db/types.ts` has `matchedProductId?: string`. Converted by `storeMappers`. | Found by the new repository contract test. Unifying them touches the persistence mappers and the store; needs its own proof run. |
| **`hostOf(url)` implemented five times** | `fetchV2/scoring.ts:49`, `catalog/sourceTrust.ts:32`, `ai/trustedProductHosts.ts:50`, `ai/pageFetch.ts:112`, `ai/evidenceVerifier.ts:65` | The fallbacks genuinely differ (one uses `.host` not `.hostname`; three differ on throw). These feed trust scoring — unifying them could change decode trust decisions. Report, do not silently merge. |
| **Nine ungated paid scripts** | Recorded as **Critical, unfixed** in `docs/superpowers/reports/2026-08-13-loop2-tooling.md` (TL2-1) | Reads `.env.local` keys and spends on bare invocation. Money path, nine files — needs owner sign-off, not a cleanup commit. |
| **Three `src/server` modules lack `import "server-only"`** | `retailKnowledgeIndex.ts`, `decodeCacheStore.ts`, `learnedProducts.ts` | Adding the guard changes bundling, not just structure. Worth doing deliberately. |
| **`scanStore.ts` is 9,222 lines**, one ~7,200-line function | `buildScanInitializer` | Splitting is possible in principle, but the TOP-LEVEL LAW is enforced by *call ordering* (`ensureProvisionalCount` before any await), not by a guard function. A split that reorders is a data-loss bug. Highest-risk refactor in the repo. |
| **`docs/ARCHITECTURE.md` line numbers were stale** | Claimed ~6,500 lines, `processScan` ~1340, `markWrong` ~4535 | Corrected in the same commit as this file. |

---

## Recommended migration order

Derived from the coupling map, cheapest and safest first.

1. **Decide the corpus story before anything else.** Item 1 in the lock-in table is the constraint
   the rest of the architecture bends around — the Turso split exists because of it. Every other
   choice is downstream.
2. **Give the server/Admin path repositories**, mirroring the client-side ones. It is the largest
   un-abstracted surface and the work is mechanical.
3. **Route the session detail page through the store's wiring point**, so backend selection has
   exactly one site.
4. **Put the four remaining raw-SQL modules behind `LadderStorage`-style interfaces.** The pattern
   is already proven in `server/upc/storage.ts`.
5. **Then, and only then, implement a second `AuthService` and `DatabaseService`.** By that point
   the ports are exercised and honest; implementing against them earlier would mean implementing
   against a contract nothing has tested.
