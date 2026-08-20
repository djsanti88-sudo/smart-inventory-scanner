import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// OPTION 3 (owner): a NON-public code (SKU / vendor / internal / FNSKU / alphanumeric) auto-counts when the
// app independently confirmed the exact code in a real/trusted source - "Gemini found it on Amazon = enough".
// It counts + makes a SHOP-LOCAL approved alias (instant next scan) but NEVER a global cross-shop catalog
// write (those codes are seller-specific). An evidence-LESS guess still never counts (Velvet Torch stays dead).

const FNSKU = "X004DY7YUT";

// Verified non-public decode: app confirmed the exact code in a TRUSTED source (amazon url_only -> verified).
const VERIFIED_NONPUBLIC = {
  providerNames: ["gemini"],
  results: [{ productName: "NatureBell Magnesium Glycinate 500mg", brand: "NatureBell", category: "Supplements", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: FNSKU, gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: ["https://www.amazon.com/dp/" + FNSKU], confidence: 0.9, verifiedFacts: [], guesses: [] }],
  decision: { status: "verified", confidence: 0.9, reason: "Verified AI Decode: trusted source confirmed the exact code.", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: true, corroborationPath: "non_public_trusted_source", crossCheck: { decision: "single_provider" } },
};
// Weak non-public decode: a usable product but NO app-verified exact code (the Velvet Torch shape).
const WEAK_NONPUBLIC = {
  providerNames: ["gemini"],
  results: [{ productName: "Velvet Torch Dress", brand: "", category: "", sourceUrls: [], verifiedFacts: [], guesses: ["g"], aliases: [], confidence: 0.6 }],
  decision: { status: "suggested", confidence: 0.6, reason: "Suggested", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return () => (globalThis.fetch = original);
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("Option 3 - non-public auto-count (owner: 'found it on Amazon = enough')", () => {
  it("a non-public code with app-verified TRUSTED evidence auto-counts + makes a SHOP-LOCAL approved alias", async () => {
    const store = aiOnStore();
    const restore = stub(VERIFIED_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.name === "NatureBell Magnesium Glycinate 500mg");
    expect(prod, "product is created from the verified non-public decode").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity, "counted").toBe(1);
    expect(store.getState().aliases.find((a) => a.cleanCode === FNSKU)?.approved, "shop-local approved alias").toBe(true);
    expect(store.getState().scanFeed.some((e) => e.cleanCode === FNSKU && e.decodeStatus === "verified"), "feed row shows Verified").toBe(true);
    // SHOP-LOCAL: a non-public code must NOT write a verified GLOBAL cross-shop catalog entry.
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === FNSKU)?.verificationStatus, "no global verified catalog write").not.toBe("verified");
  });

  it("a re-scan of the same non-public code counts again (qty 2) with NO duplicate product (orphaned-count dedup)", async () => {
    const store = aiOnStore();
    let restore = stub(VERIFIED_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    restore = stub(VERIFIED_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU); // re-scan: resolves via the shop approved alias, no AI/dup
    } finally {
      restore();
    }
    const prods = store.getState().products.filter((p) => p.name === "NatureBell Magnesium Glycinate 500mg");
    expect(prods, "no duplicate product row").toHaveLength(1);
    expect(store.getState().finalCounts.find((c) => c.productId === prods[0].id)?.quantity, "qty 2").toBe(2);
  });

  it("OPTION 3 OFF: a non-public code provisionally counts (option 3 no longer gates provisional counting)", async () => {
    const store = aiOnStore();
    store.getState().updateSettings({ autoCountNonPublicWithEvidence: false });
    const restore = stub(VERIFIED_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.decodeStatus).not.toBe("decoding"));
    } finally {
      restore();
    }
    expect(store.getState().finalCounts, "provisionally counted even with option 3 off").toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "NatureBell Magnesium Glycinate 500mg");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
  });

  it("PHASE 2 + VELVET TORCH DEAD: a weak non-public suggestion counts PROVISIONALLY but is NEVER verified or approved-aliased", async () => {
    const store = aiOnStore();
    const restore = stub(WEAK_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      // scan N = count N: finalCounts hits 1 synchronously (the placeholder), so wait for the async decode
      // to ENRICH that placeholder with the suggested identity instead of racing it.
      await vi.waitFor(() => expect(store.getState().products.some((p) => /velvet torch|dress/i.test(p.name))).toBe(true));
    } finally {
      restore();
    }
    // It IS counted (provisional) - the weak suggestion shows + counts on the scan page...
    const prov = store.getState().products.find((p) => /velvet torch|dress/i.test(p.name));
    expect(prov, "a provisional product is created + counted").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prov!.id)?.quantity).toBe(1);
    // ...but it can NEVER become permanent truth (Velvet Torch poison stays dead):
    expect(prov!.verified, "provisional is NEVER a verified product").toBe(false);
    expect(store.getState().aliases.find((a) => a.cleanCode === FNSKU && a.approved), "NEVER an approved alias from a weak guess").toBeUndefined();
    expect(store.getState().needsReviewQueue.at(-1)!.status, "pending inline suggestion awaiting the human").toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === FNSKU)?.verificationStatus, "no global verified catalog from a weak guess").not.toBe("verified");
  });

  it("PHASE 2: a re-scan of a weak non-public code increments the SAME provisional product (qty 2), no duplicate", async () => {
    const store = aiOnStore();
    let restore = stub(WEAK_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      // scan N = count N: wait for the async decode to enrich the placeholder (finalCounts is 1 instantly)
      // BEFORE the second scan, so the re-scan increments the SAME enriched provisional row.
      await vi.waitFor(() => expect(store.getState().products.some((p) => /velvet torch|dress/i.test(p.name))).toBe(true));
    } finally {
      restore();
    }
    restore = stub(WEAK_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().finalCounts[0]?.quantity).toBe(2));
    } finally {
      restore();
    }
    expect(store.getState().products.filter((p) => /velvet torch|dress/i.test(p.name)), "no duplicate provisional product").toHaveLength(1);
    expect(store.getState().finalCounts, "exactly one counted product").toHaveLength(1);
  });

  it("PHASE 2: human approval CONFIRMS a provisional (verified + approved alias) with NO double-count; next scan is Known", async () => {
    const store = aiOnStore();
    const restore = stub(WEAK_NONPUBLIC);
    try {
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().finalCounts.length).toBe(1));
      store.getState().processScan(FNSKU);
      await vi.waitFor(() => expect(store.getState().finalCounts[0]?.quantity).toBe(2));
    } finally {
      restore();
    }
    const prov = store.getState().products.find((p) => p.provisional)!;
    expect(prov, "a provisional product exists").toBeDefined();

    // Human approves the still-open review.
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === FNSKU && r.status === "open")!;
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true, origin: "human",
      newProduct: { name: prov.name, brand: prov.brand, primaryBarcode: FNSKU },
    });

    const confirmed = store.getState().products.find((p) => p.id === prov.id)!;
    expect(confirmed.verified, "approval -> verified").toBe(true);
    expect(confirmed.provisional, "approval -> no longer provisional").toBeFalsy();
    expect(store.getState().aliases.some((a) => a.cleanCode === FNSKU && a.approved), "approval creates the approved alias").toBe(true);
    expect(store.getState().finalCounts.find((c) => c.productId === prov.id)?.quantity, "qty stays 2 - NO double-count on approval").toBe(2);

    // A subsequent scan now resolves as a normal Known (no AI) and counts.
    const before = globalThis.fetch;
    const spy = vi.fn(async () => ({ ok: true, json: async () => WEAK_NONPUBLIC })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    try {
      store.getState().processScan(FNSKU);
    } finally {
      globalThis.fetch = before;
    }
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length, "next scan is Known, no AI").toBe(0);
    expect(store.getState().finalCounts.find((c) => c.productId === prov.id)?.quantity, "Known scan increments -> qty 3").toBe(3);
  });
});
