import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/products/catalog/sanitizeCatalog";
import type { CatalogEntry } from "@/products/catalog/catalogTypes";

// A3/AM-2 (2026-07-15): must be a VALID-check-digit GTIN - a bad-check-digit code is now treated
// as a likely misread and skips auto-decode entirely (src/products/barcodes/misread.ts), which is
// unrelated to what this suite tests. Fixture value only; no assertions changed.
const CODE = "111222333446";

// Reproduces the real UI regression: a single-provider, Tier-3 (barcode DB) decode that the app
// independently verified (exact code in fetched/strong evidence). It must auto-save + count, never
// stay "Verified AI Decode + Unknown".
const VERIFIED_SINGLE_TIER3 = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "Phatoil Lavender Essential Oil 100ml", brand: "Phatoil", category: "Home", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: CODE, gtin: "", upc: CODE, ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: ["https://www.upcitemdb.com/upc/" + CODE], confidence: 0.9, verifiedFacts: [], guesses: [] }],
  decision: { status: "verified", confidence: 0.9, reason: "Verified AI Decode: single provider, but the app independently confirmed the exact code in strong evidence.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
};

// Strong, evidence-backed decode: exact code app-verified, Tier-2 source (amazon), providers agree.
const STRONG = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "BIC Classic Pocket Lighter", brand: "BIC", category: "Lighters", upc: CODE, sourceUrls: ["https://www.amazon.com/dp/B000"], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.95 }],
  decision: { status: "verified", confidence: 0.95, reason: "Verified", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
};
// Weak: AI-only, no sources, no exact-barcode evidence - but a usable product name (trust the AI).
const WEAK = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "Maybe Snack", brand: "", category: "", sourceUrls: [], verifiedFacts: [], guesses: ["g"], aliases: [], confidence: 0.5 }],
  decision: { status: "suggested", confidence: 0.5, reason: "Suggested", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};
