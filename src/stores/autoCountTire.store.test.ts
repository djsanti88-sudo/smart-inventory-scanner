import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Live-scan auto-count for deterministically-corroborated tires + the poison backstop. The decode RESPONSE
// is mocked (no live AI); these tests prove the STORE's auto-count gate + firewall behave correctly given
// what the server now returns.

// What the server now returns for a corroborated single-provider tire (strong prefix family + specs +
// app-verified exact code): a "verified" decision even though only one provider contributed.
const COOPER_CORROBORATED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", category: "Tire",
    specsShort: "LT245/75R16 120R", specsFull: "", primarySku: "", primaryBarcode: "029142712886", gtin: "",
    upc: "029142712886", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], confidence: 0.92, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "verified", confidence: 0.92, reason: "Verified AI Decode: tire corroborated by prefix family + specs.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
};

// Poison: go-upc maps the tire UPC 745125495781 to a "Manstel rivet kit". Even if the model claimed a
// "verified" decision, the firewall (non-tire product in tire context) MUST block the auto-count.
const MANSTEL_POISON_VERIFIED = {
  providerNames: ["gemini"],
  results: [{
    productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", category: "Hardware",
    specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "745125495781", gtin: "",
    upc: "745125495781", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: ["https://go-upc.com/745125495781"], confidence: 0.92, verifiedFacts: [], guesses: [],
  }],
  decision: { status: "verified", confidence: 0.92, reason: "(poisoned source)", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}
function tireAiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
  return store;
}

describe("live-scan tire auto-count + poison backstop", () => {
  it("a corroborated tire AUTO-COUNTS on live scan (verified, finalCounts +1)", async () => {
    const store = tireAiStore();
    const { restore } = stub(COOPER_CORROBORATED);
    try {
      store.getState().processScan("029142712886");
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.brand === "Cooper");
    expect(prod, "Cooper tire product must be created and counted").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    // scanned code is now a deterministic approved alias (re-scan counts with no AI)
    expect(store.getState().aliases.some((a) => a.cleanCode === "029142712886" && a.approved)).toBe(true);
  });

  it("poison 745125495781 in tire context provisionally counts (firewall flags for review, not verified/approved)", async () => {
    const store = tireAiStore();
    const { restore } = stub(MANSTEL_POISON_VERIFIED);
    try {
      store.getState().processScan("745125495781");
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open"); // routed to review, not auto-verified
    expect(store.getState().finalCounts).toHaveLength(1);
    // provisional product exists but is NOT verified and NOT approved
    const prov = store.getState().products.find((p) => p.provisional === true);
    expect(prov).toBeDefined();
    expect(prov!.verified).toBe(false);
    // the poisoned code was NOT promoted to a trusted alias
    expect(store.getState().aliases.some((a) => a.cleanCode === "745125495781" && a.approved)).toBe(false);
  });
});
