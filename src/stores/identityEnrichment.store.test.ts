import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Owner-reported LIVE BUG (deployed preview, 2026-07-20): a counted row showed name "Falken Azenis
// RT660 P 245 /40 R18 97W XL BSW (suggested)" for barcode 848983017918, but the Brand / Model /
// Category / Specs / Size table columns were ALL "-" even though the size (245/40R18), load/speed
// (97W), and sidewall (BSW) are all cleanly parseable from the name itself. A prior fix (commit
// 0570ca9) added structured-field writing ONLY inside resolveUnknown's "reuse existing product"
// branch - this row never took that path (it is a single fresh scan, not a re-match of an existing
// counted product), so the bug survived.
//
// This suite reproduces the exact scenario end-to-end through the real store (mocked fetch, no live
// tokens) and asserts every apply site now fills brand/specsShort (Size)/structuredModel from the
// name when the decode payload itself carries no structured fields - the SAME shape the owner's
// real decode had (a self-reported provider name with no separate brand/category/specsShort fields).

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code);
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

const FALKEN_NAME = "Falken Azenis RT660 P 245 /40 R18 97W XL BSW";

function gptResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productName: FALKEN_NAME,
    // Mirrors the owner's real decode: no separate structured fields, everything lives in the name.
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    aliases: [] as string[],
    imageUrl: "",
    productUrl: "",
    sourceUrls: [] as string[],
    confidence: 0.9,
    verifiedFacts: [] as string[],
    guesses: [] as string[],
    needsHumanReview: false,
    ...overrides,
  };
}

describe("identity enrichment - owner-reported Falken bug (848983017918)", () => {
  it("auto-suggest-applied row fills brand/specsShort/structuredModel from the name when the decode payload has none", async () => {
    const store = aiOnStore();
    const review = openReview(store, "848983017918");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [gptResult()],
      decision: {
        status: "suggested",
        confidence: 0.9,
        reason: "Identity suggested by the AI model (self-report) - not app-verified; shown as a suggestion.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "gpt_self_report",
        crossCheck: {
          decision: "single_provider" as const,
          confidence: 0.9,
          reason: "single provider, no second AI to cross-check",
          brandSimilarity: 0,
          nameSimilarity: 0,
          contradictions: [],
        },
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const product = store.getState().products.find((p) => p.name.startsWith("Falken Azenis RT660"));
    expect(product, "the decoded product row exists").toBeDefined();

    // It still counts (TOP-LEVEL LAW).
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);

    // Structured columns are filled from the name, not left blank.
    expect(product!.brand, "Brand column").toBe("Falken");
    expect(product!.specsShort, "Specs/Size column").toBe("P245/40R18");
    expect(product!.structuredModel ?? "", "Model column").toContain("Azenis RT660");
  });
});
