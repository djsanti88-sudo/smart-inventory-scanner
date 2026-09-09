import type { InventoryCount, PendingSyncItem, Product, ScanEvent, Settings, UnknownCodeReview } from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { DEFAULT_SETTINGS } from "@/stores/scanDefaults";
import { getSeed } from "@/seed/seedData";
import { backfillProducts } from "@/products/polish/backfillProducts";
import { idForReview } from "@/stores/scan/reviewHelpers";

/** Recompute syncStatus on feed/counts/reviews from what remains in the pending queue. */
function recomputeSyncStatus(state: {
  businessId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  pendingSyncQueue: PendingSyncItem[];
}) {
  const tenantQueue = state.pendingSyncQueue.filter((item) => item.businessId === state.businessId);
  const pendingEventIds = new Set(
    tenantQueue.map((p) => p.scanEventId).filter((x): x is string => !!x),
  );
  const erroredEventIds = new Set(
    tenantQueue
      .filter((p) => p.status === "error" || p.status === "quarantined")
      .map((p) => p.scanEventId)
      .filter((x): x is string => !!x),
  );
  const pendingProductIds = new Set(
    tenantQueue
      .filter((p) => p.operation === "INCREMENT_COUNT")
      .map((p) => (p.payload as IncrementPayload).productId),
  );

  const statusFor = (eventId: string): ScanEvent["syncStatus"] =>
    pendingEventIds.has(eventId) ? (erroredEventIds.has(eventId) ? "error" : "pending") : "synced";

  return {
    scanFeed: state.scanFeed.map((e) => ({ ...e, syncStatus: statusFor(e.id) })),
    finalCounts: state.finalCounts.map((c) => ({
      ...c,
      syncStatus: pendingProductIds.has(c.productId) ? ("pending" as const) : ("synced" as const),
    })),
    needsReviewQueue: state.needsReviewQueue.map((r) => ({
      ...r,
      syncStatus: pendingEventIds.has(idForReview(r)) ? ("pending" as const) : ("synced" as const),
    })),
  };
}

