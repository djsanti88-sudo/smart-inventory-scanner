import "server-only";

import { getAdminDb } from "@/sync-database/cloud/firebaseAdmin";
import { COLLECTIONS, type CatalogEntry as DbCatalogEntry } from "@/sync-database/types";
import { resolveCatalogDocId } from "@/server/catalog/catalogDocId";
import { deletePersistedDecode } from "@/decoding/server/cache/decodeCacheStore";

// Catalog revocation round (owner-approved design, section 2). A shop reports "this scanned
// identity was wrong" via markWrong (see scanStore.ts) -> this transactional function ->
// POST /api/catalog-dispute. Mirrors masterAppend.appendMasterCatalogEntry's transaction shape
// (read existing doc, branch on current state, write inside db.runTransaction) so the same
// read-then-write race that transaction already guards against never opens up here either.
//
// Trust asymmetry (design §2.1): a ladder_verified_strong entry was NEVER eyeballed by a human -
// masterAppend.ts's write gate only required strong app-verified evidence, not human review - so
// ONE dispute demotes it to "disputed" immediately (soft: classifyEntry treats disputed as a miss,
// falling through to a genuine re-decode; never destructive, never "rejected"). A human_verified
// entry (an owner explicitly approved it via /catalog-review) needs THREE distinct businesses
// before the same soft demotion fires - a single confused/hostile tenant must never overturn a
// human decision alone. Full "rejected" tombstone stays exclusively the platformOwner's
// /api/catalog-review/[id] reject action - this function never writes "rejected".
//
// Idempotency (design §2.2 step 3 / §2.5): disputedBy dedupes by businessId - a second dispute
// from the SAME business updates nothing (no re-increment, no re-append) and reports
// changed:false. A hostile tenant spamming this endpoint contributes at most one dispute, ever.
// disputedBy is FIFO-capped (last 50) so the array never grows unbounded; disputeCount is a
// separate, uncapped running total kept even as old disputedBy entries are evicted.

const DISPUTED_BY_CAP = 50;
const HUMAN_VERIFIED_THRESHOLD = 3;
const REASON_MAX_LENGTH = 500;

export interface DisputeCatalogEntryInput {
  canonical: string; // canonicalGtin(normalizedBarcode) - already resolved by the caller (route.ts)
  businessId: string;
  reason?: string;
}

export interface DisputeCatalogEntryDeps {
  db?: FirebaseFirestore.Firestore;
}

export type DisputeCatalogEntryResult =
  | { ok: true; disputeCount: number; changed: boolean; verificationStatus?: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "error"; detail: string };

function sanitizeReason(reason: string | undefined): string | undefined {
  // Reason is untrusted user-entered text (semantic firewall: treat as data, never interpret it).
  // Stored as a plain string, length-capped server-side before it ever reaches Firestore.
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  return trimmed.length > REASON_MAX_LENGTH ? trimmed.slice(0, REASON_MAX_LENGTH) : trimmed;
}

/**
 * Transactional dispute upsert. NEVER swallows a genuine Firestore failure to a fake success
 * (design §2.2 step 6: unlike masterAppend's fire-and-forget append, a dispute is a deliberate
 * user action - the caller (route.ts) must be able to tell the shop their report didn't land).
 */
