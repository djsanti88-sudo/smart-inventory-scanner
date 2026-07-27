import "server-only";

import { getAdminDb } from "@/lib/firebaseAdmin";
import { canonicalGtin } from "@/services/upc/gtin";
import { COLLECTIONS, type CatalogEntry as DbCatalogEntry } from "@/services/db/types";
import { ladderStorage, type LadderStorage } from "@/server/upc/storage";

// P5b Task 1 (master-truth write path, GC3/GC5/GC6/GC7/GC8): a strong app-verified ladder decode on a
// PUBLIC barcode shape appends (idempotently) to the top-level Firestore `catalogEntries` master
// catalog via the Admin SDK. This module is SERVER-ONLY ("server-only" is the FIRST import so a build
// fails if it is ever pulled into a client bundle - mirrors src/server/upc/*).
//
// GC3: literal top-level `catalogEntries` via getAdminDb() directly - NEVER a tenant/business
// subcollection helper. The builder strips + asserts absence of `businessId` (defense in depth: a
// scan-derived payload very plausibly has businessId sitting right next to product fields).
//
// GC6: doc id = "gtin_" + canonicalGtin(normalizedBarcode). canonicalGtin returns null for non-GTIN
// input (review F5) - the builder must return null then, NEVER construct a "gtin_null" id (that would
// collapse every non-GTIN append into one corrupted shared document). The human_verified no-downgrade
// check runs INSIDE db.runTransaction so the read-then-write race is removed outright.

const PUBLIC_CODE_TYPES = new Set(["upc_a", "ean_13", "gtin_14"]);

export interface MasterAppendInput {
  normalizedBarcode: string;
  codeType: string; // must be one of upc_a | ean_13 | gtin_14 (public shapes) or the builder returns null
  decision: { status: string; exactCodeEvidenceVerifiedByApp?: boolean; confidence?: number };
  identity: { name?: string; brand?: string; category?: string };
}

/**
 * Pure trust gate + payload builder. Returns null unless:
 *   - decision.status === "verified"
 *   - decision.exactCodeEvidenceVerifiedByApp === true
 *   - codeType is a public barcode shape (upc_a | ean_13 | gtin_14)
 *   - identity.name is non-empty
 *   - canonicalGtin(normalizedBarcode) resolves (never null - GC6/review F5)
 * Output NEVER contains a `businessId` key (stripped + asserted via an explicit key filter - GC3).
 */
export function buildMasterCatalogEntry(input: MasterAppendInput): DbCatalogEntry | null {
  const { normalizedBarcode, codeType, decision, identity } = input;

  if (decision.status !== "verified") return null;
  if (decision.exactCodeEvidenceVerifiedByApp !== true) return null;
  // Max-review (confidence floor): status "verified" + app-verified evidence is NOT sufficient on its
  // own. clampConfidenceThreshold (decodePolicy.ts) only floors the REQUEST threshold at 0.6, so a
  // hand-crafted POST with confidenceThreshold:0.6 could settle a 0.6-0.79-confidence "verified" and
  // mint it into the shared cross-tenant `catalogEntries` master store. The documented decode invariant
  // (CLAUDE.md decode rules: verified requires confidence >= 0.8) MUST be re-enforced here as a HARD
  // server-side floor, independent of any request-supplied threshold. Undefined confidence never clears it.
  if (typeof decision.confidence !== "number" || decision.confidence < 0.8) return null;
  if (!PUBLIC_CODE_TYPES.has(codeType)) return null;
  const name = (identity.name ?? "").trim();
  if (!name) return null;

  // GC6 / review F5: canonicalGtin returns null for malformed/non-GTIN codes despite a "public"
  // codeType claim. Never fall back to constructing a "gtin_null" id - that would silently collapse
  // every such append into one shared, corrupted document.
  const canonical = canonicalGtin(normalizedBarcode);
  if (!canonical) return null;

  const id = `gtin_${canonical}`;

  // GC5: app-verified ladder decode -> "ladder_verified_strong". No other tier is minted by this phase.
  const candidate: DbCatalogEntry = {
    id,
    normalizedBarcode,
    name,
    brand: identity.brand?.trim() || undefined,
    category: identity.category?.trim() || undefined,
    verificationStatus: "verified",
    provenanceTier: "ladder_verified_strong",
  };

  // GC3 defense in depth: strip + assert no businessId key can ever reach the master payload, even if
  // a caller's `identity`/`decision` object was carelessly built from a tenant-scoped scan context that
  // has businessId sitting right next to product fields (the exact ergonomic trap the scout flagged).
  const sanitized = { ...candidate } as DbCatalogEntry & { businessId?: unknown };
  delete sanitized.businessId;
  if ("businessId" in sanitized) {
    throw new Error("buildMasterCatalogEntry: businessId leaked into master payload");
  }
  return sanitized;
}

export interface MasterAppendDeps {
  db?: FirebaseFirestore.Firestore;
  storage?: LadderStorage;
}

export type MasterAppendResult = "written" | "skipped_human" | "skipped_rejected" | "error";

