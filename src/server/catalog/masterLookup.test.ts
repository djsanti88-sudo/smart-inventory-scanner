import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupMasterCatalog, __resetMasterLookupMemoForTests } from "./masterLookup";

// Sync Truth Task 4 (owner-approved 2026-07-22, docs/superpowers/plans/2026-07-22-sync-truth-five-steps.md):
// unit tests for the pure master-catalog rung. Firestore is mocked via the injectable `deps.db` seam
// (mirrors masterAppend.test.ts's makeMockDb/makeMockTx pattern), never a live Admin SDK instance.

const GTIN = "086699997654"; // GTIN-shaped, valid-length code; canonicalGtin -> "00086699997654"

function makeDb(getImpl: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>) {
  const docRef = { get: vi.fn(getImpl) };
  const doc = vi.fn(() => docRef);
  const collection = vi.fn(() => ({ doc }));
  return { db: { collection } as unknown as FirebaseFirestore.Firestore, collection, doc, docRef };
}

// Doc-id-aware mock (integration fix 2026-07-22): the real collection mixes masterAppend's
// "gtin_<canonical>" doc ids with 76,208 June-25 imported rows whose doc ids are the BARE
// normalized barcode, so the rung reads gtin_ first then falls back to the bare id.
function makeDbWithDocs(docs: Record<string, Record<string, unknown>>) {
  const gets: string[] = [];
  const doc = vi.fn((id: string) => ({
    get: vi.fn(async () => {
      gets.push(id);
      const entry = docs[id];
      return { exists: entry !== undefined, data: () => entry };
    }),
  }));
  const collection = vi.fn(() => ({ doc }));
  return { db: { collection } as unknown as FirebaseFirestore.Firestore, doc, gets };
}

