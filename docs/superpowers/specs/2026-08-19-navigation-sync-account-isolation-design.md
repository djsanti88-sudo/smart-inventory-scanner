# Navigation, Sync, and Account Isolation Repair Design

## Approval basis

The owner approved the recommended repair for the production incident where a 1,000-scan session temporarily displayed only the subset of products already present in Firestore after navigating away from Scan. The owner also explicitly required repeated History, Reconcile, Settings, and Scan navigation proof, removal of the visible page reload glitch, real two-account coverage, and a durable entry in `LESSONS_LEARNED.md`. This approval covers local code, tests, Firebase emulators, screenshots, and local commits only. It does not authorize production users, production data changes, live providers, deployment, push, or merge.

## Goal

Keep every local scan, count, and best-known identity stable while cloud writes are pending; make large cloud queues drain materially faster without reordering writes to the same entity; preserve strict account and tenant isolation; make historical counts obey the every-scan-counts law; remove false state-corruption errors; and prove repeated application navigation does not change the Scan page.

## Measurable success

- A same-account, same-business business-context reload never replaces a locally pending product or alias with an older or incomplete Firestore snapshot.
- History, Reconcile, Settings, and Scan can be traversed three complete times without re-running business bootstrap, flashing a second loading state, changing the scan total, changing summed quantity, losing product identity, or creating blank joined rows.
- A real account or business change still clears tenant-visible state before loading the new tenant.
- Cloud sync runs no more than four independent writes concurrently and preserves FIFO order for every entity key.
- A 3,000-item synthetic queue drains without loss, duplication, stale overwrite, or unbounded concurrency.
- Past-session count rows include known, resolved, suggested, needs-review, and unidentified physical scan events.
- A valid live store does not log `wrong-shape field(s)` and valid arrays keep their original references.
- Two Firebase Auth emulator users, each with a different Firestore business and membership, can use the same browser without seeing each other's scans, counts, products, reviews, history, selected business, or persisted local state.
- A 1,000-scan browser stress scenario retains exactly 1,000 feed events and total quantity 1,000 across repeated navigation and reload.
- The incident, invariant, regression tests, and required future gates are recorded in `LESSONS_LEARNED.md`.

## Architecture

### 1. Pending-aware business-context merge

The async loader used by `setBusinessContext` will stop assigning `products: data.products` and `aliases: data.aliases` directly. A pure helper will merge the remote snapshot over the current tenant's local arrays while inspecting that tenant's pending queue.

- Local products with pending `SAVE_PRODUCT` operations remain authoritative until their operation drains.
- Local aliases with pending `RESOLVE_ALIAS` operations remain authoritative until their operation drains.
- Non-pending remote rows update local rows by id.
- Remote rows unknown to the device are added.
- Locally archived products are not resurrected by a stale active remote row.
- A real tenant switch remains isolated because the switch path clears tenant arrays before the new tenant's loader is applied.

The helper will be reused by both initial business-context loading and `refreshFromCloud` so the two reload paths cannot drift again.

### 2. Navigation bootstrap fast path

`BusinessContextGate` currently starts every mount in `resolving` and repeats session, membership, per-UID hydration, business-context loading, and Firestore reads. Because each page mounts its own gate, client navigation appears to open the page and then reload it.

The gate will derive an initial ready state from the existing store only when all of these facts are already true:

- cloud mode is enabled;
- `businessContextReady` and `businessDataLoaded` are true;
- the store has a non-null signed-in `userId`;
- the locally selected business id exactly equals the store's current `businessId`.

When those conditions hold, the new gate mount renders immediately and skips duplicate bootstrap. If any condition fails, the existing fail-closed session, membership, per-UID hydration, and `setBusinessContext` flow runs unchanged. Normal sign-out clears the selected business and resets readiness, and a real business selection changes the selected id, so neither account changes nor business changes can take the fast path accidentally.

### 3. Bounded ordered cloud synchronization

`FirebaseSyncTarget.apply(item)` remains the only durable write primitive. Its per-item Firestore transaction, applied-key marker, payload hash, and count dedupe contract remain unchanged.

Only the cloud drain scheduler changes:

- maximum in-flight applies: four;
- stable product priority among currently ready items, reducing the missing-product join window;
- FIFO ordering by dependency key, using `entityType:entityId`; `INCREMENT_COUNT` continues using its existing count entity id, which also keeps balanced transfer pairs ordered;
- a later same-key item cannot start until the prior same-key item succeeds;
- a retryable or terminal failure blocks later same-key items for that pass and leaves them queued;
- token and account-context checks run before each apply starts;
- successful late completions are reconciled monotonically, while stale error bookkeeping cannot overwrite a newer pass;
- existing progress flushing, retry metadata, quarantine behavior, synced-event id accumulation, timeout, watchdog, and mock-backend synchronous behavior remain intact.

Naive `Promise.all` is forbidden because it can let an older provisional product or scan event overwrite its later settled identity. Firestore batching is out of scope because the current contract requires transactional reads of applied-key and count documents before writes.

### 4. Historical count derivation

