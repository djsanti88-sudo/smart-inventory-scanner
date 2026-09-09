import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// F5 bundle-surgery (wave 2, 2026-07-20): the 2.3MB derived prefix map left the client bundle, so a
// DERIVED-tier-only prefix (e.g. 5603344 -> "General", Continental family) no longer resolves
// synchronously at scan time. The contract this suite pins down:
//   1. TOP-LEVEL LAW unchanged: the scan appears + counts IMMEDIATELY with the safe bare
//      "Unidentified item" label - the enrichment fetch never gates or delays that.
//   2. The async /api/prefix-floor enrichment then upgrades the SAME row's name/brand in place.
//   3. Offline / failed fetch: the label silently stays bare - no error, no lost count.
//   4. A row that got a REAL identity while the fetch was in flight is never clobbered.

const DERIVED_CODE = "5603344000016"; // derived-tier-only prefix, valid GS1 check digit
const FLOOR = { name: "General (Continental family) / product unconfirmed", brand: "General", familyLabel: "Continental family" };

function floorFetchStub(body: unknown = { floor: FLOOR }) {
  const spy = vi.fn(async (url: string) => {
    if (String(url).includes("/api/prefix-floor")) {
      return { ok: true, json: async () => body } as Response;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function totalQty(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

async function flushEnrichment() {
  // enrichPrefixFloorLabel defers by setTimeout(0) then awaits one fetch round-trip.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scanStore - async DERIVED-tier prefix-floor enrichment (F5 bundle-surgery)", () => {
  it("LAW: the scan appears + counts IMMEDIATELY with the bare label, before any enrichment resolves", () => {
    floorFetchStub();
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false }); // synchronous provisional count path
    store.getState().processScan(DERIVED_CODE);

    // Synchronously - zero awaits - the row is already counted with the safe fallback.
    expect(totalQty(store)).toBe(1);
    const prod = store.getState().products.find((p) => p.primaryBarcode === DERIVED_CODE);
    expect(prod).toBeDefined();
    expect(prod!.name).toBe(`Unidentified item (barcode ${DERIVED_CODE})`);
    expect(prod!.verified).toBe(false);
    expect(prod!.provisional).toBe(true);
  });

  it("the async enrichment upgrades the SAME row to the brand-confident floor name (still unverified)", async () => {
    const spy = floorFetchStub();
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan(DERIVED_CODE);

    await flushEnrichment();

    expect(spy).toHaveBeenCalledWith(`/api/prefix-floor?code=${DERIVED_CODE}`);
    const prod = store.getState().products.find((p) => p.primaryBarcode === DERIVED_CODE);
    expect(prod!.name).toBe("General (Continental family) / product unconfirmed");
    expect(prod!.brand).toBe("General");
    expect(prod!.verified).toBe(false); // naming aid only, NEVER verified
    expect(prod!.provisional).toBe(true);
    expect(totalQty(store), "enrichment never re-counts").toBe(1);
  });

  it("offline / failed fetch: the label silently stays bare and the count is untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan(DERIVED_CODE);

    await flushEnrichment();

    const prod = store.getState().products.find((p) => p.primaryBarcode === DERIVED_CODE);
    expect(prod!.name).toBe(`Unidentified item (barcode ${DERIVED_CODE})`);
    expect(totalQty(store)).toBe(1);
  });

  it("a SEED-tier prefix still resolves synchronously at scan time (no fetch needed, unchanged behavior)", async () => {
    const spy = floorFetchStub();
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("051596000004"); // curated SEED prefix -> United Solutions

    const prod = store.getState().products.find((p) => p.primaryBarcode === "051596000004");
    expect(prod!.name).toBe("United Solutions / product unconfirmed"); // synchronous, instant
    await flushEnrichment();
    expect(spy, "no enrichment fetch for a code the client-safe lookup already resolved").not.toHaveBeenCalled();
  });

  it("never clobbers a row that got a REAL name before the deferred check ran (renamed in the same tick)", async () => {
    const spy = floorFetchStub();
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan(DERIVED_CODE);
    // Simulate a same-tick identity landing (catalog hit / human edit) before the deferred check.
    const prodId = store.getState().products.find((p) => p.primaryBarcode === DERIVED_CODE)!.id;
    store.setState((s) => ({
      products: s.products.map((p) => (p.id === prodId ? { ...p, name: "Real Decoded Product" } : p)),
    }));

    await flushEnrichment();

    expect(spy, "pre-fetch bare-label check skips the network call entirely").not.toHaveBeenCalled();
    expect(store.getState().products.find((p) => p.id === prodId)!.name).toBe("Real Decoded Product");
  });
});
