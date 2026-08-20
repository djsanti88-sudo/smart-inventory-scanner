import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { shouldAutoApplySuggestion, canAutoCount } from "./scanGates";

// Barcode trust gate (spec v3), Task 4: PIN the AM-2 counting invariants ("suggested tier never
// self-counts") as regression tests, and scrub a rejected decode-provided barcode out of the
// review row's suggested* fields (defense in depth on top of Task 3's resolveUnknown gate).
//
// The 4 pure pins below are EXISTING behavior (scanGates.ts, untouched by this task) - they pass
// immediately and exist only so a future change cannot silently reintroduce a self-count on a
// merely-"suggested" or provider-self-reported "verified" decode.

describe("AM-2 invariant pins (suggested tier never self-counts; Phase-7 gate unchanged)", () => {
  it("a confidence-0.9 SUGGESTED decode does NOT clear the auto-count gate", () => {
    expect(
      canAutoCount({
        codeType: "upc_a",
        decision: { status: "suggested", confidence: 0.9 },
        productName: "Some Tire",
        productNameUsable: true,
        tireOk: true,
        contextConflict: null,
      }).allowed,
    ).toBe(false);
  });

  it("a provider-claimed 'verified' with NO app corroboration does NOT auto-count (non-self-report path)", () => {
    expect(
      canAutoCount({
        codeType: "upc_a",
        decision: { status: "verified", confidence: 0.95, corroborationPath: "none" },
        productName: "Some Tire",
        productNameUsable: true,
        tireOk: true,
        contextConflict: null,
      }).allowed,
    ).toBe(false);
  });

  it("suggestion auto-apply never fires on a 'verified' decode without app verification (T20/1225 firewall)", () => {
    expect(
      shouldAutoApplySuggestion({
        autoAddOn: true,
        contextConflict: null,
        productNameUsable: true,
        confidence: 0.95,
        status: "verified",
        exactCodeEvidenceVerifiedByApp: false,
      }),
    ).toBe(false);
  });

  it("suggestion auto-apply is an IDENTITY DISPLAY only - documented invariant", () => {
    // shouldAutoApplySuggestion returning true leads to a name applied on the counted provisional
    // row + a PARKED "suggested" review. It must never mint an alias or add a count. This is pinned
    // structurally: the function returns a boolean consumed by the display path, and the alias-minting
    // path (resolveUnknown) is only reachable via canAutoCount (pinned above) or a human action.
    expect(
      shouldAutoApplySuggestion({
        autoAddOn: true,
        contextConflict: null,
        productNameUsable: true,
        confidence: 0.85,
        status: "suggested",
        exactCodeEvidenceVerifiedByApp: false,
      }),
    ).toBe(true);
  });
});

// Store-level pin: a mocked SUGGESTED decode carrying a phantom (bad-check-digit) barcode in its
// gtin field must (a) never mint an approved alias, (b) still count the scan exactly once (the
// top-level "scan N = count N" law - the AI never decides whether a scan counts), and (c) have its
// suggestedGtin field SCRUBBED to "" before it reaches the review row (AM-4.4 defense in depth).
const PHANTOM_CODE = "222333444553"; // valid-check-digit GTIN shape, routes through decode
const PHANTOM_GTIN = "8848111201762"; // bad GS1 check digit - well-formed junk, must be scrubbed
const SUGGESTED_WITH_PHANTOM_GTIN = {
  providerNames: ["gemini"],
  results: [
    {
      productName: "Maybe Tire Thing",
      brand: "",
      category: "",
      specsShort: "",
      specsFull: "",
      primarySku: "",
      primaryBarcode: "",
      gtin: PHANTOM_GTIN,
      upc: "",
      ean: "",
      aliases: [],
      imageUrl: "",
      productUrl: "",
      sourceUrls: [],
      confidence: 0.85,
      verifiedFacts: [],
      guesses: ["guess"],
    },
  ],
  decision: {
    status: "suggested",
    confidence: 0.85,
    reason: "Suggested",
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider" },
  },
};

function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return () => (globalThis.fetch = original);
}
function aiStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("store-level: a SUGGESTED decode's phantom barcode is scrubbed from the review row (AM-4.4)", () => {
  it("scan N = count N holds, no approved alias is minted, and suggestedGtin is scrubbed to ''", async () => {
    const store = aiStore();
    const restore = stub(SUGGESTED_WITH_PHANTOM_GTIN);
    try {
      store.getState().processScan(PHANTOM_CODE);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.at(-1)?.suggestedProductName).toBe("Maybe Tire Thing"),
      );
    } finally {
      restore();
    }

    // TOP-LEVEL LAW: exactly one physical processScan call -> finalCounts total is exactly 1.
    const totalCounted = store
      .getState()
      .finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalCounted).toBe(1);

    // AM-2: a merely-"suggested" decode never mints an approved alias for the scanned code.
    const alias = store.getState().aliases.find((a) => a.cleanCode === PHANTOM_CODE);
    if (alias) expect(alias.approved).toBe(false);

    // AM-4.4 scrub: the phantom (bad-check-digit) gtin never reaches the review row's suggested field.
    const review = store.getState().needsReviewQueue.at(-1)!;
    expect(review.suggestedGtin).toBe("");
  });
});