export async function disputeCatalogEntry(
  input: DisputeCatalogEntryInput,
  deps: DisputeCatalogEntryDeps = {},
): Promise<DisputeCatalogEntryResult> {
  const { canonical, businessId } = input;
  const reason = sanitizeReason(input.reason);

  try {
    const db = deps.db ?? getAdminDb();
    const resolved = await resolveCatalogDocId(db, COLLECTIONS.catalogEntries, canonical);
    if (!resolved) {
      return { ok: false, reason: "not_found" };
    }

    const ref = db.collection(COLLECTIONS.catalogEntries).doc(resolved.id);
    // Moderation trail (disputedBy/auditLog): raw businessId + free-text reasons. The PARENT doc
    // (`catalogEntries/{id}`) is intentionally public-read (sanitized catalog fields only) -
    // Firestore rules cannot field-filter a `get`, so these two fields must never live there. They
    // live in this locked subcollection doc instead (rules: allow read, write: if false - server-only
    // via Admin SDK). Single fixed-id doc so the transaction's read/write count stays small and
    // predictable (one extra doc, not one-doc-per-dispute-event).
    const modRef = ref.collection("moderation").doc("log");

    const result = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
      // Both reads happen before any write (Firestore transaction requirement) - branch, then write.
      const [snap, modSnap] = await Promise.all([tx.get(ref), tx.get(modRef)]);
      const existing: Partial<DbCatalogEntry> = (snap.exists ? (snap.data() as DbCatalogEntry | undefined) : undefined) ?? {};
      const modData: Pick<DbCatalogEntry, "disputedBy" | "auditLog"> =
        (modSnap.exists ? (modSnap.data() as Pick<DbCatalogEntry, "disputedBy" | "auditLog"> | undefined) : undefined) ?? {};
      const now = new Date().toISOString();

      const disputedBy = Array.isArray(modData.disputedBy) ? [...modData.disputedBy] : [];
      const alreadyDisputedByThisBusiness = disputedBy.some((d) => d.businessId === businessId);

      // Already-rejected doc: a dispute must never resurrect or otherwise mutate a human tombstone.
      // Still a no-op success (not an error) - the caller's report is acknowledged, it simply has no
      // effect on an entry a platformOwner already permanently rejected.
      if (existing.verificationStatus === "rejected") {
        return {
          ok: true as const,
          disputeCount: existing.disputeCount ?? 0,
          changed: false,
        };
      }

      if (alreadyDisputedByThisBusiness) {
        // Idempotent no-op on the count (design §2.2 step 3): refresh this business's `at` timestamp
        // only, never re-increment disputeCount and never re-append an auditLog entry. The refresh
        // (and updatedAt bump) go to the moderation doc / parent doc respectively - never merged.
        const refreshedDisputedBy = disputedBy.map((d) => (d.businessId === businessId ? { ...d, at: now } : d));
        tx.set(modRef, { disputedBy: refreshedDisputedBy }, { merge: true });
        tx.update(ref, { updatedAt: now });
        return {
          ok: true as const,
          disputeCount: existing.disputeCount ?? disputedBy.length,
          changed: false,
        };
      }

      const nextDisputeCount = (existing.disputeCount ?? disputedBy.length) + 1;
      const appendedDisputedBy = [...disputedBy, { businessId, at: now }];
      // FIFO cap: keep only the most recent DISPUTED_BY_CAP entries. disputeCount itself is never
      // capped - it is the immutable running total independent of what the array currently holds.
      const cappedDisputedBy =
        appendedDisputedBy.length > DISPUTED_BY_CAP
          ? appendedDisputedBy.slice(appendedDisputedBy.length - DISPUTED_BY_CAP)
          : appendedDisputedBy;

      const auditEntry: { at: string; action: string; by: string; reason?: string } = {
        at: now,
        action: "disputed",
        by: businessId,
        ...(reason ? { reason } : {}),
      };
      const auditLog = Array.isArray(modData.auditLog) ? [...modData.auditLog, auditEntry] : [auditEntry];

      // Trust-asymmetry demotion rule (design §2.1 steps 3/4): ladder_verified_strong demotes on the
      // FIRST dispute (never human-reviewed, cheapest to knock back down); human_verified needs
      // HUMAN_VERIFIED_THRESHOLD distinct businesses before the same soft demotion fires. Any other/
      // unrecognized provenanceTier is treated with the SAME single-dispute demotion as
      // ladder_verified_strong (design's asymmetry is specifically "human-approved is expensive to
      // demote" - anything that isn't explicitly human_verified gets the cheap path, matching
      // classifyEntry's own "unrecognized tier never settles verified" posture).
      const isHumanVerified = existing.provenanceTier === "human_verified";
      const shouldDemote = isHumanVerified ? nextDisputeCount >= HUMAN_VERIFIED_THRESHOLD : true;
      const alreadyDisputed = existing.verificationStatus === "disputed";

      // PARENT (public) doc: disputeCount/verificationStatus/updatedAt ONLY. disputedBy/auditLog
      // NEVER land here (that is the entire fix for the public-read leak - see modRef above).
      const parentUpdate: Record<string, unknown> = {
        disputeCount: nextDisputeCount,
        updatedAt: now,
      };
      if (shouldDemote && !alreadyDisputed) {
        parentUpdate.verificationStatus = "disputed";
      }
      tx.update(ref, parentUpdate);
      tx.set(modRef, { disputedBy: cappedDisputedBy, auditLog }, { merge: true });

      return {
        ok: true as const,
        disputeCount: nextDisputeCount,
        changed: true,
        ...(shouldDemote ? { verificationStatus: "disputed" as const } : {}),
      };
    });

    // L2 decode-cache purge (design §4 "independent replay layers below the master rung"): the
    // persisted decode cache (src/decoding/server/cache/decodeCacheStore.ts) is keyed by the SAME
    // cacheKey the pipeline uses (canonicalGtin(code) ?? code - always the GTIN-canonical form for
    // a GTIN-shaped code, which is exactly what `canonical` already is here), so a stale pre-dispute
    // "result" entry there could keep replaying the wrong identity even after this catalogEntries
    // doc is demoted. Fire-and-forget-adjacent: awaited so the purge genuinely happens before this
    // function returns, but its own failure is swallowed inside deletePersistedDecode itself and
    // must never turn a successful dispute write into an error response.
    if (result.ok && result.changed) {
      void deletePersistedDecode(canonical);
    }

    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", detail };
  }
}
