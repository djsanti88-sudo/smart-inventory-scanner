import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import type { Product } from "@/types";

// Reverse-UPC heads-up (platformOwner safety): when a decode SUGGESTS a product that is ALREADY in the
// shop's own catalog/products under a DIFFERENT barcode than the one scanned, the Needs Review item gets a
// reverseUpcConflictNote so the owner is warned (likely mis-scan / duplicate / wrong code). It is a WARNING
// ONLY - it never counts, never creates an approved alias, never changes identity truth.

const SCANNED = "555000555000"; // a code NOT already on file
const ON_FILE = "012345678905"; // the barcode the product is already filed under

const SUGGEST_ACME = {
  providerNames: ["gemini"],
  results: [{ productName: "Acme Widget", brand: "Acme", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.5, verifiedFacts: [], guesses: [] }],
  decision: { status: "needs_review", confidence: 0.5, reason: "Needs review", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return () => (globalThis.fetch = original);
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("reverse-UPC heads-up wiring", () => {
  it("flags the review when the suggested product already exists under a DIFFERENT code (no count, no approved alias)", async () => {
    const store = aiOnStore();
    store.setState({
      products: [{ id: "p-acme", name: "Acme Widget", brand: "Acme", primaryBarcode: ON_FILE, verified: true, status: "active", quantity: 1 } as unknown as Product],
      aliases: [],
    });
    const restore = stub(SUGGEST_ACME);
    try {
      store.getState().processScan(SCANNED);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === SCANNED)?.decodeStatus).not.toBe("decoding"),
      );
    } finally {
      restore();
    }

    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === SCANNED);
    expect(review, "a review exists for the scanned code").toBeDefined();
    expect(review!.reverseUpcConflictNote ?? "", "note warns it is already on file under the other code").toContain(ON_FILE);
    // WARNING ONLY - never changes counting or learns an alias.
    expect(store.getState().finalCounts.length, "the warning never counts").toBe(0);
    expect(store.getState().aliases.some((a) => a.cleanCode === SCANNED && a.approved), "the warning never creates an approved alias").toBe(false);
  });

  it("stays silent (inert) when the suggested product is NOT already in the shop catalog", async () => {
    const store = aiOnStore();
    store.setState({ products: [], aliases: [] });
    const restore = stub(SUGGEST_ACME);
    try {
      store.getState().processScan(SCANNED);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.find((r) => r.cleanCode === SCANNED)?.decodeStatus).not.toBe("decoding"),
      );
    } finally {
      restore();
    }
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === SCANNED);
    expect(review?.reverseUpcConflictNote ?? "", "no note when nothing in our data matches").toBe("");
  });
});
