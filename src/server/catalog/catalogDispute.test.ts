import { describe, it, expect, vi, beforeEach } from "vitest";
import { disputeCatalogEntry } from "./catalogDispute";

const mocks = vi.hoisted(() => ({
  deletePersistedDecode: vi.fn().mockResolvedValue(undefined),
  invalidateDecodeCache: vi.fn(),
  invalidateMasterLookupMemo: vi.fn(),
}));
vi.mock("@/decoding/server/cache/decodeCacheStore", () => ({ deletePersistedDecode: mocks.deletePersistedDecode }));
vi.mock("@/decoding/decodeCache", () => ({ invalidateDecodeCache: mocks.invalidateDecodeCache }));
vi.mock("./masterLookup", () => ({ invalidateMasterLookupMemo: mocks.invalidateMasterLookupMemo }));

// Catalog revocation round (design §2.1/§2.2/§3.1): disputeCatalogEntry is the transactional
// function backing POST /api/catalog-dispute. Firestore is mocked (never live), same
// makeMockTx/makeMockDb shape masterAppend.test.ts already establishes.
//
// M1 spec 1 (catalogEntries public-read leak): disputedBy/auditLog carry raw businessId + free-text
// dispute reasons and must NEVER land on the top-level `catalogEntries/{id}` doc (public read: true).
// They now live in a locked `catalogEntries/{id}/moderation/log` subcollection doc, written in the
// SAME transaction as the parent doc's disputeCount/verificationStatus/updatedAt so the split stays
// atomic. The mock models TWO distinct refs (parent + moderation) so tx.get/tx.update/tx.set can be
// asserted against the correct target.

interface MockRef {
  __kind: "parent" | "moderation";
}

