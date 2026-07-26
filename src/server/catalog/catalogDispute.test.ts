import { describe, it, expect, vi, beforeEach } from "vitest";
import { disputeCatalogEntry } from "./catalogDispute";

const mocks = vi.hoisted(() => ({ deletePersistedDecode: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/server/decodeCacheStore", () => ({ deletePersistedDecode: mocks.deletePersistedDecode }));

// Catalog revocation round (design §2.1/§2.2/§3.1): disputeCatalogEntry is the transactional
// function backing POST /api/catalog-dispute. Firestore is mocked (never live), same
// makeMockTx/makeMockDb shape masterAppend.test.ts already establishes.

function makeMockTx(existingData: Record<string, unknown> | undefined, exists: boolean) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const tx = {
    get: vi.fn().mockResolvedValue({ exists, data: () => existingData }),
    update: vi.fn((_ref: unknown, data: Record<string, unknown>) => {
      updateCalls.push(data);
    }),
  };
  return { tx, updateCalls };
}

// resolveCatalogDocId (catalogDocId.ts) reads gtin_<canonical> first, then falls back to the bare
// canonical id - the mock db must answer BOTH .doc(id).get() calls (pre-transaction resolve step)
// in addition to the transaction's own tx.get()/tx.update(). `exists` controls whether the primary
// gtin_ id resolves (mirrors the real resolveCatalogDocId contract for these tests, which only ever
// exercise the primary-id path).
function makeMockDb(tx: ReturnType<typeof makeMockTx>["tx"], exists = true, existingData?: Record<string, unknown>) {
  const doc = vi.fn((id: string) => ({
    get: vi.fn(async () => ({ exists, data: () => existingData })),
    id,
  }));
  return {
    collection: vi.fn(() => ({ doc })),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as FirebaseFirestore.Firestore;
}

describe("disputeCatalogEntry", () => {
  beforeEach(() => {
    mocks.deletePersistedDecode.mockClear();
  });

  it("returns not_found for a missing doc id", async () => {
    const { tx, updateCalls } = makeMockTx(undefined, false);
    const db = makeMockDb(tx, false);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(updateCalls).toHaveLength(0);
  });

  it("first dispute from a business on a ladder_verified_strong doc: disputeCount 1, demoted to disputed, auditLog appended", async () => {
    const existing = { verificationStatus: "verified", provenanceTier: "ladder_verified_strong" };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a", reason: "marked_wrong" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 1, changed: true, verificationStatus: "disputed" });
    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];
    expect(payload.disputeCount).toBe(1);
    expect(payload.verificationStatus).toBe("disputed");
    expect(Array.isArray(payload.disputedBy)).toBe(true);
    expect((payload.disputedBy as Array<{ businessId: string }>)[0].businessId).toBe("biz-a");
    expect(Array.isArray(payload.auditLog)).toBe(true);
    const auditEntry = (payload.auditLog as Array<{ action: string; by: string; reason?: string }>)[0];
    expect(auditEntry.action).toBe("disputed");
    expect(auditEntry.by).toBe("biz-a");
    expect(auditEntry.reason).toBe("marked_wrong");
    // A state-changing dispute purges the L2 persisted decode cache for the disputed code (design
    // §4) so the ladder's own cache layer never keeps replaying the pre-dispute decode.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.deletePersistedDecode).toHaveBeenCalledWith("00012345678905");
  });

  it("second dispute from the SAME businessId is idempotent: disputeCount stays 1, changed:false", async () => {
    const existing = {
      verificationStatus: "disputed",
      provenanceTier: "ladder_verified_strong",
      disputeCount: 1,
      disputedBy: [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }],
    };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toEqual({ ok: true, disputeCount: 1, changed: false });
    // No-op on the count: an "at" refresh-only update is allowed but disputeCount is not re-incremented.
    if (updateCalls.length > 0) {
      expect(updateCalls[0].disputeCount).toBeUndefined();
    }
    // changed:false -> no cache purge needed, nothing about the entry's identity/status changed.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.deletePersistedDecode).not.toHaveBeenCalled();
  });

  it("a different businessId on the same doc increments disputeCount to 2", async () => {
    const existing = {
      verificationStatus: "disputed",
      provenanceTier: "ladder_verified_strong",
      disputeCount: 1,
      disputedBy: [{ businessId: "biz-a", at: "2026-07-20T00:00:00.000Z" }],
    };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-b" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 2, changed: true });
    const payload = updateCalls[0];
    expect(payload.disputeCount).toBe(2);
    const disputedBy = payload.disputedBy as Array<{ businessId: string }>;
    expect(disputedBy.map((d) => d.businessId)).toEqual(["biz-a", "biz-b"]);
  });

  it("human_verified doc: 1st and 2nd distinct-business disputes do NOT flip verificationStatus (threshold 3 not yet hit)", async () => {
    const existing1 = { verificationStatus: "verified", provenanceTier: "human_verified" };
    const { tx: tx1, updateCalls: calls1 } = makeMockTx(existing1, true);
    const db1 = makeMockDb(tx1, true, existing1);
    const r1 = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db: db1 });
    expect(r1).toMatchObject({ ok: true, disputeCount: 1 });
    expect(calls1[0].verificationStatus).toBeUndefined();

    const existing2 = { verificationStatus: "verified", provenanceTier: "human_verified", disputeCount: 1, disputedBy: [{ businessId: "biz-a", at: "t" }] };
    const { tx: tx2, updateCalls: calls2 } = makeMockTx(existing2, true);
    const db2 = makeMockDb(tx2, true, existing2);
    const r2 = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-b" }, { db: db2 });
    expect(r2).toMatchObject({ ok: true, disputeCount: 2 });
    expect(calls2[0].verificationStatus).toBeUndefined();
  });

  it("human_verified doc: the 3rd distinct-business dispute flips verificationStatus to disputed", async () => {
    const existing = {
      verificationStatus: "verified",
      provenanceTier: "human_verified",
      disputeCount: 2,
      disputedBy: [
        { businessId: "biz-a", at: "t" },
        { businessId: "biz-b", at: "t" },
      ],
    };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-c" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 3, verificationStatus: "disputed" });
    expect(updateCalls[0].verificationStatus).toBe("disputed");
  });

  it("already-rejected doc: a new dispute is a no-op on verificationStatus (stays rejected)", async () => {
    const existing = { verificationStatus: "rejected", provenanceTier: "ladder_verified_strong" };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-a" }, { db });
    expect(result).toMatchObject({ ok: true, changed: false });
    // A rejected doc is a human tombstone: dispute is fully a no-op, no write at all (never
    // un-rejects it, never touches disputeCount/disputedBy/auditLog on an already-final entry).
    expect(updateCalls).toHaveLength(0);
  });

  it("returns a clear error (never swallowed to a generic success) when the transaction throws", async () => {
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: true, data: () => ({}) })), id: "gtin_012345678905" })) })),
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
    const existing = { verificationStatus: "disputed", provenanceTier: "ladder_verified_strong", disputeCount: 50, disputedBy };
    const { tx, updateCalls } = makeMockTx(existing, true);
    const db = makeMockDb(tx, true, existing);
    const result = await disputeCatalogEntry({ canonical: "00012345678905", businessId: "biz-new" }, { db });
    expect(result).toMatchObject({ ok: true, disputeCount: 51 });
    const newDisputedBy = updateCalls[0].disputedBy as Array<{ businessId: string }>;
    expect(newDisputedBy).toHaveLength(50);
    expect(newDisputedBy[newDisputedBy.length - 1].businessId).toBe("biz-new");
    expect(newDisputedBy[0].businessId).toBe("biz-1"); // biz-0 evicted (FIFO)
  });
});
