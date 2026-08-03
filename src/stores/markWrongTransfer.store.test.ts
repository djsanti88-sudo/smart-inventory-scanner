import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";

const total = (store: ReturnType<typeof createTestScanStore>) =>
  store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);

// Seed a VERIFIED product + approved alias so the scan resolves "known" and counts against it, then
// markWrong it. The physical quantity must survive as an Unidentified provisional, not vanish.
function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const s = store.getState();
  const productId = "seed-wrong-1";
  store.setState((prev) => ({
    products: [...prev.products, {
      id: productId, businessId: s.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
      specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
      vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
      source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
    }],
    aliases: [...prev.aliases, {
      id: "alias-wrong-1", businessId: s.businessId, productId, rawCodeExample: code, cleanCode: code,
      normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
      createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", lastSeenAt: s.sessionId,
      syncStatus: "synced", idempotencyKey: "seed-alias-wrong-1",
    }],
  }));
  return productId;
}

describe("D2: markWrong transfers quantity instead of destroying it", () => {
  it("the mock E2E's cross-category seeded alias still counts each known physical scan before correction", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const code = "049000006346";
    const state = store.getState();
    const productId = "e2e-seed-wrong-1";
    store.setState((prev) => ({
      products: [...prev.products, {
        id: productId, businessId: state.businessId, name: "Wrongly Mapped Item", brand: "TestBrand", category: "misc",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
        vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
        source: "seed", confidence: 1, verified: true, createdAt: state.sessionId, updatedAt: state.sessionId, createdBy: "seed", updatedBy: "seed",
      }],
      aliases: [...prev.aliases, {
        id: "e2e-seed-alias-wrong-1", businessId: state.businessId, productId, rawCodeExample: code, cleanCode: code,
        normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
        createdAt: state.sessionId, updatedAt: state.sessionId, createdBy: "seed", lastSeenAt: state.sessionId,
        syncStatus: "synced", idempotencyKey: "e2e-seed-alias-wrong-1",
      }],
    }));

    const first = store.getState().processScan(code);
    const second = store.getState().processScan(code);

    expect(first?.matchedProductId).toBe(productId);
    expect(second?.matchedProductId).toBe(productId);
    expect(store.getState().finalCounts.find((count) => count.productId === productId)?.quantity).toBe(2);
    expect(store.getState().scanFeed).toHaveLength(2);
  });

  it("marking a counted product wrong keeps total physical quantity constant", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);

    store.getState().processScan(code); // counts against the (wrong) verified product
    store.getState().processScan(code); // qty 2
    expect(total(store)).toBe(2);

    await store.getState().markWrong(productId, { reason: "test" });

    // The wrong product's count is gone, but the 2 physical items survive on an Unidentified provisional.
    expect(total(store), "total physical quantity is invariant across markWrong").toBe(2);
    expect(store.getState().finalCounts.some((c) => c.productId === productId)).toBe(false);
    const unidentified = store.getState().products.find(
      (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === code,
    );
    expect(unidentified, "an Unidentified provisional now carries the quantity").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === unidentified!.id)!.quantity).toBe(2);
  });

  it("a ledger replay after markWrong reproduces the surviving quantity and scanEventIds", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006346";
    const productId = seedKnown(store, code);
    store.getState().processScan(code);
    store.getState().processScan(code);
    await store.getState().markWrong(productId, { reason: "test" });

    const unidentified = store.getState().products.find((p) => p.provisional && p.primaryBarcode === code)!;
    const live = store.getState().finalCounts.find((c) => c.productId === unidentified.id)!;
    const replay = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId)
      .find((c) => c.productId === unidentified.id)!;
    expect(replay.quantity).toBe(live.quantity);
    expect(new Set(live.scanEventIds)).toEqual(new Set(replay.scanEventIds));
  });

  it("PROVISIONAL-WRONG (Task 9 finding): marking a provisional wrong never inflates the total and books balance", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    // Corpus-free code (verified absent from the retail corpus in the Task 9 reproduction) so no
    // prefix-floor/catalog path is involved - the scan lands on a plain Unidentified provisional.
    const code = "697662129691";

    // Two scans of a genuinely unknown code: first mints the provisional and counts, second counts
    // against it. One provisional row, quantity 2.
    store.getState().processScan(code);
    store.getState().processScan(code);
    expect(total(store)).toBe(2);
    const oldProv = store.getState().products.find(
      (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === code,
    );
    expect(oldProv, "the scans counted against a provisional placeholder").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === oldProv!.id)!.quantity).toBe(2);

    // Mark THAT provisional wrong. Bug mechanism (Task 9): step (a) removes its count row, so
    // ensureProvisionalCount's guard no longer sees it and mints a SECOND provisional sharing
    // primaryBarcode === code; the old unordered products.find repoint lookup could then return the
    // OLD provisional and count the same physical scans on two rows - total 2 -> 3.
    await store.getState().markWrong(oldProv!.id, { reason: "test" });

    // Invariant: total physical quantity is unchanged.
    expect(total(store), "total physical quantity is invariant when the wrong product is a provisional").toBe(2);
    // The old provisional never regains a count row.
    expect(
      store.getState().finalCounts.some((c) => c.productId === oldProv!.id),
      "the marked-wrong provisional has no count row",
    ).toBe(false);
    // The full quantity lives on the NEW provisional (same code, different id).
    const newProv = store.getState().products.find(
      (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === code && p.id !== oldProv!.id,
    );
    expect(newProv, "a fresh Unidentified provisional carries the quantity").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === newProv!.id)!.quantity).toBe(2);

    // Books balance: (1) per product, sum of this session's feed deltas === counted quantity.
    const { finalCounts, scanFeed, sessionId } = store.getState();
    const seen = new Set<string>();
    const deltas = new Map<string, number>();
    for (const e of scanFeed) {
      if (e.sessionId !== sessionId || !e.matchedProductId || seen.has(e.id)) continue;
      seen.add(e.id);
      deltas.set(e.matchedProductId, (deltas.get(e.matchedProductId) ?? 0) + (e.quantityDelta ?? 0));
    }
    for (const c of finalCounts) {
      expect(deltas.get(c.productId) ?? 0, `sum(feed deltas) === quantity for ${c.productId}`).toBe(c.quantity);
    }
    // (2) replay reproduces every count and its exact scanEventIds set.
    const replay = replayLedgerCounts(scanFeed, sessionId);
    for (const live of finalCounts) {
      const r = replay.find((x) => x.productId === live.productId);
      expect(r, `replay has a count for ${live.productId}`).toBeDefined();
      expect(r!.quantity, `replay quantity for ${live.productId}`).toBe(live.quantity);
      expect(new Set(live.scanEventIds)).toEqual(new Set(r!.scanEventIds));
    }
  });

  it("EXAMPLE-GATE REGRESSION LOCK: an example barcode marked wrong never dispatches a paid decode and never settles verified", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // AI ON so a paid decode WOULD dispatch if the example-gate ever regressed.
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    // Spy on fetch: a paid decode POST to /api/ai-lookup would flow through here.
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(async () => { throw new Error("no live call allowed"); }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const exampleCode = "4006381333931"; // textbook GS1 example barcode (b4ff79a blocklist)
      const productId = seedKnown(store, exampleCode);
      store.getState().processScan(exampleCode);
      await store.getState().markWrong(productId, { reason: "test" });
      // The transferred provisional stays an Unidentified/needs-review row, never verified.
      const prov = store.getState().products.find((p) => p.provisional && p.primaryBarcode === exampleCode);
      expect(prov).toBeDefined();
      expect(prov!.verified).toBe(false);
      const row = store.getState().scanFeed.find((e) => e.matchedProductId === prov!.id);
      expect(row?.decodeStatus === "verified").toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