// v3 hotfix: earlier versions could persist AI-auto-accepted (poisoned) products/aliases.
// We cannot reliably tell poisoned from good learned data, so reset products/aliases to clean
// verified seed and clear session/queues. User settings are preserved (merged with new
// defaults). Use the in-app "Clear local cache" button for a full wipe including the mock DB.
// v4 (Sec-4): the customer-data wipe of any legacy sensitive localStorage keys (aliases/catalog/
// raw codes) is enforced by the role-aware `partialize` below on the first post-hydration write
// (which defaults to the customer-safe shape until the user is proven to be the platformOwner).
// v5: auto-purge the poisoned duplicates (e.g. the ~235 "Manstel rivet kit" rows saved on the
// non-matching code 745125495781) by resetting products/aliases to clean verified seed on next load.
// v6 (Task 4 backfill): THIS APP HAS NO SERVER-SIDE PRODUCT JSON/DB IN LOCAL/MOCK MODE - products
// live ONLY in this persisted browser state, so the "backfill" for real users runs here, at next
// load, instead of a script touching a file. Unlike v3/v5, a version-5 install is NOT reset (its
// products are real, not poisoned) - existing rows are kept and simply gain structured fields via
// the same skip-human-stamped rule as scripts/polish-backfill.mts (see backfillProducts.ts, shared
// by both). Only installs older than v5 still get the full poison-cleanup reset (unchanged), with
// structuring applied to the resulting seed as a no-op convenience.
//
// v7 (Task 3.5): adds `countSnapshots` (rolling variance/shrinkage-report history, capped at 12 by
// snapshotCount). No prior version persisted this field, so every install - reset (<5) or additive
// (>=5) - simply needs it defaulted to []. An install that already has a countSnapshots array (e.g.
// a fresh v7 write, or a future migrate step run twice) keeps it untouched: never clobber real data.
//
// v9 (Phase 4 Task 10): adds `UnknownCodeReview.importQuantity` (optional). No migrate transform is
// needed - the field is undefined-safe on every existing persisted review, and the v8 rule (never
// inject an absent needsReviewQueue/products/etc. key into a partial blob) already holds unchanged.
//
// TOP-LEVEL LAW guard, LAYER A (persist-corruption defect, 2026-08-13): a wrong-SHAPE (but still
// parseable) persisted value - e.g. `products: "not-an-array"` written by a corrupted IndexedDB/
// localStorage record - previously flowed straight through zustand's persist rehydrate into the live
// store whenever the persisted `version` matched the CURRENT persist version (14): zustand only calls
// `migrate` when the stored version DIFFERS from `version` (node_modules/zustand/esm/middleware.mjs),
// but its `merge` step runs UNCONDITIONALLY on every hydrate (migrated or not). A bare-string
// `products` then reached `collectAllIdentifierHits` (aliasMatcher.ts), whose `products.filter(...)`
// threw, and that throw propagated out of `processScan` - silently dropping the scan (feed "0 scans",
// count 0), a direct TOP-LEVEL LAW violation.
//
// This is the single shared sanitizer for every field whose LIVE-CODE dereferences would throw on a
// wrong shape: it is wired into the persist `merge` option below (which runs on EVERY hydrate,
// migrated or not - so it closes exactly the version-matches-current gap that `migrate` cannot see)
// and is also reused, defensively, at the top of `processScan` (LAYER B). A field of the wrong shape
// is coerced to a safe default with a loud `console.warn` (never silently dropped) rather than left
// to poison every downstream `.filter`/`.map`/`.find`/property-read call across the store and
// services layer.
//
// THIRD-REVIEW HARDENING (2026-08-16): an independent clean-room review found the guard above only
// closed ONE variant of the root cause - "shape validation that only checks the top level" - and
// missed two siblings:
//   (a) OBJECT-shaped fields (e.g. `settings: null`) were never checked at all, so
//       `get().settings.scanContext` at processScan's identity-conflict check threw BEFORE
//       ensureProvisionalCount ever ran, silently dropping the scan a second way.
//   (b) A field that IS a valid array can still carry MALFORMED MEMBERS (`[null]`, `["x"]`) that the
//       old top-level-only `Array.isArray` check waved through; a `null`/non-object member then threw
//       on the very first `.status`/`.provisional`/`.primaryBarcode` read (scanStore.ts ~3272-3283,
//       ~3474-3484, ~3546-3548, ~3620-3622) - none of which sit inside the old resolveScan try/catch.
// This table now validates BOTH the container shape and (for array fields) every member's shape, so
// the class - not just the reported instance - is closed. Fields are still opt-in-by-name on purpose:
// an unknown/future persisted field just passes through untouched, exactly like before.
// FINDING 2 HARDENING (Codex clean-room review, 2026-08-16, CRITICAL): the guard above validated the
// container shape and each MEMBER's shape (is it a plain object?), but never the shape of a member's
// own NESTED array fields. A `finalCounts` member that IS a well-formed plain object can still carry
// `scanEventIds: null` (or `aliasesSeen`/`appliedIdempotencyKeys`) - `applyScanEventOnce`
// (services/inventory.ts) then calls `count.scanEventIds.includes(...)` and throws. That throw landed
// INSIDE the Layer C try, so it was caught - but the catch's `ensureProvisionalCount` fallback then
// found this SAME corrupted-but-present count already registered for the code and treated that as
// proof the physical scan had already landed, silently no-op'ing (see the `verifyEventId` fix on
// `ensureProvisionalCount` below for the second half of the closure). `nestedArrayFields` lets a field
// declare which of its members' OWN array properties must also be array-shaped; a corrupted one is
// normalized to [] (never dropped - the surrounding count/event is real data, only the busted nested
// list is unsafe to keep) so the ledger self-heals before any live-code dereference can throw.
type PersistedFieldShape =
  | { kind: "array-of-objects"; default: unknown[]; nestedArrayFields?: string[] }
  | { kind: "array-of-strings"; default: string[] }
  | { kind: "object"; default: object }
  | { kind: "nullable-object"; default: null };

