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

describe("multiVariant wiring - a multi-speed-rating listing never auto-counts as verified (Group C)", () => {
  it("a verified-shaped decode with a multi-variant name (93V, 93W, 93H) stays provisional/unverified, never auto-applies a clean identity", async () => {
    const store = aiOnStore();
    const review = openReview(store, "6419440277462");
    const RESP = {
      providerNames: ["go-upc"],
      results: [
        gptResult({
          productName: "Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC",
          brand: "Nokian",
          confidence: 0.95,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.95,
        reason: "App-verified exact code match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "exact_code_evidence",
        crossCheck: {
          decision: "single_provider" as const,
          confidence: 0.95,
          reason: "single provider, app-verified",
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

    // TOP-LEVEL LAW: still counted. Match on the scanned code itself (not the name) - a seed fixture
    // product also happens to be named "Nokian ...", so matching by name alone could false-positive.
    const product = store.getState().products.find((p) => p.primaryBarcode === "6419440277462");
    expect(product, "the decoded product row exists").toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);

    // multiVariant must gate the identity as unverified/provisional - never a clean auto-applied match.
    expect(product!.verified, "must never auto-verify a multi-variant listing").toBe(false);
    expect(product!.provisional, "must stay provisional pending human review").toBe(true);
  });
});

describe("empty-suggested regression guard (Group C)", () => {
  it("a decode with NO resolvable identity (empty/placeholder name) never lands the review at status 'suggested'", async () => {
    // Root cause verified at src/stores/scanStore.ts: the two "suggested" status-setting sites
    // (the fast inline-suggestion branch and the deep-verify inline-suggestion branch) both already
    // gate on isUsableProductName(best?.productName) / isUsableProductName(freshAfter.suggestedProductName)
    // before assigning status "suggested" (isUsableProductName rejects an empty/too-short/placeholder
    // name at src/decoding/decode.ts). This test locks that gate in as a regression guard - a
    // provider result that resolves to no usable identity must stay honestly needs_review, never
    // "suggested" (which the UI would otherwise badge as a real, if unconfirmed, product match).
    const store = aiOnStore();
    const review = openReview(store, "0000000000001");
    const RESP = {
      providerNames: ["gpt-5.4-mini"],
      results: [gptResult({ productName: "" })],
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

    // TOP-LEVEL LAW: still counted, even with no identity.
    const openOrParkedReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === "0000000000001");
    expect(openOrParkedReview, "the review record exists").toBeDefined();
    // Never "suggested" for an empty/unusable identity - stays "open" (honest needs_review), and no
    // pending inline suggestion is attached to the feed row.
    expect(openOrParkedReview!.status).not.toBe("suggested");
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === "0000000000001");
    expect(feedRow?.suggestion).toBeUndefined();
  });
});

describe("identity enrichment - owner-reported Falken bug (848983017918)", () => {
  it("auto-suggest-applied row fills brand/specsShort/structuredModel from the name when the decode payload has none", async () => {
    const store = aiOnStore();
    const review = openReview(store, "848983017918");
    const RESP = {
      providerNames: ["gpt-5.4-mini"],
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
    // Group B owner mandate (2026-07-21): specsShort includes the parsed load/speed + sidewall
    // when parseable, not just the bare size.
    expect(product!.specsShort, "Specs/Size column").toBe("P245/40R18 97W XL BSW");
    expect(product!.structuredModel ?? "", "Model column").toContain("Azenis RT660");
  });
});
