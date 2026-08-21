# Architecture layers: business logic vs. infrastructure

This map identifies which code is provider-neutral and which code changes when infrastructure moves.
It was refreshed after the 2026-08-21 decoder simplification.

## Stable business core

`src/services/` has no React, `next/*`, `@/server`, or `@/app` imports. Counting, replay, deterministic
resolution, aliases, barcode cleaning, idempotency, and export formatting operate on plain TypeScript
types. A hosting, database, auth, or AI-provider change must not alter these rules.

| Layer | Owner | Provider dependency |
|---|---|---|
| Count ledger and replay | `services/inventory.ts`, `services/inventory.replay.ts` | none |
| Barcode cleaning and deterministic resolution | `services/scanCleaner.ts`, `resolver.ts`, `aliasMatcher.ts` | none |
| Idempotency | `services/idempotency.ts` | none |
| Roles and access decisions | `services/security/roleAccess.ts` | neutral identity types |
| Import/export transforms | `services/csv*.ts`, `services/exportFormats.ts` | output libraries only |

## Provider-coupled layers

| Layer | Owner | Coupled to | Existing seam |
|---|---|---|---|
| UI | `components/`, `app/(app)/**` | React and Next.js | store/service calls only |
| Auth | `lib/auth.ts`, `lib/firebaseClient.ts` | Firebase Auth | `AuthService`, `WorkspaceService` |
| Tenant sync | `services/db/firebase/` | Firestore | `SyncTarget`, repository interfaces |
| Server tenant operations | API routes and `server/business`, `server/catalog` | Firebase Admin/Firestore | still direct in several routes |
| Offline persistence | `stores/scanPersistStorage.ts`, `idbBacking.ts` | IndexedDB with localStorage fallback | persisted Zustand adapter |
| Knowledge corpus | `server/knowledgeDb.ts`, tire/retail modules | better-sqlite3 and Turso | lookup functions |
| Decode cache and counters | `server/decodeCacheStore.ts`, `server/decode/storage.ts` | Turso/file | module-level store contracts |
| Paid decode | `services/ai/gptDecodeClient.ts` | OpenAI Responses API | one client function |
| Decode orchestration | `server/decode/pipeline.ts`, API route | corpus/cache/OpenAI | one pipeline entry point |
| Telemetry | `components/SpeedInsightsTelemetry.tsx`, audit services | Vercel/Firestore | optional UI component and audit interface |

## Dependency direction

- Client components and stores may import client-safe services.
- Client code may not import `@/server/*`.
- Server modules may import services, never the reverse.
- API routes own authentication and request shaping, then call server/application owners.
- Counting and replay never import decode or AI code.

The decoder no longer has a provider registry or rung interface. There is exactly one paid client, so
adding polymorphic dispatch would create indirection without a second implementation.

## Existing seams worth preserving

- `SyncTarget` selects mock versus Firebase behavior at one store wiring point.
- Repository interfaces keep Firestore shapes out of most consumers.
- `AuthService` and `WorkspaceService` isolate client auth behavior.
- `decodeWithGpt` is the single paid-provider boundary.
- `runDecodePipeline` is the only owner of free-source order, cache replay, caps, and paid egress.

Do not introduce another decode orchestrator, provider client, cache, or counter beside these owners.

## Remaining coupling and debt

1. Several server API routes still call Firebase Admin directly. A future database migration would need
   server-side repositories, but adding them now would not improve current behavior.
2. The session detail page constructs a Firebase sync target outside the main store wiring point.
3. Corpus, learned-product, cache, and share-token modules each own handwritten SQL. Their schemas and
   access patterns differ enough that one generic repository would be misleading.
4. `process.env` reads remain distributed. Centralize only variables shared by several modules or
   requiring cross-field validation.
5. `scanStore.ts` is a large integration owner. Its highest-risk behavior is ordering, especially
   provisional count before any await. Extract only independently testable concerns.
6. Two ScanEvent persistence shapes remain connected through explicit mappers. Unifying them is a
   migration, not cosmetic cleanup.

## Platform constraints

- `server/knowledgeDb.ts` decompresses the bundled corpus into a writable temporary directory and
  reuses it on warm Node.js instances.
- `next.config.ts` `serverExternalPackages` for Firebase Admin, better-sqlite3, and libsql is
  load-bearing.
- Vercel-specific deployment, environment-parity, and telemetry tooling is operational coupling, not
  business-domain coupling.

## Safe migration order

1. Decide the corpus hosting and cold-start strategy.
2. Add server-side repositories only when a second database target is concrete.
3. Collapse backend selection to one wiring point.
4. Implement and prove the second persistence/auth target against the existing contracts.
5. Leave ledger, resolver, and idempotency rules unchanged unless product behavior itself changes.