const PERSISTED_FIELD_SHAPES: Record<string, PersistedFieldShape> = {
  products: { kind: "array-of-objects", default: [], nestedArrayFields: ["vendorCodes", "aliases"] },
  aliases: { kind: "array-of-objects", default: [] },
  scanFeed: { kind: "array-of-objects", default: [], nestedArrayFields: ["normalizedCandidates"] },
  // The count ledger's own dedupe/audit trails - the exact fields Finding 2 found silently corrupted.
  finalCounts: {
    kind: "array-of-objects",
    default: [],
    nestedArrayFields: ["scanEventIds", "aliasesSeen", "appliedIdempotencyKeys"],
  },
  needsReviewQueue: {
    kind: "array-of-objects",
    default: [],
    nestedArrayFields: ["normalizedCandidates", "suggestedAliases", "sourceUrls", "verifiedFacts", "guesses"],
  },
  pendingSyncQueue: { kind: "array-of-objects", default: [] },
  catalog: { kind: "array-of-objects", default: [] },
  shopOverrides: { kind: "array-of-objects", default: [] },
  feedbackEvents: { kind: "array-of-objects", default: [] },
  countSnapshots: { kind: "array-of-objects", default: [] },
  sessionHistory: { kind: "array-of-objects", default: [] },
  syncedScanEventIds: { kind: "array-of-strings", default: [] },
  recentLocations: { kind: "array-of-strings", default: [] },
  // settings is dereferenced unguarded (`get().settings.scanContext`, `.aiLookupEnabled`, etc.) all
  // over processScan and elsewhere - a wrong-shape value must never reach the live store.
  settings: { kind: "object", default: DEFAULT_SETTINGS },
  // currentSession / lastCleanupBackup are legitimately nullable (`InventorySession | null`,
  // `CleanupBackup | null`); most reads already use `?.`, but a non-null WRONG-shape value (a string,
  // a number, an array) is still coerced back to the one value every read site treats as "absent".
  currentSession: { kind: "nullable-object", default: null },
  lastCleanupBackup: { kind: "nullable-object", default: null },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported for direct unit testing (scanStore.persistShapeGuard.test.ts) and reused by the persist
 *  `merge` option. Pure, never throws: a non-object input becomes `{}`. Only touches keys that are
 *  actually present on the input (never injects a key a partial blob didn't carry - required by the
 *  v5..v9 migrate contract documented above: an absent key must stay absent, not become an injected
 *  empty default that clobbers a real value merged in from elsewhere). */
export function sanitizePersistedScanShape(persisted: unknown): Record<string, unknown> {
  if (persisted === null || typeof persisted !== "object") return {};
  const out: Record<string, unknown> = { ...(persisted as Record<string, unknown>) };

  for (const [field, shape] of Object.entries(PERSISTED_FIELD_SHAPES)) {
    const value = out[field];
    if (value === undefined) continue; // never inject a key the input didn't carry

    if (shape.kind === "array-of-objects" || shape.kind === "array-of-strings") {
      if (!Array.isArray(value)) {
        console.warn(
          `[scanStore] Persisted '${field}' had the wrong shape (expected an array, got ${typeof value}); ` +
            `resetting it to [] so hydration cannot brick the store or drop a scan. (TOP-LEVEL LAW guard)`,
          value,
        );
        out[field] = [];
        continue;
      }
      const isUsableMember = shape.kind === "array-of-objects" ? isPlainObject : (m: unknown) => typeof m === "string";
      const droppedCount = value.reduce((n, m) => (isUsableMember(m) ? n : n + 1), 0);
      let nextArray: unknown[] = value;
      if (droppedCount > 0) {
        console.warn(
          `[scanStore] Persisted '${field}' contained ${droppedCount} malformed ` +
            `${droppedCount === 1 ? "entry" : "entries"} (expected ` +
            `${shape.kind === "array-of-objects" ? "objects" : "strings"}); dropping ` +
            `${droppedCount === 1 ? "it" : "them"} so a corrupt member cannot brick the store or drop a scan. ` +
            `(TOP-LEVEL LAW guard)`,
          value,
        );
        nextArray = value.filter(isUsableMember);
      }
      // FINDING 2: nested array-shaped fields inside an otherwise well-formed member (e.g.
      // finalCounts[i].scanEventIds: null) - normalize IN PLACE (never drop the whole member; the
      // surrounding count/event is real data) so a downstream `.includes(...)`/`.map(...)` on that
      // nested field can never throw and silently take the scan-drop path.
      if (shape.kind === "array-of-objects" && shape.nestedArrayFields && shape.nestedArrayFields.length > 0) {
        let nestedFixed = 0;
        const mappedArray = nextArray.map((member) => {
          if (!isPlainObject(member)) return member;
          let patched: Record<string, unknown> | null = null;
          for (const nestedField of shape.nestedArrayFields!) {
            const nestedValue = member[nestedField];
            if (nestedValue !== undefined && !Array.isArray(nestedValue)) {
              patched = patched ?? { ...member };
              patched[nestedField] = [];
              nestedFixed++;
            }
          }
          return patched ?? member;
        });
        if (nestedFixed > 0) {
          nextArray = mappedArray;
          console.warn(
            `[scanStore] Persisted '${field}' contained ${nestedFixed} malformed nested array ` +
              `field(s) (e.g. scanEventIds/aliasesSeen expected to be arrays); normalizing ` +
              `${nestedFixed === 1 ? "it" : "them"} to [] so a corrupted ledger entry cannot brick the ` +
              `store or drop a scan. (TOP-LEVEL LAW guard)`,
            value,
          );
        }
      }
      if (nextArray !== value) out[field] = nextArray;
      continue;
    }

    if (shape.kind === "object") {
      if (!isPlainObject(value)) {
        console.warn(
          `[scanStore] Persisted '${field}' had the wrong shape (expected an object, got ` +
            `${Array.isArray(value) ? "array" : typeof value}); resetting it to defaults so hydration cannot ` +
            `brick the store or drop a scan. (TOP-LEVEL LAW guard)`,
          value,
        );
        out[field] = { ...shape.default };
      }
      continue;
    }

    // nullable-object: null is the valid "absent" value; anything else must be an object.
    if (value !== null && !isPlainObject(value)) {
      console.warn(
        `[scanStore] Persisted '${field}' had the wrong shape (expected an object or null, got ` +
          `${Array.isArray(value) ? "array" : typeof value}); resetting it to null so hydration cannot brick ` +
          `the store or drop a scan. (TOP-LEVEL LAW guard)`,
        value,
      );
      out[field] = null;
    }
  }
  return out;
}

// Exported (Task 4 polish-review fix) so a unit test can call this directly with a v5 persisted-state
// fixture and assert every field survives the migration untouched, without spinning up the full
// zustand persist/localStorage machinery.
export function scanStoreMigrate(persisted: unknown, version: number) {
  const p = (persisted ?? {}) as Record<string, unknown>;
  const existingSnapshots = Array.isArray(p.countSnapshots) ? p.countSnapshots : [];
  // v14 (owner feature, 2026-07-22): adds `sessionHistory` (automatically saved past-session log,
  // capped ring buffer - see sessionHistory.ts). Same unconditional-inject contract as countSnapshots:
  // no prior version persisted this field, so every install defaults it to [] and an install that
  // already has one (e.g. a fresh v14 write) keeps its real data untouched.
  const existingSessionHistory = Array.isArray(p.sessionHistory) ? p.sessionHistory : [];
  if (version < 5) {
    const fresh = getSeed();
    return {
      ...p,
      products: backfillProducts(fresh.products).products,
      aliases: fresh.aliases,
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      countSnapshots: existingSnapshots,
      sessionHistory: existingSessionHistory,
      settings: { ...DEFAULT_SETTINGS, ...((p.settings as Partial<Settings>) ?? {}) },
    } as never;
  }
  // Non-destructive branch (v5..v9 -> v10): transform ONLY keys the persisted blob actually carries.
  // A PARTIAL blob (e.g. the e2e fixture's settings-only seed) must not gain products/scanFeed/
  // countSnapshots/settings/needsReviewQueue keys here - injected empties clobber the seeded initial
  // state when zustand merges the migrated blob over it. Live-caught P2 regression: the v7->v8 bump made
  // this branch run on the settings-only e2e blob for the first time, products became [] while aliases
  // survived, so known scans counted but the count table lost every product row ("No counts yet"). The
  // v8->v9 bump (Phase 4 Task 10, UnknownCodeReview.importQuantity) does not need its own key transform -
  // an absent field on old persisted reviews just stays absent (optional, undefined-safe) - so this
  // branch's existing non-injective shape already satisfies the v9 rule unchanged. The v9->v10 bump
  // (Task 2, owner-reported live bug, 2026-07-20) reuses this SAME `backfillProducts` call below - it
  // now also runs the enrichProductIdentity fill-if-empty pass (see backfillProducts.ts), so a legacy
  // row's blank brand/category/specsShort/specsFull gets filled from its parseable name, exactly once.
  const out: Record<string, unknown> = { ...p };
  if (Array.isArray(p.products)) {
    out.products = backfillProducts(p.products as Product[]).products;
  }
  if (Array.isArray(p.scanFeed)) {
    // P1-handoff fold-in: legacy v7 feed rows may carry a literal quantityDelta:0 (pre-D1).
    // applyScanEventOnce's `?? 1` does not correct a non-nullish 0, so normalize here where the
    // persisted blob is rebuilt.
    out.scanFeed = (p.scanFeed as Array<{ quantityDelta?: number }>).map((row) =>
      row && row.quantityDelta === 0 ? { ...row, quantityDelta: 1 } : row,
    );
  }
  // countSnapshots stays UNCONDITIONAL by documented contract (varianceSnapshot.store.test.ts: pre-
  // snapshot blobs migrate to []). Safe to inject: the initial state is empty too, unlike products.
  out.countSnapshots = existingSnapshots;
  // sessionHistory: same unconditional-inject contract as countSnapshots (see v14 note above).
  out.sessionHistory = existingSessionHistory;
  if (p.settings !== undefined) {
    out.settings = { ...DEFAULT_SETTINGS, ...(p.settings as Partial<Settings>) };
  }
  // v13 self-heal ("if it is resolved, it does not go to review"): an install that hit the old bug
  // (resolveUnknown silently no-op'd on a genuinely settled decode - the fuzzy identity-merge
  // suggest_link path or a dedup conflict - leaving the review "open"/"suggested" forever) gets a
  // one-time stamp here. "Identity already settled" reuses the EXACT two feed-status signals the app
  // itself already treats as settled elsewhere in this file: a scanFeed row for the same cleanCode with
  // status "resolved" (the resolveUnknown relink write, ~scanStore.ts:4738-4743 - implies a real
  // matchedProductId was assigned) or decodeStatus "verified" (markFeedRowVerified, only ever written
  // after resolveUnknown actually resolved the review - see the "never leave a 'Verified AI Decode +
  // Unknown' feed row" guard at ~scanStore.ts:3401-3408). Only needsReviewQueue rows are mutated here;
  // scanFeed and finalCounts are read-only inputs and are never touched by this step. Never injects an
  // absent needsReviewQueue key into a partial blob (same v8 rule as the rest of this branch).
  if (Array.isArray(p.needsReviewQueue)) {
    const feed = Array.isArray(p.scanFeed) ? (p.scanFeed as Array<{ cleanCode?: string; status?: string; decodeStatus?: string }>) : [];
    const settledCleanCodes = new Set(
      feed
        .filter((e) => e && (e.status === "resolved" || e.decodeStatus === "verified"))
        .map((e) => e.cleanCode)
        .filter((c): c is string => Boolean(c)),
    );
    out.needsReviewQueue = (p.needsReviewQueue as Array<{ cleanCode?: string; status?: string }>).map((r) =>
      r && (r.status === "open" || r.status === "suggested") && r.cleanCode && settledCleanCodes.has(r.cleanCode)
        ? { ...r, status: "resolved" as const, resolvedAt: new Date().toISOString(), resolvedBy: "auto", resolutionAction: "create_new" as const }
        : r,
    );
  }
  return out as never;
}
export { PERSISTED_FIELD_SHAPES, recomputeSyncStatus };
