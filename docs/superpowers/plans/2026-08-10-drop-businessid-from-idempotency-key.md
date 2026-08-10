# Drop businessId from buildIdempotencyKey (Item 2, tier-3 backlog)

> **Status: DESIGN PLAN ONLY. No implementation code has been written or should be written from this
> document until the attack panel (Step 3 of `docs/PLAN_EXECUTION.md`) has run and the owner has
> approved.** This is backlog Item 2 from `docs/superpowers/plans/2026-08-09-tier3-followups.md`
> (lines 99-144), sized L ("structural, multi-day, needs its own plan + adversarial attack panel
> before any code"). Per `GUARDRAILS.md`'s "How we plan" section and `docs/PLAN_EXECUTION.md` Step 3,
> this plan does not get to skip straight to implementation.
>
> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:test-driven-development` once this plan is
> approved and implementation begins. Do not start Task work here without a fresh re-read of this
> file, `PROGRESS.md`'s "Checkpoint 2026-08-09 (late)", and current `src/services/idempotency.ts` /
> `src/stores/scanStore.ts` state (things may have moved since this plan was written).

## 1. Problem / Context

Smart Inventory Scanner (product name Scanbin) is a barcode inventory app. A physical scan is counted
locally the instant it happens (optimistic Zustand state), then synced to a backend (a local `MockDb`
in dev, or real Firestore in production/emulator) using an idempotency key so retries of the same sync
operation never double-count. That key is built once, at scan/resolution time, by one pure function:

```typescript
// src/services/idempotency.ts:7-14 (CURRENT, pre-change)
export function buildIdempotencyKey(
  businessId: string,
  sessionId: string,
  scanEventId: string,
  operation: SyncOperation,
): string {
  return [businessId, sessionId, scanEventId, operation].join(":");
}
```

The app also supports **anonymous use before signup**: a visitor can start scanning immediately,
with every local record (products, scan events, counts, sync-queue items) stamped with a placeholder
tenant id, `DEMO_BUSINESS_ID = "demo-business"` (`src/seed/seedData.ts:7`). When that person signs up
("adopts" their session into a real business), every one of those placeholder-scoped records has to be
rewritten onto the real `businessId` before they can sync to that business's private Firestore data.

Because `businessId` is embedded as **segment 0** of every idempotency key, "rewrite the businessId"
historically meant rewriting *two* things for every entity: the plain `businessId` field, **and** the
leading segment of every embedded `idempotencyKey`-shaped string (the entity's own `idempotencyKey`,
its `appliedIdempotencyKeys[]` array, and — critically — a byte-identical copy of `idempotencyKey`
embedded inside some sync-queue payloads, e.g. `IncrementPayload`, which the server rejects as
`payload_idempotency_mismatch` if it doesn't match the outer key exactly).

This key-rewrite obligation is the **root cause** of a real, expensive bug class discovered and fixed
across three separate review loops on 2026-08-09 (`PROGRESS.md`, "Checkpoint 2026-08-09 (late)" and
"Checkpoint 2026-08-09"):

- **Loop 0 (2026-08-09, earlier checkpoint):** adoption rewrote the *outer* `idempotencyKey` on a
  queued sync item but not the *embedded* `payload.idempotencyKey` copy → every adopted
  `INCREMENT_COUNT` was permanently rejected server-side with `payload_idempotency_mismatch` →
  adopted scans silently never synced (UI said "Not saved yet" but it was actually stranded forever).
- **Loop 1 (F-5, 2026-08-09 late):** the fix above was generalized, then found to still miss
  `aiLookupLogs.businessId` and other embedded identity fields — "the whole rescope-rewrite obligation"
  (the followups doc's own phrase) kept growing new corners because *every* new entity type or embedded
  field that carries a business-scoped identity string is another place this class of bug can hide.

The owner's ruling, recorded in `PROGRESS.md`'s OWNER DECISION LIST #1 and restated in the followups
backlog Item 2 (`docs/superpowers/plans/2026-08-09-tier3-followups.md:99-144`), is to **kill the class
at the root**: stop embedding `businessId` in the idempotency key at all. If the key never carries
`businessId`, there is nothing about it to rewrite on adoption, and the entire `rescopePlaceholderRecord`
/ `rescopePlaceholderQueueItem` key-rewrite code path (and its dependent tests) stops being a source of
this bug class.

**Why this is sized L / structural / plan-first (not shovel-ready like Item 1):** the idempotency key
is the load-bearing identity for the whole sync/dedupe system. It is read by ~50 call sites in a single
~8,700-line file (`src/stores/scanStore.ts`), it is the document ID basis for Firestore's
`_appliedKeys` ledger (the ONLY thing standing between a retried sync and a double count), and it has a
**live-data compatibility tail**: idempotency keys already persisted in production Firestore (and in
users' local IndexedDB/localStorage queues) were minted under the OLD 4-segment format and can never be
rewritten in place without an owner-gated live-data migration (out of scope, per `CLAUDE.md`'s
No-Deploy Rule and the doctrine's real-data-mutation gate). Any new design must let old-format and
new-format keys coexist forever and dedupe correctly against each other.

## 2. Current behavior (step by step)

1. **Scan / resolution time:** the store calls `buildIdempotencyKey(businessId, sessionId, scanEventId, operation)`
   exactly once per logical event (e.g. `src/stores/scanStore.ts:1577` for a counted scan's
   `SAVE_SCAN_EVENT`, `:5516` for its `INCREMENT_COUNT`). The result is stored on the entity
   (`ScanEvent.idempotencyKey`, `InventoryCount.appliedIdempotencyKeys[]`, etc.) and copied onto the
   `PendingSyncItem.idempotencyKey` enqueued for sync. **Per the project's hard invariant (`CLAUDE.md`
   "Optimistic State, Offline, Idempotent Sync"), this key is NEVER regenerated on retry** — whatever
   string was minted at creation time is what every future retry sends, forever, until it syncs.
2. **Sync apply (mock):** `MockDb.apply()` (`src/services/mockDb.ts:74-112`) checks a flat
   `state.appliedKeys: string[]` array for the exact key string; if present, returns `alreadyApplied`
   and does nothing further (`:80-81`). `MockDbState` is **not partitioned by business** — one `MockDb`
   instance's `appliedKeys` array spans every business it has ever seen entities for (see §7 risk R3).
3. **Sync apply (Firestore):** `FirebaseSyncTarget.apply()` (`src/services/db/firebase/firebaseSyncTarget.ts:102-259`)
   runs one transaction that reads `businesses/{bid}/_appliedKeys/{keyId}` (`:20,138`), where `bid` is
   the item's `businessId` field (the **Firestore document path**, not the key content) and `keyId` is
   `appliedKeyDocumentId(item.idempotencyKey)` — the raw key string if it is a legal Firestore document
   ID, else a SHA-256 hash of it (`src/services/db/firebase/firebaseSyncSafety.ts:53-59`). If that doc
   already exists with a matching marker envelope, the write is a no-op (`alreadyApplied: true`,
   `:142-144`); otherwise the marker is created and the entity/count write happens atomically
   (`:171-236`).
4. **Adoption (anonymous session → real business):** `setBusinessContext`'s bootstrap-resolution branch
   (`src/stores/scanStore.ts:2298-2370`) rewrites every placeholder-scoped (`businessId === DEMO_BUSINESS_ID`)
   record's `businessId` field via `rescopePlaceholderRecord` (`:1474-1487`) and every queued sync
   item's `businessId` + embedded key copies via `rescopePlaceholderQueueItem` (`:1499-1519`). Both
   call a shared helper, `rescopeKey` (`:1459-1461`), that rewrites **only** the leading
   `demo-business:` segment of a key-shaped string, byte-for-byte preserving every other segment so
   retries of the same physical event keep hitting the same identity. `buildAdoptionResyncItems`
   (`:1542-1600+`) then rebuilds the sync-queue work the mock backend never generated (anonymous
   sessions run against `MockDb`, which marks writes "synced" instantly and leaves the real cloud queue
   empty), reusing each entity's **own already-rescoped** `idempotencyKey` — never minting a fresh one —
   so re-enqueueing is safe by construction (Firestore's own `_appliedKeys` dedupe swallows anything
   that genuinely already landed).
5. **A parser that assumes the 4-segment shape today:** `idForReview` (`src/stores/scanStore.ts:1446-1451`)
   recovers a review's originating `scanEventId` by splitting its `idempotencyKey` on `":"` and reading
   **index 2** — which is only correct because today's format is always
   `businessId:sessionId:scanEventId:operation` (4 segments, `scanEventId` at index 2). This is the one
   production call site that positionally parses key content rather than treating it as opaque.

## 3. Goals / Success criteria (measurable)

Restated from the followups doc's acceptance criteria (`docs/superpowers/plans/2026-08-09-tier3-followups.md:127-134`),
made concrete:

1. **New keys never embed `businessId`.** `buildIdempotencyKey` drops the `businessId` parameter
   entirely (arity 4 → 3); every call site is a compile error until updated (deliberately breaking,
   same pattern as Item 1's `granted` change).
2. **Every historical key format still dedupes correctly, forever, with no live-data migration.** A
   regression test replays an old-format key (`biz:sess:evt:OP`) and a new-format key
   (`sess:evt:OP`) for two DIFFERENT logical events and confirms each applies exactly once and they
   never collide with each other. A second test replays the SAME old-format key twice and confirms the
   second call is `alreadyApplied` (format-history compatibility, not just format coexistence).
3. **Adoption needs zero key-rewrite steps.** The key-content-rewriting portion of
   `rescopePlaceholderRecord` / `rescopePlaceholderQueueItem` (the `rescopeKey` calls and the
   `PLACEHOLDER_ID_PREFIX` logic) is deleted as dead code, proven by a test that adopts a placeholder
   session and asserts every entity's `idempotencyKey` / `appliedIdempotencyKeys[]` content is
   **byte-identical before and after adoption** (only the plain `businessId` field changes). See §6 for
   why this is the correct, strongest-available reading of "kills the whole obligation" and what part of
   the mechanism necessarily survives.
4. **No regression to counting correctness.** `npm run test:ledger` and `npm run test:firebase` both
   green; full `npm run test` green; `npx tsc --noEmit` clean. No double-counting, no dropped scan, no
   new "Needs Review" caused purely by the key-format change.
5. **The `idForReview` parser works for both key shapes without branching on a version flag** (see §6.3).

## 4. Constraints / non-negotiables

- **TOP-LEVEL LAW** (`CLAUDE.md`): every scan still appears and counts, unconditionally, throughout
  this change. This is a sync-identity change, not a scan-capture change — it must not touch
  `ensureProvisionalCount` ordering or feed-append logic at all.
- **Idempotency keys are never regenerated on retry** — this plan changes what `buildIdempotencyKey`
  *produces* for *new* events; it must never cause an *existing* stored key to be rebuilt or replaced.
- **No live Firestore data migration.** Old keys already in production `_appliedKeys` documents stay
  exactly as they are; this plan must not require (or silently assume) a backfill/rewrite job against
  real customer data. Real-data mutation is owner-gated per `CLAUDE.md`'s No-Deploy Rule regardless.
- **Barcodes/IDs are text always** — no change here touches that rule, but the new key format must
  remain a plain, deterministic string (no numeric coercion anywhere in the join).
- **No em/en dash in any user-facing or doc copy added** (`CLAUDE.md` Conventions).
- Do not deploy, push, or run live/paid providers as part of this plan or its eventual implementation
  without explicit owner approval in the moment.
- **Simplicity Challenger check (self-applied):** prefer deleting dead rescope logic over adapting it to
  "handle" a case that no longer exists. Do not add a schema-version flag to keys, a translation table,
  or a background re-key job unless the attack panel proves the no-migration design (§6.2) is unsafe.

## 5. Scouted code surface (file:line anchors)

### 5.1 The function itself
- `src/services/idempotency.ts:7-14` — `buildIdempotencyKey` definition (the only change to the
  function itself).
- `src/services/idempotency.test.ts:4-22` — current 4-arg format tests; must be rewritten for the new
  3-arg format (`"biz:sess:evt:INCREMENT_COUNT"` assertions become `"sess:evt:INCREMENT_COUNT"`).

### 5.2 Call sites (all in `src/stores/scanStore.ts` unless noted; ~50 total)
Representative sample (full list obtainable via `grep -n "buildIdempotencyKey(" src/stores/scanStore.ts`
at implementation time — do not trust this list to still be exhaustive/line-accurate by then):
`:1218, :1230, :1246, :1291, :1368, :1577, :1594, :1714, :1723, :1767, :1890, :1897, :1907, :2783,
:2806, :2846, :2864, :2979, :3026, :3188, :5516, :5525, :5607-5608, :5617, :5634, :6632, :6760, :6798,
:7235, :7260, :7285, :7343, :7390, :7575, :7588, :7628, :7708-7709, :7766, :7776, :7933, :8161, :8171,
:8177, :8221, :8368, :8373, :8379, :8385`. Every one drops its first (`businessId`) argument; TypeScript's
arity check turns each into a compile error until fixed — the same "make it deliberately breaking"
technique Item 1 uses for `chargeDailySlot`'s `granted` field, so no call site can be silently missed.

Also: `src/services/idempotency.test.ts`, `src/services/mockDb.test.ts:7,93`,
`src/services/inventory.test.ts:31`, `src/stores/markWrongDurable.store.test.ts:173-174,329-330`,
`src/services/db/firebase/markWrongTransfer.rules.test.ts:100,109` all call `buildIdempotencyKey`
directly and need their call sites updated to the 3-arg form.

### 5.3 The rescope/adoption machinery (all `src/stores/scanStore.ts`)
- `:1446-1451` — `idForReview`: positional `.split(":")[2]` parse. **Must change** — see §6.3.
- `:1453-1461` — `PLACEHOLDER_ID_PREFIX` / `rescopeKey`: the businessId-prefix-rewrite helper. Becomes
  dead code under this plan's design; delete both.
- `:1463-1487` — `rescopePlaceholderRecord`: keeps the `entity.businessId = realBusinessId` rewrite;
  **deletes** the `idempotencyKey` / `appliedIdempotencyKeys` rewrite block (`:1478-1485`).
- `:1489-1519` — `rescopePlaceholderQueueItem`: keeps `item.businessId` + `payload.businessId` rewrite;
  **deletes** the `idempotencyKey` / `appliedIdempotencyKeys` rewrite inside the payload closure
  (`:1508-1513`) and the outer `idempotencyKey = rescopeKey(...)` line (`:1517`).
- `:1521-1600+` — `buildAdoptionResyncItems`: unchanged in shape; its "reuse each entity's OWN
  idempotencyKey, never regenerate" comment (`:1532-1535`) becomes *more* true after this change (there
  is no rescope step to have run before reuse — the key is identical from mint time through adoption
  through sync).
- `:2298-2370` — the `setBusinessContext` bootstrap-resolution branch that calls
  `rescopePlaceholderRecord` / `rescopePlaceholderQueueItem` (`:2317-2323, 2356-2369`). No call-site
  change needed here — the functions keep the same signature, just do less internally.

### 5.4 Server-side dedupe / applied-key tracking
- `src/services/db/firebase/firebaseSyncTarget.ts:14-21` — doc comment already states the invariant
  this plan relies on: the transaction reads `_appliedKeys/{idempotencyKey}` **scoped under
  `businesses/{bid}/`** — i.e., Firestore's own document path already isolates keys per business. The
  key's *content* was never the thing providing tenant isolation; the path was.
- `:102-138` — `apply()`: `bid = item.businessId` (a distinct field, never parsed from the key) drives
  every `sub(...)` document path; `keyId = appliedKeyDocumentId(item.idempotencyKey)` is opaque.
- `src/services/db/firebase/firebaseSyncSafety.ts:48-59` — `appliedKeyDocumentId`: raw string if it's a
  legal Firestore doc ID, else `"h2_" + SHA256(key)`. Treats the key as an opaque byte string; no
  assumption about its internal shape. **No change needed here.**
- `:130-260` — `validatePendingSyncItem`: checks `payload.idempotencyKey === item.idempotencyKey`
  (equality only, e.g. `:241,196`) and `payload.businessId === item.businessId` (`:150-155`)
  separately. **Never** asserts that `idempotencyKey` contains or starts with `businessId`. **No change
  needed here** — this is why the key format change is safe from the validator's point of view.
- `firestore.rules:319-321` (`appliedKeyPath`) and `:591-596` (`_appliedKeys` match block) treat `key`
  purely as an opaque document-ID path variable — no content assertions on it anywhere in the ruleset.
  **No security-rules change needed.**
- `src/services/mockDb.ts:18-26, 39-41, 74-112` — `MockDb.appliedKeys: string[]` is a **flat, global,
  non-business-partitioned array** inside one `MockDb` instance (`:80-81,109`). Unlike Firestore, there
  is no path-based tenant isolation here. See §7 R3 for why this is judged safe in practice but must be
  attacked.

### 5.5 Existing invariant test that changes meaning
- `src/stores/businessContextRescopeOnHydration.store.test.ts:175` — the F-5 "class closure" test:
  *"after rescope, the full persisted-shape state contains zero references to the placeholder tenant
  across every embedded identity field."* Under the old design this meant "no `demo-business:` prefix
  survives in any key." Under the new design, new-format keys never had a `businessId` prefix to leak
  in the first place, so this assertion's premise for `idempotencyKey`/`appliedIdempotencyKeys` content
  changes — it must be rewritten to assert **only the plain `businessId` field** was rewritten, and (per
  §3 goal 3) that key content is **unchanged** by rescoping, not merely "clean."

### 5.6 Existing migration infrastructure (reference only — see §6.2 for why unused here)
- `src/stores/scanStore.ts:8541-8623` (`scanStoreMigrate`) + `:8729` (`migrate: scanStoreMigrate` in the
  zustand persist config) — the project's existing pattern for one-time forward transforms of persisted
  state on version bump (e.g. the v13/v14 examples in that function). If a persisted-queue migration
  were judged necessary, this is the seam it would use. This plan's recommended design does not need it
  (§6.2), but it is scouted here because the followups doc explicitly names this as one of the two
  options to choose between.

### 5.7 Documentation that goes stale (non-blocking, cleanup only)
`TESTING.md:91`, `open-source-agents/personas/cribs/ledger.md:25-28`, and the archived
`docs/archive/superpowers/plans/2026-07-19-phase1-ledger.md:21` all describe the current 4-arg
signature/format. Update in the implementation PR, not this plan.

## 6. Design

### 6.1 New key format

```typescript
// src/services/idempotency.ts (ILLUSTRATIVE — not to be implemented from this plan directly)
export function buildIdempotencyKey(
  sessionId: string,
  scanEventId: string,
  operation: SyncOperation,
): string {
  return [sessionId, scanEventId, operation].join(":");
}
```

`businessId` is dropped; segment order and semantics of the remaining three segments are unchanged
(`sessionId`, then the caller's chosen `scanEventId`/entity-id-shaped third argument, then `operation`).
This is the smallest possible diff that satisfies goal 1.

### 6.2 Backward-compatibility dedupe rule (the core safety argument)

**Rule: an idempotency key is an opaque string from the moment it is minted. Its format never needs to
change, and old-format and new-format keys never need to be translated into each other, for either
correctness or adoption.**

This is not a compromise — it falls directly out of two facts already true in the code today (§5.4):

1. **Firestore's `_appliedKeys` collection is scoped by document *path* (`businesses/{bid}/_appliedKeys/...`),
   not by key *content*.** The businessId segment in the old key format was never load-bearing for
   tenant isolation — the path already did that job. Dropping it from the key content changes nothing
   about collision safety at the Firestore layer.
2. **`sessionId` and the entity/scan-event id segments are always independently-random UUIDs**
   (`newId()` defaults to `crypto.randomUUID()`, `src/services/idempotency.ts:20-23`; every call site
   surveyed in §5.2 passes either a freshly-minted id or an existing UUID-shaped entity id). The
   businessId prefix was never providing meaningful additional entropy against accidental collision
   between two unrelated events — UUID collision probability already dominates. (The attack panel should
   verify no ID generation path in the surveyed call sites is ever deterministic/content-derived; see
   §8 A3.)

Consequence: **an idempotency key minted under the OLD format
(`businessId:sessionId:scanEventId:operation`) continues to be used, unmodified, for the entire
lifetime of that entity** — including through adoption, through retries, through eventual sync. It is
never rewritten, never re-derived, never needs a "which format is this" branch anywhere except the one
call site that positionally parses key content (§6.3). Old-format and new-format keys for two DIFFERENT
logical events cannot collide with each other by construction: a 4-segment string and a 3-segment
string are equal only if their full byte content happens to match, which (given UUID segments)
has the same astronomically-low probability as any other UUID collision. The regression test in goal 2
proves this directly rather than arguing it abstractly.

**What this means for `rescopePlaceholderRecord` / `rescopePlaceholderQueueItem`:** the KEY-rewrite
portion of both functions (`rescopeKey`, `PLACEHOLDER_ID_PREFIX`, and every call site that invokes
`rescopeKey` on `idempotencyKey` / `appliedIdempotencyKeys`) is now provably unnecessary and is deleted.
The entity's own `idempotencyKey` is correct **as minted**, whether that was under the placeholder
tenant or the real one, forever. What does **not** go away: `entity.businessId` (and
`payload.businessId` where the payload shape carries one) still must be rewritten on adoption, because
Firestore document routing (`businesses/{bid}/...`) and tenant-scoped reads/writes depend on that plain
field, not on anything inside the idempotency key. This is a distinct concern from key identity and was
never the source of the Loop 0/1 bug class (those bugs were specifically about *key content* mismatches
— `payload_idempotency_mismatch` — never about a wrong `businessId` field value).

### 6.3 `idForReview`: fixing the one positional parser

Today (`src/stores/scanStore.ts:1446-1451`) this function reads a fixed index (2) into the split key,
which is only correct for the 4-segment format. Since `scanEventId` is always the **second-to-last**
segment in both formats (operation is always last; businessId, if present, is always first), a
length-relative index is naturally forward- and backward-compatible without any format-detection
branch:

```typescript
// ILLUSTRATIVE — reviews are keyed to their originating scan event via idempotencyKey's scanEventId
// segment, which is always second-to-last regardless of whether the key predates the businessId drop
// (4 segments: businessId:sessionId:scanEventId:operation) or postdates it (3 segments:
// sessionId:scanEventId:operation). Never assume segment count.
function idForReview(r: UnknownCodeReview): string {
  const parts = (r.idempotencyKey ?? "").split(":");
  return parts.length >= 2 ? parts[parts.length - 2] : r.id;
}
```

This is the only production call site scouted (§5.2/§5.3 note; confirmed via
`grep -rn "idempotencyKey.split\|\.split(\":\"" src`) that positionally parses key content — every
other consumer treats the key as opaque, matching the design in §6.2.

### 6.4 Migration strategy for in-flight persisted queues (IndexedDB/localStorage)

The followups doc explicitly offers two options (`docs/superpowers/plans/2026-08-09-tier3-followups.md:119-122`):
a one-time forward migration on load (matching the #27 IndexedDB persist-migration pattern,
`scanStoreMigrate` at `src/stores/scanStore.ts:8541`), or accepting that old-format keys simply
continue to work under the backward-compat rule.

**Recommended: no migration.** §6.2's argument applies identically to locally-persisted state as to
Firestore: an old-format key sitting in a user's `pendingSyncQueue` (in IndexedDB via the #27 backing,
or legacy localStorage) is exactly as safe to leave untouched as one already applied server-side. It
will sync correctly under its original format the next time the queue drains, and nothing about the
app's behavior (feed row, count, sync status) depends on the key's internal shape — only on the
key's *existence* and *stability* across retries. Writing a `scanStoreMigrate` version-bump transform
that rewrites persisted `idempotencyKey`/`appliedIdempotencyKeys` strings would be pure surface area
with no correctness benefit — exactly what the Simplicity Challenger angle in `docs/PLAN_EXECUTION.md`
Step 3 exists to catch. It would also violate "never regenerate a key" in spirit (a migration-rewritten
key is functionally a regenerated key, even if it tries to preserve identity) for zero gain.

**What must still be proven, not just no migration:** a regression test (goal 2) hydrates a persisted
blob containing an old-format `PendingSyncItem` (created by an old build, never drained) alongside
freshly-scanned new-format items, and confirms the sync drain applies both correctly with no format
branch anywhere in the drain path.

## 7. Proof that adoption no longer needs ANY key-rewrite step

This is the explicit measure of success named in the followups doc
(`docs/superpowers/plans/2026-08-09-tier3-followups.md:131-133`: *"the whole `rescopePlaceholderQueueItem`
mechanism and its dependent tests become unnecessary (either deleted or proven to be no-ops)"*).

**Honest framing (flagged for the attack panel, not resolved unilaterally here):** `rescopePlaceholderRecord`
/ `rescopePlaceholderQueueItem` do two jobs today — rewrite the plain `businessId` field(s), and rewrite
embedded key content. This plan's design (§6.2) eliminates the SECOND job entirely and proves it via
test (below), which is the job that caused every Loop 0/1 bug (`payload_idempotency_mismatch`, missed
embedded fields). The FIRST job (plain `businessId` field rewrite) is a distinct, much simpler concern —
a direct field copy, not a parse-and-rewrite — that this plan does **not** eliminate, because Firestore
document routing genuinely depends on it. Whether the owner's stated acceptance criterion 3 is satisfied
by "the key-rewrite job is deleted, the business-id-field job remains as a separately-named, much
simpler function" or requires literally deleting `rescopePlaceholderRecord`/`rescopePlaceholderQueueItem`
as named functions is a judgment call this plan makes explicitly and asks the attack panel / owner to
confirm before implementation, rather than silently picking an interpretation.

**Proof plan for the "no key-rewrite step" claim specifically:**
1. A new/updated test in `businessContextRescopeOnHydration.store.test.ts` (replacing the F-5 assertion
   at `:175`, see §5.5) hydrates a placeholder-scoped state (products, scan feed, final counts, needs-
   review queue, pending sync queue — every collection `rescopePlaceholderRecord`/`rescopePlaceholderQueueItem`
   touch today), calls `setBusinessContext` to adopt into a real business, and asserts:
   - Every entity's `businessId` field now equals the real business id.
   - Every entity's `idempotencyKey` (and every `appliedIdempotencyKeys[]` entry, and every embedded
     `payload.idempotencyKey`) is **byte-identical to its pre-adoption value** — proving zero key
     rewriting occurred, not merely that no placeholder string leaked.
2. `rescopeKey` and `PLACEHOLDER_ID_PREFIX` (`src/stores/scanStore.ts:1453-1461`) are deleted from the
   file; if any test still references them, that is itself proof they were not fully unnecessary and
   the attack panel must revisit §6.2.
3. Grep proof at review time: `grep -n "rescopeKey\|PLACEHOLDER_ID_PREFIX" src/stores/scanStore.ts`
   returns nothing.

## 8. TDD steps (failing-first)

Per `docs/PLAN_EXECUTION.md`'s "Process essentials" and `GUARDRAILS.md` ("Tests first (failing test,
then fix)"), every step below is written against **current** code first (where it can fail meaningfully
today), confirmed to fail/not-apply, then made to pass by the corresponding implementation step. All
new tests are additions to existing files unless a new file is named.

1. **New-format dedupe** (`src/services/idempotency.test.ts`): after the signature change, assert
   `buildIdempotencyKey("sess", "evt", "INCREMENT_COUNT") === "sess:evt:INCREMENT_COUNT"` and the
   existing stability/differs-by-operation properties still hold for the 3-arg form. (Fails to compile
   before the fix — that IS the failing-first signal for a breaking-by-design change, matching Item 1's
   documented pattern.)
2. **Old-format dedupe still works** (`src/services/mockDb.test.ts` and a
   `firebaseSyncTarget.rules.test.ts` case): construct a `PendingSyncItem` with a hand-built legacy
   4-segment key (`"biz:sess:evt:INCREMENT_COUNT"`), apply it twice, assert the second call returns
   `alreadyApplied: true` and the count increments exactly once. This passes unchanged before AND after
   the implementation (it proves nothing broke) — include it as a locked-in regression guard, not a
   failing-first case.
3. **Mixed-format collision safety** (new test, `src/services/idempotency.test.ts` or a dedicated
   `idempotencyKeyCompat.test.ts`): mint an old-format key and a new-format key for two DIFFERENT
   logical events that happen to share every non-businessId segment value (e.g. same `sessionId`,
   `scanEventId`, `operation` — construct the old key with an arbitrary businessId prefix), apply both
   through `MockDb` and through the Firestore rules-test harness, and assert BOTH apply as distinct,
   non-colliding writes (each counted once, not deduped against each other). This is the direct proof
   for §6.2's collision-safety argument.
4. **Adoption without any rescope step** (`businessContextRescopeOnHydration.store.test.ts`, replacing
   the F-5 assertion at line 175 per §5.5/§7): failing first against CURRENT code (today's rescope DOES
   rewrite key content, so a "byte-identical before/after" assertion fails today), passing after
   `rescopeKey`/`PLACEHOLDER_ID_PREFIX` are deleted and the two rescope functions stop touching key
   fields.
5. **`idForReview` format-agnostic parse** (new test near existing `idForReview` coverage, or inline in
   `scanStore.test.ts`): construct a review with an old-format (4-segment) key and one with a new-format
   (3-segment) key, assert both recover the correct `scanEventId`. Failing first against the current
   `parts[2]` implementation (breaks on the 3-segment case), passing after the `parts.length - 2` fix.
6. **In-flight persisted queue, no migration needed** (extends an existing hydration/rehydrate test or
   `scanStoreMigrate.test.ts`): hydrate a persisted blob containing an old-format queued item, scan a
   new event (new-format key) in the same session, drain the queue, assert both sync correctly with no
   double count and no dropped item — proving §6.4's "no migration" decision end to end.

## 9. Proof commands (exact)

- `npx vitest run src/services/idempotency.test.ts` — new/updated unit tests for the key builder itself.
- `npx vitest run src/stores/businessContextRescopeOnHydration.store.test.ts` — adoption rescope
  behavior, including the rewritten F-5 assertion.
- `npx vitest run src/services/mockDb.test.ts src/services/db/firebase/firebaseSyncTarget.rules.test.ts` —
  dedupe/collision proof across both sync targets.
- `npm run test:ledger` — crown invariant suite; run for any counting/ledger-adjacent change per
  `AGENTS.md`.
- `npm run test:firebase` — Firestore emulator rules + repository suite; run for any sync/idempotency/
  tenancy change per `AGENTS.md`.
- `npm run test` — full Vitest run (unit + dom projects), confirming no other suite assumed the old
  4-segment key shape.
- `npx tsc --noEmit` — the arity change on `buildIdempotencyKey` must surface every stale call site as
  a compile error; this command is the completeness proof for §5.2's call-site list.
- **Manual grep completeness check** (mirrors Item 1's proof-plan technique):
  `grep -rn "buildIdempotencyKey(" src` compared against a saved pre-change list, to confirm every call
  site was actually touched and none were missed by relying on TypeScript alone.
- **Emulator adopt spot-check** (manual proof, same pattern as the 2026-08-09 checkpoint's
  `e2e/proof/adopt-emulator-spotcheck/`): run `npm run emulators` + `npm run dev:emulator`, scan
  several codes anonymously, sign up/adopt into a real business, confirm `pendingSyncQueue` drains to 0,
  Firestore holds the correct `inventoryCounts` docs, and — new for this plan — confirm via a debugger/
  log inspection that the synced items' `idempotencyKey` values are byte-identical to what was minted
  pre-adoption (no rescope occurred), where the 2026-08-09 checkpoint's spot-check only confirmed counts
  drained correctly, not key-identity stability.

## 10. Risks / trade-offs

- **R1 (Risk Skeptic angle): idempotency contract breakage.** The single highest-consequence mistake
  possible here is a design that causes two DIFFERENT logical events to hash to the SAME
  `_appliedKeys` document, silently swallowing a real scan as "already applied." Mitigated by: dropping
  a field that was never providing collision protection in the first place (§6.2), keeping the
  UUID-bearing segments untouched, and the mixed-format collision test (§8.3) proving it directly rather
  than by argument alone. Residual risk: if any ID-generation path is ever found to be
  deterministic/content-derived rather than UUID-random (see A3 below), this argument weakens and the
  design would need re-review.
- **R2 (Risk Skeptic angle): live-data compatibility tail.** Handled by design (§6.2) rather than by
  process — there is no migration to get wrong because there is nothing to migrate. The main residual
  risk is *documentation/assumption drift*: some future engineer adding a new call site could
  reintroduce a positional-parse assumption (like the current `idForReview`) without realizing key
  format history matters. Mitigate by keeping the §6.3 comment explicit at that call site and adding the
  mixed-format test as a permanent regression guard.
- **R3 (Feasibility Engineer angle): `MockDb.appliedKeys` is a flat, non-business-partitioned array**
  (§5.4). Firestore's per-business path already isolates tenants regardless of key content; `MockDb`
  has no equivalent path-scoping — it dedupes purely on key-string equality within one instance. This is
  judged low-risk in practice because (a) one `MockDb` instance corresponds to one local device's mock
  backend, effectively single-tenant in the app's real usage, and (b) UUID-bearing segments make
  cross-business string collision astronomically unlikely even without businessId. It is nonetheless a
  **pre-existing property being relied on more heavily** by this change (previously businessId gave
  `MockDb` *some* incidental defense-in-depth it will no longer have) and should be an explicit attack
  panel question (§11 A2), not assumed away.
- **R4 (Simplicity Challenger angle): the acceptance-criterion-3 ambiguity (§7).** If the owner's actual
  intent was full deletion of the rescope machinery (not just the key-rewrite portion), this plan's
  scope is narrower than expected and would need revisiting after attack-panel/owner review — flagged
  explicitly rather than guessed past.
- **R5: file size / blast radius.** `src/stores/scanStore.ts` is ~8,700 lines with ~50 call sites for
  one function; a change here touches a large fraction of the file's edit surface even though each
  individual edit (drop one argument) is mechanical. Mitigated by the deliberately-breaking-signature
  technique (§5.2) making every miss a compile error, not a runtime bug.
- **Trade-off accepted:** this plan does NOT attempt to also simplify `rescopePlaceholderRecord`/
  `rescopePlaceholderQueueItem`'s *naming* (they will still exist, doing less) — renaming is left out of
  scope (§12) to keep the diff reviewable and focused on the idempotency-key change itself.

## 11. Attack panel (required before any implementation — `docs/PLAN_EXECUTION.md` Step 3)

Per `GUARDRAILS.md` ("Attack every real plan from multiple angles (incl. Codex) before executing") and
`docs/PLAN_EXECUTION.md` Step 3, this plan must be attacked by Feasibility Engineer, Risk Skeptic,
Simplicity Challenger, and a rotating specialist (recommend **tenant-isolation attacker**, given this
plan touches `businessId` scoping directly) before it reaches the owner. The angles below are the
specific, concrete questions this plan's own scouting surfaced — they are the minimum bar, not an
exhaustive substitute for the attackers' own independent read of the diff once implementation exists.

- **A1 (Feasibility Engineer):** Is the §5.2 call-site list (~50 sites) actually complete and
  line-accurate against the repo state AT IMPLEMENTATION TIME (not at plan-write time)? Re-run
  `grep -n "buildIdempotencyKey(" src/stores/scanStore.ts` fresh and diff against this plan's list
  before starting.
- **A2 (Risk Skeptic / tenant-isolation specialist):** Attack R3 directly — construct (or find) a
  concrete scenario where one `MockDb` instance genuinely serves two different `businessId` values with
  colliding `sessionId`/entity-id segments (e.g. a test harness that reuses a fixed non-UUID id across
  businesses, or a future feature that shares one mock instance across a multi-account dev flow), and
  determine whether §6.2's UUID-collision argument actually holds for every current and near-term ID
  generation path, not just the ones this plan's scouting sampled.
- **A3 (Feasibility Engineer):** Verify — by reading, not assuming — that no `sessionId` or
  entity/scan-event id anywhere in the surveyed call sites is EVER deterministic or content-derived
  (e.g. derived from a barcode, product SKU, or any other value two different businesses could
  plausibly share) rather than `crypto.randomUUID()`/injected-factory random. If any such path exists,
  §6.2's core safety argument needs rework before implementation.
- **A4 (Risk Skeptic):** Confirm the mixed-format collision test (§8.3) is actually adversarial — i.e.,
  it must construct genuinely plausible old/new key pairs (not merely two random unrelated strings that
  trivially don't collide) to be meaningful proof, or explain precisely why true adversarial
  construction is unnecessary given the segment-count/UUID argument.
- **A5 (Simplicity Challenger):** Is deleting `rescopeKey`/`PLACEHOLDER_ID_PREFIX` and shrinking
  `rescopePlaceholderRecord`/`rescopePlaceholderQueueItem` the right amount of change, or does the
  §7 ambiguity mean the RIGHT simplification is actually eliminating those two functions entirely (by
  changing how/when `businessId` gets attached to a record in the first place, e.g. deferring it
  until first sync instead of stamping it at scan time under a placeholder) — a materially bigger
  redesign this plan deliberately did not scope? Rule on whether that bigger redesign belongs in this
  item or a separate future item.
- **A6 (Rotating specialist — tenant-isolation):** Does dropping `businessId` from the key content
  create ANY path where a Firestore Rules check, a client-side filter, or a report/export could be
  fooled into cross-tenant data exposure by relying on key content where it should rely on the
  `businessId` field or document path instead? (Scouting in §5.4 found none — rules/validator never
  parse key content — but this must be independently re-verified, not taken on this plan's word.)
- **A7 (Risk Skeptic):** Double-count audit — walk `INCREMENT_COUNT`'s specific path
  (`firebaseSyncTarget.ts:210-233`, `mockDb.ts:120-149`) end to end under the new key format and confirm
  the `scanEventAlreadyCounted` / `seenEvent`/`seenKey` dedupe logic (which reads `scanEventIds` and
  `appliedIdempotencyKeys` arrays, not key format) is genuinely format-independent, not merely assumed
  so by this plan.
- **A8 (Feasibility Engineer):** Confirm `TESTING.md:91` and the `open-source-agents/personas/cribs/ledger.md`
  crib doc (§5.7) are updated in the same PR as the code change, not left stale — the ledger-audit
  persona lens explicitly cites the old signature and could mislead a future review agent if untouched.

## 12. Out of scope

- Actually implementing any of the above — this document is the plan and the attack-panel input only,
  per the followups doc's own framing (Item 2 "needs its own plan + adversarial attack panel before any
  code").
- Renaming `rescopePlaceholderRecord`/`rescopePlaceholderQueueItem` or restructuring their call sites
  beyond removing the now-dead key-rewrite logic (see R5 trade-off).
- Any redesign of WHEN/HOW `businessId` gets attached to a locally-created record (e.g. deferring the
  placeholder stamp) — flagged as a possible bigger idea in A5, explicitly deferred to a future item if
  the attack panel judges it necessary.
- Item 3 (multi-tab same-session scanning) and Item 7 (per-record persist keys) — related persistence
  work but independent scope per the followups doc's own sequencing.
- Any live Firestore data migration/backfill of already-stored old-format keys — explicitly ruled out by
  design (§6.2/§6.4), and would be owner-gated real-data mutation regardless.
- Rewriting `TESTING.md` / crib docs beyond the pointer in §5.7 (implementation-time cleanup, not
  plan-time).

## 13. Files to touch (implementation time — for the attack panel's reference, not for this session)

- `src/services/idempotency.ts` — signature change.
- `src/services/idempotency.test.ts` — format tests.
- `src/stores/scanStore.ts` — ~50 call sites (§5.2), `idForReview` (§6.3), `rescopeKey`/
  `PLACEHOLDER_ID_PREFIX` deletion, `rescopePlaceholderRecord`/`rescopePlaceholderQueueItem` shrink
  (§6.2, §5.3).
- `src/stores/businessContextRescopeOnHydration.store.test.ts` — F-5 assertion rewrite (§5.5, §7).
- `src/services/mockDb.test.ts`, `src/services/db/firebase/firebaseSyncTarget.rules.test.ts`,
  `src/services/db/firebase/markWrongTransfer.rules.test.ts` — dedupe/collision/call-site tests.
- `src/stores/markWrongDurable.store.test.ts` — direct `buildIdempotencyKey` call-site updates.
- New or extended: a mixed-format collision test file (§8.3) — name and location to be decided at
  implementation time, likely colocated with `src/services/idempotency.test.ts`.
- `TESTING.md`, `open-source-agents/personas/cribs/ledger.md` — doc updates (§5.7, A8), non-blocking.