// BUG FIX (owner-reported live on preview): scanning a shop PART NUMBER (e.g. KH2265992) resolves the
// correct tire as Suggested via the tire-corpus PN rung, but the COUNTED provisional row's barcode
// stayed empty even though the corpus row HAS a real barcode. Root cause (b): the "decode-everything"
// provisional-count path in scanStore never carried `best.primaryBarcode` onto the provisional
// product - neither at mint time (always used the scanned code) nor at the "enrich" upgrade step
// (which upgraded name/brand/specs but never primaryBarcode). This pins the fix: a PN-shaped scanned
// code (never itself a GTIN) may be UPGRADED to the corpus barcode; a real scanned GTIN must never be
// clobbered by a different corpus barcode (negative case below).
const PN_CODE = "KH2265992"; // alpha_sku shape (has letters) - never itself a GTIN
const CORPUS_BARCODE = "8808956277338";
const SUGGESTED_PN_WITH_BARCODE = {
  providerNames: ["tire-corpus"],
  results: [
    {
      productName: "Kumho Crugen Hp71 245/60R18 105H",
      brand: "Kumho",
      category: "Tire",
      specsShort: "245/60R18 105H",
      specsFull: "245/60R18",
      primarySku: "2265992",
      primaryBarcode: CORPUS_BARCODE,
      gtin: "",
      upc: "",
      ean: CORPUS_BARCODE,
      aliases: [],
      imageUrl: "",
      productUrl: "",
      sourceUrls: [],
      confidence: 0.8,
      verifiedFacts: ["Trusted tire knowledge base: exact ean " + CORPUS_BARCODE],
      guesses: [],
    },
  ],
  decision: {
    status: "suggested",
    confidence: 0.8,
    reason: "Matched by part number in the tire knowledge base (distributor prefix stripped). Confirm before counting.",
    evidenceStrength: "fetched_source",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider" },
  },
};

// Bad-check-digit barcode: a decode-provided barcode that must be scrubbed (never counted as identity)
// per the existing trust gate (gradeBarcode -> "rejected"), while the scan itself must still count.
const BAD_CHECK_DIGIT_BARCODE = "8808956277339"; // last digit tampered vs the real 8808956277338

describe("store-level: a PN-resolved suggestion carries the corpus barcode onto the counted row (PN barcode carry)", () => {
  it("scans a shop PN, decode suggests identity+barcode -> the counted row's product exposes the corpus barcode; scan N = count N holds", async () => {
    const store = aiStore();
    const restore = stub(SUGGESTED_PN_WITH_BARCODE);
    try {
      store.getState().processScan(PN_CODE);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.at(-1)?.suggestedProductName).toBe("Kumho Crugen Hp71 245/60R18 105H"),
      );
    } finally {
      restore();
    }

    // scan N = count N: exactly one physical scan -> exactly one counted unit.
    const totalCounted = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalCounted).toBe(1);

    // The counted provisional product for this code now exposes the corpus barcode - "the shop's
    // decoded barcodes come up" (owner expectation).
    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === PN_CODE);
    expect(feedRow?.matchedProductId).toBeTruthy();
    const product = store.getState().products.find((p) => p.id === feedRow!.matchedProductId);
    expect(product?.primaryBarcode).toBe(CORPUS_BARCODE);
  });

  it("a decode carrying a bad-check-digit barcode is scrubbed (never becomes the row's identity), but the scan still counts", async () => {
    const store = aiStore();
    const restore = stub({
      ...SUGGESTED_PN_WITH_BARCODE,
      results: [{ ...SUGGESTED_PN_WITH_BARCODE.results[0], primaryBarcode: BAD_CHECK_DIGIT_BARCODE, ean: BAD_CHECK_DIGIT_BARCODE }],
    });
    try {
      store.getState().processScan(PN_CODE);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.at(-1)?.suggestedProductName).toBe("Kumho Crugen Hp71 245/60R18 105H"),
      );
    } finally {
      restore();
    }

    const totalCounted = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalCounted).toBe(1);

    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === PN_CODE);
    const product = store.getState().products.find((p) => p.id === feedRow!.matchedProductId);
    // The bad-check-digit barcode must never become the product's identity - it stays the scanned PN
    // placeholder (or empty), never the phantom code.
    expect(product?.primaryBarcode).not.toBe(BAD_CHECK_DIGIT_BARCODE);
  });

  it("negative: scanning a real GTIN is NEVER overwritten by a different corpus barcode from a decode suggestion", async () => {
    const REAL_SCANNED_GTIN = "012345678905"; // valid check-digit UPC-A, scanned directly
    const store = aiStore();
    const restore = stub({
      ...SUGGESTED_PN_WITH_BARCODE,
      results: [{ ...SUGGESTED_PN_WITH_BARCODE.results[0], primaryBarcode: CORPUS_BARCODE, ean: CORPUS_BARCODE }],
    });
    try {
      store.getState().processScan(REAL_SCANNED_GTIN);
      await vi.waitFor(() =>
        expect(store.getState().needsReviewQueue.at(-1)?.suggestedProductName).toBe("Kumho Crugen Hp71 245/60R18 105H"),
      );
    } finally {
      restore();
    }

    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === REAL_SCANNED_GTIN);
    const product = store.getState().products.find((p) => p.id === feedRow!.matchedProductId);
    // The scanned GTIN is the real, physically-scanned identity - a decode suggestion's DIFFERENT
    // corpus barcode must never clobber it.
    expect(product?.primaryBarcode).toBe(REAL_SCANNED_GTIN);
  });
});