// No usable product at all -> the only "weak" that still goes to review.
const NOPRODUCT = {
  providerNames: ["gpt-5.4-mini"],
  results: [{ productName: "", brand: "", category: "", sourceUrls: [], verifiedFacts: [], guesses: [], aliases: [], confidence: 0 }],
  decision: { status: "needs_review", confidence: 0, reason: "No product", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}
// Owner cost rule counts PAID DECODE calls (/api/ai-lookup) only. The free local /api/prefix-floor
// enrichment (F5 bundle-surgery, 2026-07-20: async naming aid for a bare "Unidentified item" row)
// also goes through fetch but costs nothing and never retries decode - excluded from the count.
const calls = (spy: unknown) =>
  (spy as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes("/api/ai-lookup")).length;

describe("confidence-based auto-verify (speed-first)", () => {
  it("a strong evidence-backed decode auto-verifies + counts with NO owner approval", async () => {
    const store = aiOnStore();
    const { restore } = stub(STRONG);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.name === "BIC Classic Pocket Lighter");
    expect(prod).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    const entry = store.getState().catalog.find((e) => e.normalizedBarcode === CODE);
    expect(entry?.verificationStatus).toBe("verified");
    expect(entry?.autoVerified).toBe(true);
    expect(entry?.verifiedBy).toBe("trusted_source");
    expect(store.getState().feedbackEvents.some((e) => e.type === "auto_verified_catalog_entry")).toBe(true);
  });

  it("REGRESSION: a single-provider Tier-3 app-verified decode auto-saves (no 'Verified + Unknown')", async () => {
    const store = aiOnStore();
    const { restore } = stub(VERIFIED_SINGLE_TIER3);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.name === "Phatoil Lavender Essential Oil 100ml");
    expect(prod, "product must be created (not left Unknown)").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prod!.id)?.quantity).toBe(1);
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === CODE)?.verificationStatus).toBe("verified");
    // the scan-feed row must NOT be left in a needs_review/unknown decodeStatus
    expect(store.getState().scanFeed.some((e) => e.cleanCode === CODE && e.decodeStatus === "verified")).toBe(true);
  });

  it("does NOT retry a cold miss (owner cost rule): exactly one call, miss stays in review", async () => {
    // The old behavior retried once on a miss, which doubled the wait (-> "Failed to fetch") and the
    // token spend. New contract: ONE call; a miss is left in Needs Review (fast), not re-run.
    const store = aiOnStore();
    const original = globalThis.fetch;
    const spy = vi.fn(async () => ({ ok: true, json: async () => NOPRODUCT })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(calls(spy)).toBe(1));
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.decodeStatus).not.toBe("decoding"));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls(spy)).toBe(1); // NO retry (previously 2)
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open"); // miss stays in review
    expect(store.getState().products.find((p) => p.name === "BIC Classic Pocket Lighter")).toBeUndefined();
  });

  it("does NOT retry when the first pass already has a product (stays fast)", async () => {
    const store = aiOnStore();
    const { spy, restore } = stub(STRONG);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    expect(calls(spy)).toBe(1); // no retry on the success path
  });

  it("adds NO extra network calls on the normal path (exactly one decode request)", async () => {
    const store = aiOnStore();
    const { spy, restore } = stub(STRONG);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      restore();
    }
    expect(calls(spy)).toBe(1); // only the existing decode call; scoring is synchronous
  });

  it("second scan of an auto-verified barcode resolves with NO AI call", async () => {
    const store = aiOnStore();
    const first = stub(STRONG);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("resolved"));
    } finally {
      first.restore();
    }
    const prod = store.getState().products.find((p) => p.name === "BIC Classic Pocket Lighter")!;
    const second = stub(STRONG);
    try {
      store.getState().processScan(CODE); // synchronous resolve (known/catalog)
    } finally {
      second.restore();
    }
    expect(calls(second.spy)).toBe(0); // no AI on the second scan
    expect(store.getState().finalCounts.find((c) => c.productId === prod.id)?.quantity).toBe(2);
  });

  it("provisionally counts a weak/no-evidence product; Needs Review stays open + pending catalog", async () => {
    const store = aiOnStore();
    const { restore } = stub(WEAK);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    // The weak candidate is SHOWN and PROVISIONALLY COUNTED but never verified/approved.
    expect(store.getState().needsReviewQueue.at(-1)!.suggestedProductName).toBe("Maybe Snack");
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("suggested"); // owner-ratified 2026-07-14: suggestions bypass Needs Review (Task 9b)
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.name === "Maybe Snack");
    expect(prov).toBeDefined();
    expect(prov!.provisional).toBe(true);
    expect(prov!.verified).toBe(false);
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === CODE)?.verificationStatus).toBe("pending");
  });

  it("a decode with NO usable product provisionally counts as Unidentified item (review stays open)", async () => {
    const store = aiOnStore();
    store.getState().updateSettings({ autoVerifyConfidenceThreshold: 70 });
    const { restore } = stub(NOPRODUCT);
    try {
      store.getState().processScan(CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)!.hasSuggestion).toBe(true));
    } finally {
      restore();
    }
    expect(store.getState().needsReviewQueue.at(-1)!.status).toBe("open");
    // Provisionally counted as "Unidentified item" — scan 10 = count 10
    expect(store.getState().finalCounts).toHaveLength(1);
    const prov = store.getState().products.find((p) => p.provisional === true);
    expect(prov).toBeTruthy();
    expect(prov!.name).toMatch(/Unidentified item/);
  });

  it("a pre-existing verified catalog entry resolves WITHOUT AI (AI can't overwrite it)", () => {
    const store = aiOnStore();
    const entry: CatalogEntry = sanitizeCatalogEntry(
      { barcode: CODE, normalizedBarcode: CODE, name: "Real BIC", confidence: 0.9 },
      { now: "t", verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
    );
    store.setState({ catalog: [entry] });
    const { spy, restore } = stub(STRONG);
    try {
      store.getState().processScan(CODE);
    } finally {
      restore();
    }
    expect(calls(spy)).toBe(0); // catalog-first short-circuits AI
    expect(store.getState().products.some((p) => p.name === "Real BIC")).toBe(true);
    expect(store.getState().catalog.find((e) => e.normalizedBarcode === CODE)!.name).toBe("Real BIC");
  });
});
