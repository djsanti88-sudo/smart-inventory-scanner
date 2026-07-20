import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Identity-outcome golden classes (AI OFF, deterministic, $0). Ledger balance is asserted separately
// in ledgerInvariants.store.test.ts; here we lock the IDENTITY each class resolves to. Wrong identity
// is failure; unknown is acceptable (North-star #3).
function aiOff() {
  const s = createTestScanStore({ db: new MockDb() });
  s.getState().updateSettings({ aiLookupEnabled: false });
  return s;
}

describe("golden code classes: identity outcome per class (AI off)", () => {
  it("MISREAD (bad check digit) never mints a verified/known identity - stays provisional/needs_review", () => {
    const store = aiOff();
    store.getState().processScan("036000291453");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "036000291453");
    // It counts (appears + counts) but only as an unverified provisional, never verified.
    expect(prod?.verified ?? false).toBe(false);
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291453");
    expect(review?.status).toBe("open");
  });

  it("EXAMPLE barcode is never a verified identity", () => {
    const store = aiOff();
    store.getState().processScan("4006381333931");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "4006381333931");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("VENDOR label (ASIN/FNSKU shape) is not treated as a GTIN and routes to review", () => {
    const store = aiOff();
    store.getState().processScan("X004DY7YUT");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "X004DY7YUT");
    expect(review, "a vendor-label code opens a review").toBeDefined();
    const prod = store.getState().products.find((p) => p.primaryBarcode === "X004DY7YUT");
    expect(prod?.verified ?? false).toBe(false);
  });

  it("CONFLICT (context-conflict verified match) does not auto-count against the poisoned product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false, scanContext: "tire" });
    const s = store.getState();
    store.setState((prev) => ({
      products: [...prev.products, { id: "xp", businessId: s.businessId, name: "Hot Sauce", brand: "", category: "food", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "049000006346", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "seed", updatedBy: "seed" }],
      aliases: [...prev.aliases, { id: "xa", businessId: s.businessId, productId: "xp", rawCodeExample: "049000006346", cleanCode: "049000006346", normalizedCode: "049000006346", aliasType: "barcode", source: "seed", confidence: 1, approved: true, createdAt: "", updatedAt: "", createdBy: "seed", lastSeenAt: "", syncStatus: "synced", idempotencyKey: "xa" }],
    }));
    store.getState().processScan("049000006346");
    // The poisoned product must NOT be the counted identity; the count lands on a safe provisional.
    const poisonedCount = store.getState().finalCounts.find((c) => c.productId === "xp");
    expect(poisonedCount, "conflict never counts against the poisoned product").toBeUndefined();
  });
});

// P5 Task 4 (AI-on golden class): proves the D6 demotion (Task 1) holds inside the golden-class
// harness too, mirroring scanStore.gptLadder.test.ts's mock pattern - a bare GPT self-report claim
// still counts (TOP-LEVEL LAW), but is demoted to a suggestion: verified stays false and no
// approved alias is ever written from a bare model self-report.
function stubFetch(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

const crossCheckSingleProvider = (confidence: number) => ({
  decision: "single_provider" as const,
  confidence,
  reason: "gpt-5.5 ladder rung: single provider, no second AI to cross-check",
  brandSimilarity: 0,
  nameSimilarity: 0,
  contradictions: [],
});

describe("golden code classes: AI-on GPT self-report demotion (mocked, $0)", () => {
  it("GPT_SELF_REPORT (public barcode, self-reported 'verified' tier) counts, is demoted to suggested, verified stays false, no approved alias is written", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Scan while AI is off so the code opens a review without triggering a live fetch, then enable AI
    // and drive the mocked decode ourselves (same pattern as scanStore.gptLadder.test.ts).
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("012345678905");
    store.getState().updateSettings({ aiLookupEnabled: true });
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "012345678905" && r.status === "open")!;
    expect(review, "scan opens a review while AI is off").toBeDefined();

    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        {
          productName: "Falken Wildpeak A/T3W 265/70R17",
          brand: "Falken",
          category: "Tire",
          specsShort: "265/70R17 115T",
          specsFull: "",
          primarySku: "",
          primaryBarcode: "012345678905",
          gtin: "012345678905",
          upc: "012345678905",
          ean: "",
          aliases: [],
          imageUrl: "",
          productUrl: "",
          sourceUrls: ["https://www.tirerack.com/x"],
          confidence: 0.9,
          verifiedFacts: [],
          guesses: ["exact code on tirerack page"],
          needsHumanReview: false,
        },
      ],
      // Exactly what gptResultToDecodePayload emits post-D6-demotion for a bare self-report: status
      // "suggested", corroborationPath "gpt_self_report", exactCodeEvidenceVerifiedByApp false.
      decision: {
        status: "suggested",
        confidence: 0.9,
        reason: "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "gpt_self_report",
        crossCheck: crossCheckSingleProvider(0.9),
      },
    };

    const { restore } = stubFetch(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    // TOP-LEVEL LAW: row still appears + counts (auto-apply-as-suggestion closes the review).
    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("resolved");
    const product = store.getState().products.find((p) => p.name === "Falken Wildpeak A/T3W 265/70R17");
    expect(product, "the suggested identity lands on a counted product row").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);

    // Demotion: never verified, never an approved alias, from a bare model self-report.
    expect(product!.verified).toBe(false);
    const alias = store.getState().aliases.find((a) => a.cleanCode === "012345678905" && a.approved === true);
    expect(alias, "a bare GPT self-report must never mint an approved alias").toBeUndefined();
  });
});
