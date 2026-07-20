import { describe, it, expect, vi } from "vitest";
import { buildMasterCatalogEntry, appendMasterCatalogEntry, type MasterAppendInput } from "./masterAppend";

function baseInput(overrides: Partial<MasterAppendInput> = {}): MasterAppendInput {
  return {
    normalizedBarcode: "012345678905",
    codeType: "upc_a",
    decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: 0.92 },
    identity: { name: "Widget 100", brand: "Acme", category: "tools" },
    ...overrides,
  };
}

describe("buildMasterCatalogEntry (pure trust gate)", () => {
  // (a) suggested/self-report/vendor_label/x00 -> null
  it("returns null for a suggested (non-verified) decision", () => {
    expect(buildMasterCatalogEntry(baseInput({ decision: { status: "suggested", exactCodeEvidenceVerifiedByApp: true } }))).toBeNull();
  });

  it("returns null for a bare GPT self-report (verified status but app-unverified evidence)", () => {
    expect(buildMasterCatalogEntry(baseInput({ decision: { status: "verified", exactCodeEvidenceVerifiedByApp: false } }))).toBeNull();
  });

  it("returns null for a vendor_label codeType even when verified + app-verified", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "vendor_label" }))).toBeNull();
  });

  it("returns null for an X00 / FNSKU-style non-public codeType", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "x00" }))).toBeNull();
  });

  it("returns null for an empty identity name", () => {
    expect(buildMasterCatalogEntry(baseInput({ identity: { name: "", brand: "Acme" } }))).toBeNull();
  });

  // (b) verified + app-verified + upc_a -> entry with provenanceTier "ladder_verified_strong"
  it("builds a well-formed entry for a strong app-verified public-barcode decode", () => {
    const entry = buildMasterCatalogEntry(baseInput());
    expect(entry).not.toBeNull();
    expect(entry!.provenanceTier).toBe("ladder_verified_strong");
    expect(entry!.verificationStatus).toBe("verified");
    expect(entry!.id).toMatch(/^gtin_/);
    expect(entry!.normalizedBarcode).toBe("012345678905");
    expect(entry!.name).toBe("Widget 100");
    expect(entry!.brand).toBe("Acme");
  });

  it("builds entries for ean_13 and gtin_14 public shapes too", () => {
    expect(buildMasterCatalogEntry(baseInput({ codeType: "ean_13" }))).not.toBeNull();
    expect(buildMasterCatalogEntry(baseInput({ codeType: "gtin_14" }))).not.toBeNull();
  });

  // (c) stray businessId key -> output has none
  it("never leaks a businessId key onto the master payload even if present on the input object", () => {
    const dirtyInput = baseInput() as MasterAppendInput & { businessId?: string };
    dirtyInput.businessId = "biz-should-never-appear";
    const entry = buildMasterCatalogEntry(dirtyInput);
    expect(entry).not.toBeNull();
    expect(entry).not.toHaveProperty("businessId");
    expect(JSON.stringify(entry)).not.toContain("biz-should-never-appear");
  });

  // (f) canonicalGtin null (malformed code despite public codeType) -> builder returns null, no
  // "gtin_null" id ever constructed (review F5).
  it("returns null (never gtin_null) when canonicalGtin cannot resolve a malformed code", () => {
    const entry = buildMasterCatalogEntry(baseInput({ normalizedBarcode: "not-a-gtin-shape" }));
    expect(entry).toBeNull();
  });
});

// ---- Admin-SDK upsert (mocked db, never live Firestore) ----

function makeMockTx(existingData: Record<string, unknown> | undefined, exists: boolean) {
  const setCalls: Array<[unknown, unknown, unknown]> = [];
  const tx = {
    get: vi.fn().mockResolvedValue({ exists, data: () => existingData }),
    set: vi.fn((ref: unknown, data: unknown, opts: unknown) => {
      setCalls.push([ref, data, opts]);
    }),
  };
  return { tx, setCalls };
}

function makeMockDb(txImpl: (tx: unknown) => Promise<unknown>) {
  const docRef = { id: "gtin_012345678905" };
  const collectionDoc = vi.fn(() => docRef);
  const collection = vi.fn(() => ({ doc: collectionDoc }));
  const runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(await txImpl));
  return { collection, runTransaction, docRef } as unknown as FirebaseFirestore.Firestore & {
    collection: typeof collection;
    runTransaction: typeof runTransaction;
  };
}

describe("appendMasterCatalogEntry (Admin-SDK upsert, mocked)", () => {
  const entry = buildMasterCatalogEntry(baseInput())!;

  // (e) write applied with merge semantics at catalogEntries/gtin_<canonical> inside runTransaction
  it("writes with merge semantics at the deterministic gtin_<canonical> doc id", async () => {
    const { tx, setCalls } = makeMockTx(undefined, false);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(tx.get).toHaveBeenCalledOnce();
    expect(setCalls).toHaveLength(1);
    const [, data, opts] = setCalls[0];
    expect(opts).toEqual({ merge: true });
    expect((data as Record<string, unknown>).provenanceTier).toBe("ladder_verified_strong");
    expect((db.collection as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("catalogEntries");
  });

  // (d) mocked existing doc human_verified -> "skipped_human", write not applied (transaction path)
  it("skips (no downgrade) when the existing doc is already human_verified", async () => {
    const { tx, setCalls } = makeMockTx({ provenanceTier: "human_verified" }, true);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("skipped_human");
    expect(setCalls).toHaveLength(0);
  });

  it("allows overwrite (retry idempotency) when the existing doc is NOT human_verified", async () => {
    const { tx, setCalls } = makeMockTx({ provenanceTier: "ladder_verified_strong" }, true);
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("written");
    expect(setCalls).toHaveLength(1);
  });

  it("returns 'error' (never throws) when the transaction rejects", async () => {
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: entry.id })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore down");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    const result = await appendMasterCatalogEntry(entry, { db });
    expect(result).toBe("error");
  });
});
