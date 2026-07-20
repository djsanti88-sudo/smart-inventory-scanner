import "server-only";

import { getAdminDb } from "@/lib/firebaseAdmin";
import { canonicalGtin } from "@/services/upc/gtin";
import { COLLECTIONS, type CatalogEntry as DbCatalogEntry } from "@/services/db/types";

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
}

export type MasterAppendResult = "written" | "skipped_human" | "error";

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
    return result;
  } catch {
    // GC7: an append failure must never break the decode response - the caller fires this
    // fire-and-forget and swallows rejections; this catch is a last-resort safety net.
    return "error";
  }
}