function makeMockTx(
  parentData: Record<string, unknown> | undefined,
  parentExists: boolean,
  modData: Record<string, unknown> | undefined = undefined,
  modExists = false,
) {
  const updateCalls: Array<{ ref: MockRef; data: Record<string, unknown> }> = [];
  const setCalls: Array<{ ref: MockRef; data: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
  const tx = {
    get: vi.fn((ref: MockRef) =>
      Promise.resolve(
        ref.__kind === "moderation"
          ? { exists: modExists, data: () => modData }
          : { exists: parentExists, data: () => parentData },
      ),
    ),
    update: vi.fn((ref: MockRef, data: Record<string, unknown>) => {
      updateCalls.push({ ref, data });
    }),
    set: vi.fn((ref: MockRef, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      setCalls.push({ ref, data, opts });
    }),
  };
  return { tx, updateCalls, setCalls };
}

// resolveCatalogDocId (catalogDocId.ts) reads gtin_<canonical> first, then falls back to the bare
// canonical id - the mock db must answer BOTH .doc(id).get() calls (pre-transaction resolve step)
// in addition to the transaction's own tx.get()/tx.update()/tx.set(). `exists` controls whether the
// primary gtin_ id resolves (mirrors the real resolveCatalogDocId contract for these tests, which
// only ever exercise the primary-id path). The doc object returned also exposes
// `.collection("moderation").doc("log")` -> a stable moderation ref, mirroring the real
// `ref.collection("moderation").doc("log")` call in catalogDispute.ts.
function makeMockDb(tx: ReturnType<typeof makeMockTx>["tx"], exists = true, existingData?: Record<string, unknown>) {
  const parentRef: MockRef = { __kind: "parent" };
  const modRef: MockRef = { __kind: "moderation" };
  const doc = vi.fn((id: string) => ({
    get: vi.fn(async () => ({ exists, data: () => existingData })),
    id,
    collection: vi.fn((name: string) => {
      if (name !== "moderation") throw new Error(`unexpected subcollection ${name}`);
      return { doc: vi.fn((docId: string) => (docId === "log" ? modRef : { __kind: "moderation" })) };
    }),
    ...parentRef,
  }));
  return {
    collection: vi.fn(() => ({ doc })),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as FirebaseFirestore.Firestore;
}

describe("disputeCatalogEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found for a missing doc id", async () => {
    const { tx, updateCalls } = makeMockTx(undefined, false);
    const db = makeMockDb(tx, false);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(updateCalls).toHaveLength(0);
  });

  it("first dispute from a business on a ladder_verified_strong doc: disputeCount 1, demoted to disputed, auditLog appended to the moderation subcollection (NEVER the public parent doc)", async () => {
    const existing = { verificationStatus: "verified", provenanceTier: "ladder_verified_strong" };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a", reason: "marked_wrong" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 1, changed: true, verificationStatus: "disputed" });

    // Parent (public) doc write: disputeCount/verificationStatus/updatedAt ONLY - never disputedBy/auditLog.
    expect(updateCalls).toHaveLength(1);
    const parentPayload = updateCalls[0].data;
    expect(parentPayload.disputeCount).toBe(1);
    expect(parentPayload.verificationStatus).toBe("disputed");
    expect(parentPayload).not.toHaveProperty("disputedBy");
    expect(parentPayload).not.toHaveProperty("auditLog");

    // Moderation (locked) subcollection doc write: disputedBy/auditLog live here instead.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].ref.__kind).toBe("moderation");
    const modPayload = setCalls[0].data;
    expect(Array.isArray(modPayload.disputedBy)).toBe(true);
    expect((modPayload.disputedBy as Array<{ businessId: string }>)[0].businessId).toBe("biz-a");
    expect(Array.isArray(modPayload.auditLog)).toBe(true);
    const auditEntry = (modPayload.auditLog as Array<{ action: string; by: string; reason?: string }>)[0];
    expect(auditEntry.action).toBe("disputed");
    expect(auditEntry.by).toBe("biz-a");
    expect(auditEntry.reason).toBe("marked_wrong");

    // A state-changing dispute purges the L2 persisted decode cache for the disputed code (design
    // §4) so the ladder's own cache layer never keeps replaying the pre-dispute decode.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.deletePersistedDecode).toHaveBeenCalledWith("00012345678905");
  });

  it("waits for L1, master-memo, and L2 invalidation after a successful dispute", async () => {
    const existing = { verificationStatus: "verified", provenanceTier: "ladder_verified_strong" };
    const { tx } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    let releaseL2: (() => void) | undefined;
    mocks.deletePersistedDecode.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseL2 = resolve; }));

    let settled = false;
    const pending = disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db }).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(mocks.deletePersistedDecode).toHaveBeenCalledWith("00012345678905"));

    expect(mocks.invalidateDecodeCache).toHaveBeenCalledWith("00012345678905");
    expect(mocks.invalidateMasterLookupMemo).toHaveBeenCalledWith("00012345678905");
    expect(mocks.deletePersistedDecode).toHaveBeenCalledWith("00012345678905");
    expect(settled).toBe(false);

    releaseL2?.();
    await expect(pending).resolves.toMatchObject({ ok: true, changed: true });
  });

  it("second dispute from the SAME businessId is idempotent: disputeCount stays 1, changed:false, only the moderation doc's 'at' timestamp refreshes", async () => {
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 1 };
    const modData = { disputedBy: [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }], auditLog: [] };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true, modData, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toEqual({ ok: true, disputeCount: 1, changed: false });
    // No-op on the count: an "at" refresh-only update is allowed but disputeCount is not re-incremented,
    // and it never touches the parent's disputeCount/verificationStatus/disputedBy/auditLog.
    if (updateCalls.length > 0) {
      expect(updateCalls[0].data.disputeCount).toBeUndefined();
      expect(updateCalls[0].data).not.toHaveProperty("disputedBy");
      expect(updateCalls[0].data).not.toHaveProperty("auditLog");
    }
    if (setCalls.length > 0) {
      expect(setCalls[0].ref.__kind).toBe("moderation");
    }
    // changed:false -> no cache purge needed, nothing about the entry's identity/status changed.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.deletePersistedDecode).not.toHaveBeenCalled();
  });

  // M1 deep-review fix 3 (distinct-business threshold): the "3 distinct businesses" demotion
  // (HUMAN_VERIFIED_THRESHOLD) and the plain dedup below it both count on `alreadyDisputedByThisBusiness`
  // never mistaking a business for "new" just because it already disputed once. That dedup MUST be
  // sourced solely from the locked moderation subcollection doc (modData.disputedBy) - never from
  // whatever the public parent doc happens to carry, including a STALE/legacy disputedBy field left
  // over from before commit f416404e split the two apart (or not yet purged by the masterAppend.ts
  // migration / the retired scripts/backfill-catalog-moderation.mjs, removed 2026-08-19). If the dedup ever fell back to reading the
  // parent's own disputedBy, a business already recorded in moderation but "missing" from a stale/
  // empty parent field could be double-counted toward the threshold on a second dispute.
  it("distinct-business dedup is sourced ONLY from the moderation subcollection - a business already recorded there counts once even when the parent doc's own (stale) disputedBy field disagrees", async () => {
    const existing = {
      verificationStatus: "disputed",
      provenanceTier: "ladder_verified_strong",
      disputeCount: 1,
      // Stale/legacy parent field that disagrees with moderation (empty, as if never migrated) - must
      // be completely ignored by the dedup and count logic.
      disputedBy: [],
    };
    const modData = { disputedBy: [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }], auditLog: [] };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true, modData, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    // biz-a is already recorded in the moderation doc - a second dispute from biz-a must be deduped
    // (counts once), regardless of the parent's own stale disputedBy field showing no record of it.
    expect(result).toEqual({ ok: true, disputeCount: 1, changed: false });
    if (updateCalls.length > 0) {
      expect(updateCalls[0].data.disputeCount).toBeUndefined();
    }
    if (setCalls.length > 0) {
      const modPayload = setCalls[0].data.disputedBy as Array<{ businessId: string }>;
      // Still exactly one entry for biz-a (a timestamp refresh, never a duplicate append).
      expect(modPayload.filter((d) => d.businessId === "biz-a")).toHaveLength(1);
    }
  });

  it("a different businessId on the same doc increments disputeCount to 2 (moderation doc gains the new business)", async () => {
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 1 };
    const modData = { disputedBy: [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }], auditLog: [] };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true, modData, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-b" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 2, changed: true });
    expect(updateCalls[0].data.disputeCount).toBe(2);
    expect(updateCalls[0].data).not.toHaveProperty("disputedBy");
    const disputedBy = setCalls[0].data.disputedBy as Array<{ businessId: string }>;
    expect(disputedBy.map((d) => d.businessId)).toEqual(["biz-a", "biz-b"]);
  });

  it("human_verified doc: 1st and 2nd distinct-business disputes do NOT flip verificationStatus (threshold 3 not yet hit)", async () => {
    const existing1 = { verificationStatus: "verified", provenanceTier: "human_verified" };
    const { tx: tx1, updateCalls: calls1 } = makeMockTx(existing1, true);
    const db1 = makeMockDb(tx1, true, existing1);
    const r1 = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db: db1 });
    expect(r1).toMatchObject({ ok: true, disputeCount: 1 });
    expect(calls1[0].data.verificationStatus).toBeUndefined();

    const existing2 = { verificationStatus: "verified", provenanceTier: "human_verified", disputeCount: 1 };
    const modData2 = { disputedBy: [{ businessId: "biz-a", at: "t" }], auditLog: [] };
    const { tx: tx2, updateCalls: calls2 } = makeMockTx(existing2, true, modData2, true);
    const db2 = makeMockDb(tx2, true, existing2);
    const r2 = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-b" }, { db: db2 });
    expect(r2).toMatchObject({ ok: true, disputeCount: 2 });
    expect(calls2[0].data.verificationStatus).toBeUndefined();
  });

  it("human_verified doc: the 3rd distinct-business dispute flips verificationStatus to disputed", async () => {
    const existing = { verificationStatus: "verified", provenanceTier: "human_verified", disputeCount: 2 };
    const modData = {
      disputedBy: [
        { businessId: "biz-a", at: "t" },
        { businessId: "biz-b", at: "t" },
      ],
      auditLog: [],
    };
    const { tx, updateCalls } = makeMockTx(existing, true, modData, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-c" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 3, verificationStatus: "disputed" });
    expect(updateCalls[0].data.verificationStatus).toBe("disputed");
  });

  it("already-rejected doc: a new dispute is a no-op on verificationStatus (stays rejected), no write to either doc", async () => {
    const existing = { verificationStatus: "rejected", provenanceTier: "ladder_verified_strong" };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toMatchObject({ ok: true, changed: false });
    // A rejected doc is a human tombstone: dispute is fully a no-op, no write at all (never
    // un-rejects it, never touches disputeCount/disputedBy/auditLog on an already-final entry).
    expect(updateCalls).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
  });

  it("returns a clear error (never swallowed to a generic success) when the transaction throws", async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: true, data: () => ({}) })),
          id: "gtin_012345678905",
          collection: vi.fn(() => ({ doc: vi.fn(() => ({})) })),
        })),
      })),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore down");
      }),
    } as unknown as FirebaseFirestore.Firestore;
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "error") {
      expect(result.detail).toContain("firestore down");
    } else {
      expect.fail("expected an 'error' result");
    }
  });

  it("caps disputedBy array length (FIFO) while disputeCount keeps counting past the cap", async () => {
    const disputedBy = Array.from({ length: 50 }, (_, i) => ({ businessId: `biz-${i}`, at: "t" }));
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 50 };
    const modData = { disputedBy, auditLog: [] };
    const { tx, updateCalls, setCalls } = makeMockTx(existing, true, modData, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-new" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 51 });
    expect(updateCalls[0].data).not.toHaveProperty("disputedBy");
    const newDisputedBy = setCalls[0].data.disputedBy as Array<{ businessId: string }>;
    expect(newDisputedBy).toHaveLength(50);
    expect(newDisputedBy[newDisputedBy.length - 1].businessId).toBe("biz-new");
    expect(newDisputedBy[0].businessId).toBe("biz-1"); // biz-0 evicted (FIFO)
  });
});