describe("lookupMasterCatalog (Sync Truth Task 4 free ladder rung)", () => {
  beforeEach(() => {
    __resetMasterLookupMemoForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns miss for a non-GTIN-shaped code without touching Firestore", async () => {
    const { db, collection } = makeDb(async () => ({ exists: false, data: () => undefined }));
    const outcome = await lookupMasterCatalog("not-a-gtin", { db });
    expect(outcome).toEqual({ kind: "miss" });
    expect(collection).not.toHaveBeenCalled();
  });

  it("reads the SAME doc id scheme masterAppend.ts writes: gtin_<canonicalGtin>", async () => {
    const { db, collection, doc } = makeDb(async () => ({ exists: false, data: () => undefined }));
    await lookupMasterCatalog(GTIN, { db });
    expect(collection).toHaveBeenCalledWith("catalogEntries");
    expect(doc).toHaveBeenCalledWith("gtin_00086699997654");
  });

  it("human_verified entry -> settled VERIFIED", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", brand: "Michelin", verificationStatus: "verified", provenanceTier: "human_verified" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "verified", entry });
  });

  it("ladder_verified_strong entry -> settled VERIFIED (fix: rung self-poisoning) - the append gate already required app-verified exact-code evidence at >= 0.8 on a public barcode, so replaying it as verified mirrors the decode-cache replay semantics", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "verified", provenanceTier: "ladder_verified_strong" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "verified", entry });
  });

  it("verified but neither human_verified nor ladder_verified_strong (e.g. an unrecognized/legacy provenanceTier) -> SUGGESTION, never auto-verified", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "verified", provenanceTier: "some_other_tier" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "suggestion", entry });
  });

  it("pending entry -> miss (falls through to the next rung)", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "pending" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("rejected entry -> miss (falls through to the next rung)", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "rejected" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  });

  // Catalog revocation round (design §2.1 step 3 / §3.2): a disputed entry must MISS, regardless of
  // provenanceTier, so the ladder honestly re-decodes instead of replaying a disputed identity. This
  // is the read-side regression test for the new "disputed" verificationStatus - it fails today
  // because classifyEntry has no "disputed" branch at all (any non-"verified" status falls to the
  // generic { kind: "miss" } already, so this test also guards against a FUTURE regression where
  // "disputed" is accidentally treated as verified for a trusted provenanceTier).
  it("disputed entry -> miss (falls through to the ladder), even for ladder_verified_strong", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "disputed", provenanceTier: "ladder_verified_strong" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("disputed entry -> miss even for human_verified provenanceTier", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "disputed", provenanceTier: "human_verified" };
    const { db } = makeDb(async () => ({ exists: true, data: () => entry }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("no entry found -> miss", async () => {
    const { db } = makeDb(async () => ({ exists: false, data: () => undefined }));
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("gtin_-id entry is found FIRST (bare-id fallback never consulted when the primary hits)", async () => {
    const primaryEntry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Primary scheme", verificationStatus: "verified", provenanceTier: "human_verified" };
    const bareEntry = { id: "00086699997654", normalizedBarcode: GTIN, name: "Should not surface", verificationStatus: "verified", provenanceTier: "human_verified" };
    const { db, gets } = makeDbWithDocs({ gtin_00086699997654: primaryEntry, "00086699997654": bareEntry });
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "verified", entry: primaryEntry });
    expect(gets).toEqual(["gtin_00086699997654"]);
  });

  it("bare-id entry (June-25 imported rows) is found via the fallback read after a gtin_ miss", async () => {
    const bareEntry = { id: "00086699997654", normalizedBarcode: "00086699997654", name: "Imported row", verificationStatus: "verified", provenanceTier: "human_verified" };
    const { db, gets } = makeDbWithDocs({ "00086699997654": bareEntry });
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "verified", entry: bareEntry });
    expect(gets).toEqual(["gtin_00086699997654", "00086699997654"]);
  });

  it("both gtin_ and bare doc ids missing -> miss (both ids were actually consulted)", async () => {
    const { db, gets } = makeDbWithDocs({});
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
    expect(gets).toEqual(["gtin_00086699997654", "00086699997654"]);
  });

  it("Firestore read error -> silent miss, never throws", async () => {
    const { db } = makeDb(async () => {
      throw new Error("firestore unavailable");
    });
    await expect(lookupMasterCatalog(GTIN, { db })).resolves.toEqual({ kind: "miss" });
  });

  it("missing/invalid admin db (getAdminDb-equivalent throws synchronously) -> silent miss, never throws", async () => {
    const badDb = {
      collection: () => {
        throw new Error("no credentials configured");
      },
    } as unknown as FirebaseFirestore.Firestore;
    await expect(lookupMasterCatalog(GTIN, { db: badDb })).resolves.toEqual({ kind: "miss" });
  });

  it("a read exceeding the ~1500ms bound falls through silently (simulated via a delayed mock)", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Should never surface", verificationStatus: "verified", provenanceTier: "human_verified" };
    const { db } = makeDb(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ exists: true, data: () => entry }), 5000);
        }),
    );
    const outcome = await lookupMasterCatalog(GTIN, { db });
    expect(outcome).toEqual({ kind: "miss" });
  }, 10000);

  it("TTL memo: two lookups for the same GTIN within the window only read Firestore once", async () => {
    const entry = { id: "gtin_00086699997654", normalizedBarcode: GTIN, name: "Michelin Defender", verificationStatus: "verified", provenanceTier: "human_verified" };
    const { db, docRef } = makeDb(async () => ({ exists: true, data: () => entry }));

    const first = await lookupMasterCatalog(GTIN, { db });
    const second = await lookupMasterCatalog(GTIN, { db });

    expect(first).toEqual({ kind: "verified", entry });
    expect(second).toEqual({ kind: "verified", entry });
    expect(docRef.get).toHaveBeenCalledTimes(1);
  });

  it("TTL memo also caches a miss outcome (no repeated Firestore reads for a known-miss code)", async () => {
    const { db, docRef } = makeDb(async () => ({ exists: false, data: () => undefined }));

    await lookupMasterCatalog(GTIN, { db });
    await lookupMasterCatalog(GTIN, { db });

    // One uncached miss = 2 reads (gtin_ primary + bare fallback); the memo prevents any more.
    expect(docRef.get).toHaveBeenCalledTimes(2);
  });

  it("different GTINs are memoized independently (not collapsed into one cache slot)", async () => {
    const entryA = { id: "gtin_a", normalizedBarcode: GTIN, name: "A", verificationStatus: "verified", provenanceTier: "human_verified" };
    let calls = 0;
    const { db } = makeDb(async () => {
      calls += 1;
      return { exists: true, data: () => entryA };
    });
    const otherCode = "999888777665";

    await lookupMasterCatalog(GTIN, { db });
    await lookupMasterCatalog(otherCode, { db });

    expect(calls).toBe(2);
  });
});
