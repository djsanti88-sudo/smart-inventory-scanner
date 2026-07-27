import "server-only";

// Catalog revocation round (design doc §2.2 step 2): the ONE place that knows the two doc-id
// schemes live in the shared `catalogEntries` collection - masterAppend.ts's own writes use
// "gtin_" + canonicalGtin(normalizedBarcode) (GC6), while the 76,208-row legacy June-25 import
// uses the BARE normalized barcode as the doc id. masterLookup.ts's readEntry() had this exact
// fallback inlined; extracted here so masterLookup.ts and the new catalog-dispute endpoint can
// never drift out of sync on which doc a given canonical GTIN actually resolves to.
//
// Resolution order matches masterLookup.ts's readEntry(): try "gtin_<canonical>" first (what a
// fresh ladder append writes), then fall back to the bare canonical id (what the legacy import
// used). Returns the FIRST doc that exists, or null if neither does. Never throws on its own -
// any Firestore error propagates to the caller exactly as a normal `.get()` rejection would, so
// callers keep their own try/catch semantics (this helper does no swallowing itself).
export interface ResolvedCatalogDoc {
  id: string;
  snap: FirebaseFirestore.DocumentSnapshot;
}

export async function resolveCatalogDocId(
  db: FirebaseFirestore.Firestore,
  collectionName: string,
  canonical: string,
): Promise<ResolvedCatalogDoc | null> {
  const col = db.collection(collectionName);
  const primaryId = `gtin_${canonical}`;
  const primary = await col.doc(primaryId).get();
  if (primary.exists) return { id: primaryId, snap: primary };
  const bare = await col.doc(canonical).get();
  if (bare.exists) return { id: canonical, snap: bare };
  return null;
}
