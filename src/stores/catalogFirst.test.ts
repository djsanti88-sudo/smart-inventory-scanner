import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { CatalogEntry, ShopOverride } from "@/services/catalog/catalogTypes";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";

const NOW = "2026-06-14T00:00:00.000Z";
const CODE = "111222333444"; // not a seed alias -> resolver returns needs_review

const SUGGESTED = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "Maybe Snack", brand: "Generic", sourceUrls: [], verifiedFacts: [], guesses: ["g"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}
function verifiedEntry(code: string, name: string): CatalogEntry {
  return sanitizeCatalogEntry(
    { barcode: code, normalizedBarcode: code, name, confidence: 0.9 },
    { now: NOW, verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
  );
}

describe("catalog-first lookup (saves AI tokens; offline-first)", () => {
  it("a verified catalog hit resolves + counts WITHOUT any AI call", () => {
    const store = aiOnStore();
    store.setState({ catalog: [verifiedEntry(CODE, "Catalog Cola")] });
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled(); // AI never consulted
    const prod = store.getState().products.find((p) => p.name === "Catalog Cola");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().feedbackEvents.some((e) => e.type === "found_from_catalog")).toBe(true);
  });

  it("a verified shop override wins over the global catalog (and skips AI)", () => {
    const store = aiOnStore();
    const override: ShopOverride = {
      businessId: DEMO_BUSINESS_ID, normalizedBarcode: CODE, name: "Shop Special", brand: "", category: "",
      size: "", imageUrl: "", productUrl: "", note: "private note", verified: true, createdAt: NOW, updatedAt: NOW, createdBy: "human",
    };
    store.setState({ catalog: [verifiedEntry(CODE, "Catalog Cola")], shopOverrides: [override] });
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().products.some((p) => p.name === "Shop Special")).toBe(true);
    expect(store.getState().products.some((p) => p.name === "Catalog Cola")).toBe(false);
  });

  it("a catalog miss falls through to the AI path", async () => {
    const store = aiOnStore();
    const { spy, restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(spy).toHaveBeenCalled(); // AI was used because catalog had no hit
  });

  it("a non-exact AI product does NOT auto-count (evidence gate); Needs Review + PENDING catalog entry", async () => {
    const store = aiOnStore();
    const { restore } = stub(SUGGESTED);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open"); // not auto-counted
    expect(store.getState().products.find((p) => p.name === "Maybe Snack")).toBeUndefined();
    expect(store.getState().finalCounts).toHaveLength(0);
    const entry = store.getState().catalog.find((e) => e.name === "Maybe Snack");
    expect(entry?.verificationStatus).toBe("pending"); // counted locally; global catalog stays pending
    expect(entry?.verifiedBy).toBeNull();
  });

  it("a human approval writes a VERIFIED catalog entry + records feedback", () => {
    const store = createTestScanStore({ db: new MockDb() }); // AI off by default
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    store.getState().resolveUnknown(review.id, "create_new", { newProduct: { name: "Hand Added" }, applyToCount: true });

    const entry = store.getState().catalog.find((e) => e.name === "Hand Added");
    expect(entry).toBeDefined();
    expect(entry!.verificationStatus).toBe("verified");
    expect(entry!.verifiedBy).toBe("owner");
    expect(store.getState().feedbackEvents.some((e) => e.type === "product_approved")).toBe(true);
  });
});