`countsFromTimeline` will derive rows from every physical scan event, not only events whose current identity status is `known` or `resolved`. Identity status controls labels and product joins, never whether the event counts. The existing chronological last-event rule and product-id-or-clean-code grouping remain unchanged.

### 5. Valid-state sanitizer

Nested-array sanitation will allocate a replacement top-level array only when at least one nested field is actually malformed. Valid arrays will retain reference identity. `sanitizeLiveScanStateShape` will therefore call `set()` and log an error only for real repairs. The existing fail-soft behavior for genuinely malformed persisted or live state remains unchanged.

### 6. Account and business isolation proof

No production account will be created. The Firebase emulator global setup will create two Auth emulator users, two separate businesses, two membership documents, and distinct tenant data.

The browser proof will use one browser profile and the real application flow:

1. Sign in as user A and verify only business A data.
2. Scan and fully drain A's queue.
3. Sign out through the visible application control.
4. Sign in as user B and verify no A product, feed row, count, review, history, selected business, or persisted key is exposed.
5. Scan and fully drain B's queue.
6. Sign out and sign in as A again, proving A reloads its own cloud state and never B's.
7. Seed a stale selected-business value and prove membership validation fails closed rather than loading the other tenant.

Existing per-UID key format and sign-out wipe policy remain unchanged unless a failing regression test proves a defect in the real flow.

## Error handling and safety

- All new browser accounts and data live only in Firebase Auth and Firestore emulators.
- Emulator setup uses unique fixed tenant ids and clears only those exact emulator collections before each run.
- No live AI provider is enabled; `IS_E2E=1` and empty provider keys remain mandatory.
- A context mismatch during sync stops scheduling new writes. Already committed successes are still removed from the queue exactly once.
- A failed same-entity write prevents a newer same-entity payload from passing it in the same drain.
- A failed remote load preserves local state and surfaces the existing sync error.
- Account isolation tests assert both absence of foreign UI data and absence of foreign tenant identifiers in active persisted state.

## Test design

### Failing-first unit and store tests

- Same-tenant `setBusinessContext` remount preserves a pending local product and alias against a stale remote snapshot.
- Non-pending remote products and aliases still refresh normally.
- Real tenant switch never merges the prior tenant.
- Valid nested-array fields preserve reference identity and `processScan` emits no false wrong-shape error.
- A genuinely malformed nested field is still repaired and logged.
- Past-session unknown, suggested, and needs-review events contribute to timeline-derived counts.
- Business-context gate remount skips bootstrap only for an already-loaded matching business and uses full bootstrap for a different business or reset account.
- Ordered cloud scheduler proves maximum concurrency four, per-entity FIFO, failure blocking, context cancellation, progress reconciliation, no stale scan/product overwrite, and a complete 3,000-item drain.

### Firebase emulator proof

- Run `npm run test:firebase` for rules, idempotency, loader, tenancy, and count transactions.
- Extend `npm run test:e2e:firebase` with the two-user, two-business, same-browser flow.
- Direct Admin SDK assertions verify each business contains only its own products, events, counts, sessions, reviews, and applied keys.

### Browser workflow proof

- Add a mock or emulator-backed 1,000-scan scenario using hardware-scanner style input.
- Record the Scan baseline: feed total, identified total, product count, summed quantity, and a stable identity sample.
- Execute History, Reconcile, Settings, Scan three times.
- After every return to Scan, assert all baseline values are unchanged, no blank product join appears, the scanner regains focus, and no business bootstrap loading state flashes.
- Hard reload once after the queue drains and repeat the invariants.

### Final gates

- Focused Vitest regression files
- `npm run test:ledger`
- `npm run test:firebase`
- `npm run test:e2e:firebase`
- focused mock Playwright navigation/stress specifications
- `npm run qa:bots` for customer-facing scanner, history, reconcile, and settings behavior
- `npm run proof:all`
- `scanbin-certify -Repo C:\Users\djsan\inventory -Mode full`

## Documentation

`LESSONS_LEARNED.md` will receive one dated incident entry with:

- the observed 1,000 to 210 to 966 to 1,000 sequence;
- the exact root cause and contributing serial-backlog condition;
- the distinction between account isolation, the separate historical-count defect, and the false console error;
- the invariant that pending local entities remain authoritative until their writes drain;
- the required unit, ledger, emulator, two-account, and repeated-navigation gates for future changes to these seams.

## Out of scope

- Production Firebase accounts or customer-data mutation
- Vercel deployment, Preview promotion, production verification, push, merge, or PR creation
- Paid or live decode providers
- Replacing the durable sync protocol with Firestore write batches
- Multi-tab simultaneous scanning, which remains a separate whole-snapshot concurrency problem
- Changing account retention policy after sign-out unless the approved tests expose a concrete defect

## Rollback

The repair is isolated on `fix/navigation-sync-account-isolation`. Reverting the branch changes restores the prior loader, serial scheduler, gate behavior, timeline filter, and sanitizer. Emulator fixtures are disposable and recreated per run. No production rollback is required because this task does not deploy.