// Task 2 (owner steps 1+2, outcome visibility): appendMasterCatalogEntry used to swallow every
// failure into a bare "error" with no durable signal anywhere - zero catalogEntries had been
// created since June 26 despite hundreds of July decodes, and nothing surfaced that silently.
// This counter reuses the existing ladderStorage()/ladder_kv KV pattern (same seam the daily AI
// spend cap and Go-UPC usage counters already use) so the written/skipped_human/skipped_rejected/error tally, the
// last error reason, and its timestamp are all durable and inspectable without adding a new store.
const KV_KEY_WRITTEN = "master_catalog_append:written";
const KV_KEY_SKIPPED_HUMAN = "master_catalog_append:skipped_human";
const KV_KEY_SKIPPED_REJECTED = "master_catalog_append:skipped_rejected";
const KV_KEY_ERROR = "master_catalog_append:error";
const KV_KEY_LAST_ERROR_REASON = "master_catalog_append:last_error_reason";
const KV_KEY_LAST_ERROR_AT = "master_catalog_append:last_error_at";

/** true once this process has console.error'd its first append failure (never re-logged after). */
let firstErrorLoggedThisProcess = false;

async function recordOutcome(
  outcome: MasterAppendResult,
  storage: LadderStorage | undefined,
  errorReason?: string,
): Promise<void> {
  try {
    const store = storage ?? (await ladderStorage());
    const key =
      outcome === "written" ? KV_KEY_WRITTEN
      : outcome === "skipped_human" ? KV_KEY_SKIPPED_HUMAN
      : outcome === "skipped_rejected" ? KV_KEY_SKIPPED_REJECTED
      : KV_KEY_ERROR;
    await store.increment(key);
    if (outcome === "error" && errorReason) {
      await store.set(KV_KEY_LAST_ERROR_REASON, errorReason);
      await store.set(KV_KEY_LAST_ERROR_AT, new Date().toISOString());
    }
  } catch {
    // The counter is observability-only (GC7 sibling rule): a storage failure recording the
    // outcome must never surface as an append failure, and never throws back to the caller.
  }
}

/** Test-only: reset the first-error-per-process console.error latch between test files/cases. */
export function __resetMasterAppendErrorLatchForTests(): void {
  firstErrorLoggedThisProcess = false;
}

/**
 * Admin-SDK idempotent upsert (GC6). Retries land on the SAME doc id (merge semantics). The
 * human_verified no-downgrade check runs INSIDE the transaction (review F6) - if an existing doc
 * already carries provenanceTier "human_verified", a ladder-verified append must never downgrade it.
 * deps.db is injectable so unit tests never touch a live Firestore instance.
 */
export async function appendMasterCatalogEntry(
  entry: DbCatalogEntry,
  deps: MasterAppendDeps = {},
): Promise<MasterAppendResult> {
  try {
    const db = deps.db ?? getAdminDb();
    const ref = db.collection(COLLECTIONS.catalogEntries).doc(entry.id);
    const result = await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = snap.data() as DbCatalogEntry | undefined;
        if (existing?.provenanceTier === "human_verified") {
          return "skipped_human" as const;
        }
        // Re-append trap: an owner-REJECTED entry is a human decision too (catalog-review reject
        // writes verificationStatus "rejected"). A later strong ladder decode of the same code must
        // never silently flip it back to verified - skip with its own honest outcome.
        if (existing?.verificationStatus === "rejected") {
          return "skipped_rejected" as const;
        }
        // Re-append trap (catalog revocation round, design §2.4b): a "disputed" doc (a shop reported
        // the identity was wrong - see catalogDispute.ts) must never be silently re-verified by the
        // very next strong ladder decode of the same code either. Unlike "rejected" (fully skipped),
        // the fresh decode result IS useful evidence, so it lands as a "pending" re-candidate for the
        // reviewing human instead of being discarded - but verificationStatus is demoted from the
        // entry's own "verified" to "pending" and the dispute history (disputeCount/disputedBy/
        // auditLog) is preserved untouched so the reviewer sees both the fresh evidence and the
        // dispute trail together.
        if (existing?.verificationStatus === "disputed") {
          const { id: _id, ...rest } = entry;
          void _id;
          tx.set(
            ref,
            {
              ...rest,
              verificationStatus: "pending",
              updatedAt: new Date().toISOString(),
              ...(existing.disputeCount !== undefined ? { disputeCount: existing.disputeCount } : {}),
              ...(existing.disputedBy !== undefined ? { disputedBy: existing.disputedBy } : {}),
              ...(existing.auditLog !== undefined ? { auditLog: existing.auditLog } : {}),
            },
            { merge: true },
          );
          return "written" as const;
        }
      }
      const { id: _id, ...rest } = entry;
      void _id;
      tx.set(
        ref,
        { ...rest, updatedAt: new Date().toISOString() },
        { merge: true },
      );
      return "written" as const;
    });
    void recordOutcome(result, deps.storage);
    return result;
  } catch (err) {
    // GC7: an append failure must never break the decode response - the caller fires this
    // fire-and-forget and swallows rejections; this catch is a last-resort safety net. It still
    // must never THROW itself, so the real reason is captured here (not discarded) instead of
    // inside a nested try that could itself explode the caller's fire-and-forget chain.
    const reason = err instanceof Error ? err.message : String(err);
    if (!firstErrorLoggedThisProcess) {
      firstErrorLoggedThisProcess = true;
      console.error("[masterAppend] appendMasterCatalogEntry failed (first occurrence this process):", reason);
    }
    void recordOutcome("error", deps.storage, reason);
    return "error";
  }
}
