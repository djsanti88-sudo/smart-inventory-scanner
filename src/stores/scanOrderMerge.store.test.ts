import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Regression for BUG 4 (owner live-proven, 115-code preview run): scanning a barcode THEN a part number
// (PN) of the SAME real-world product leaves TWO unmerged product rows (12/19 pairs unmerged), while
// scanning the PN THEN the barcode of the same product correctly merges into ONE counted row (7/19
// merged, all PN-first). Both directions must merge - the physical item is the same regardless of which
// code the clerk happened to scan first.
//
// ROOT CAUSE (traced via findIdentityMerge / resolveUnknown / the fast-path "decode-everything" enrich
// block in scanStore.ts):
//   - A corpus EXACT BARCODE hit (TireKnowledgeProvider.resolveExactBarcode) returns decision.status
//     "verified" -> the scan clears the FULL auto-count gate (canAutoCount) -> routes through
//     resolveUnknown("create_new"), which runs the dedup/findIdentityMerge check BEFORE minting/reusing a
//     product row.
//   - A corpus EXACT PART NUMBER hit (TireKnowledgeProvider.resolveExactPartNumber) NEVER returns
//     "verified" (by design - a part number is not globally unique like a barcode) - it always returns
//     decision.status "suggested" at confidence 0.8-0.85. That NEVER clears canAutoCount (which hard-
//     requires status==="verified"), so it always falls to the "AUTO-SUGGEST-APPLY" branch instead
//     (shouldAutoApplySuggestion / autoSuggestApplyOk, confidence>=0.8 && status!=="verified").
//   - THAT branch (both the fast-path "decode-everything" enrich block ~scanStore.ts line 2500, and the
//     backgroundVerifyDeep mirror ~line 3186) ALWAYS updates the SCAN'S OWN provisional placeholder
//     product in place (looked up by `review.provisionalProductId` / same-code primaryBarcode match) - it
//     NEVER calls findIdentityMerge or any dedup check against OTHER existing products. Unlike
//     resolveUnknown's create_new path, it has no way to discover that a DIFFERENT product (the one
//     minted for the barcode scan) already owns this same real-world identity.
//   - Scan order therefore matters ONLY because of which code happens to go through the (dedup-checking)
//     verified/create_new path vs the (dedup-blind) auto-suggest-apply path:
//       PN-first: PN's OWN provisional row gets enriched in place (auto-suggest-apply, no dedup check),
//         including PN-BARCODE-CARRY promoting the corpus barcode onto that SAME row's primaryBarcode.
//         When the barcode is scanned second, ensureProvisionalCount's own exact-identifier dedup finds
//         that already-carried barcode on the (still counted) PN row and reuses it - ONE row, by luck of
//         ensureProvisionalCount's own cheap dedup, not because the merge path checked anything.
//       Barcode-first: the barcode's OWN row becomes verified/non-provisional via resolveUnknown (which DID
//         run the dedup check, but found nothing to merge with since nothing else existed yet). When the PN
//         is scanned second, it mints its OWN separate provisional row and enriches THAT row in place
//         (auto-suggest-apply) - it never discovers or merges with the already-verified barcode row, because
//         the auto-suggest-apply branch never calls findIdentityMerge at all. TWO rows survive.
describe("scanStore - barcode-then-PN and PN-then-barcode scans of the same product both merge into one row", () => {
  const BARCODE = "029142712886"; // valid UPC-A check digit
  // The clerk's shop label carries a distributor prefix ("GT") on top of Cooper's canonical part
  // number - a realistic real-world PN scan (RC4 affix-core class, see tirePartNumber.ts). The
  // corpus's OWN lookup strips the affix server-side to find the row, but the row's returned
  // primarySku is always the CANONICAL manufacturer PN, never the scanned distributor-prefixed string.
  const PART_NUMBER = "GT90000032336";
  const CANONICAL_PART_NUMBER = "90000032336";

  function verifiedBarcodeResponse() {
    return {
      providerNames: ["tire-corpus"],
      results: [
        {
          productName: "Discoverer AT3 XLT",
          brand: "Cooper",
          category: "Tire",
          specsShort: "265/70R17",
          specsFull: "265/70R17 112T",
          primarySku: CANONICAL_PART_NUMBER,
          primaryBarcode: BARCODE,
          gtin: "",
          upc: BARCODE,
          ean: "",
          aliases: [],
          imageUrl: "",
          productUrl: "",
          sourceUrls: ["trusted-corpus"],
          confidence: 0.97,
          verifiedFacts: [],
          guesses: [],
        },
      ],
      decision: {
        status: "verified",
        confidence: 0.97,
        reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        crossCheck: { decision: "single_provider" },
      },
    };
  }

  function suggestedPartNumberResponse() {
    return {
      providerNames: ["tire-corpus"],
      results: [
        {
          productName: "Discoverer AT3 XLT",
          brand: "Cooper",
          category: "Tire",
          specsShort: "265/70R17",
          specsFull: "265/70R17 112T",
          primarySku: CANONICAL_PART_NUMBER,
          primaryBarcode: BARCODE, // the corpus PN row still carries the SAME barcode identity
          gtin: "",
          upc: BARCODE,
          ean: "",
          aliases: [],
          imageUrl: "",
          productUrl: "",
          sourceUrls: ["trusted-corpus"],
          confidence: 0.85,
          verifiedFacts: [],
          guesses: [],
        },
      ],
      decision: {
        status: "suggested",
        confidence: 0.85,
        reason: "Matched by part number in the tire knowledge base. Confirm before counting (part numbers are not unique like barcodes).",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "single_provider" },
      },
    };
  }

  function stubFetch() {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const code: string = body.cleanCode ?? body.rawCode ?? "";
      if (code === BARCODE) return { ok: true, json: async () => verifiedBarcodeResponse() };
      if (code === PART_NUMBER) return { ok: true, json: async () => suggestedPartNumberResponse() };
      return { ok: true, json: async () => ({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } }) };
    }) as unknown as typeof fetch;
    return { restore: () => (globalThis.fetch = original) };
  }

  function tireStore() {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
    return store;
  }

  async function waitSettled(store: ReturnType<typeof tireStore>, code: string) {
    await vi.waitFor(
      () => {
        const rows = store.getState().scanFeed.filter((e) => e.cleanCode === code);
        expect(rows.length > 0 && rows.every((r) => r.decodeStatus !== "decoding")).toBe(true);
      },
      { timeout: 10000, interval: 25 },
    );
  }

  function countedProductRowsFor(store: ReturnType<typeof tireStore>): { productId: string; quantity: number }[] {
    return store.getState().finalCounts.filter((c) => c.quantity > 0).map((c) => ({ productId: c.productId, quantity: c.quantity }));
  }

  it("PN-then-barcode merges into one product row with quantity 2", async () => {
    const store = tireStore();
    const { restore } = stubFetch();
    try {
      store.getState().processScan(PART_NUMBER);
      await waitSettled(store, PART_NUMBER);
      store.getState().processScan(BARCODE);
      await waitSettled(store, BARCODE);

      const rows = countedProductRowsFor(store);
      expect(rows.length, `expected exactly one counted product row, got ${JSON.stringify(rows)}`).toBe(1);
      expect(rows[0].quantity).toBe(2);
    } finally {
      restore();
    }
  });

  it("barcode-then-PN ALSO merges into one product row with quantity 2 (same identity, reverse order)", async () => {
    const store = tireStore();
    const { restore } = stubFetch();
    try {
      store.getState().processScan(BARCODE);
      await waitSettled(store, BARCODE);
      store.getState().processScan(PART_NUMBER);
      await waitSettled(store, PART_NUMBER);

      const rows = countedProductRowsFor(store);
      expect(rows.length, `expected exactly one counted product row, got ${JSON.stringify(rows)}`).toBe(1);
      expect(rows[0].quantity).toBe(2);
    } finally {
      restore();
    }
  });

  // REGRESSION GUARD (size-aware rule, must never be relaxed): a DIFFERENT size of the SAME tire model
  // is a DIFFERENT countable product. The barcode-then-PN merge fix above must never collapse two
  // different sizes into one row just because their brand/model text is similar.
  it("a DIFFERENT-size tire of the same model, scanned barcode-then-PN, never merges (size-aware rule intact)", async () => {
    const OTHER_BARCODE = "029142712909"; // different valid UPC-A
    const OTHER_CANONICAL_PN = "90000099999";

    function verifiedBarcodeResponseOtherSize() {
      return {
        providerNames: ["tire-corpus"],
        results: [
          {
            productName: "Discoverer AT3 XLT",
            brand: "Cooper",
            category: "Tire",
            specsShort: "275/65R18", // DIFFERENT size from the main fixture's 265/70R17
            specsFull: "275/65R18 116T",
            primarySku: OTHER_CANONICAL_PN,
            primaryBarcode: OTHER_BARCODE,
            gtin: "",
            upc: OTHER_BARCODE,
            ean: "",
            aliases: [],
            imageUrl: "",
            productUrl: "",
            sourceUrls: ["trusted-corpus"],
            confidence: 0.97,
            verifiedFacts: [],
            guesses: [],
          },
        ],
        decision: {
          status: "verified",
          confidence: 0.97,
          reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          crossCheck: { decision: "single_provider" },
        },
      };
    }

    function suggestedPartNumberResponseOtherSize() {
      return {
        providerNames: ["tire-corpus"],
        results: [
          {
            productName: "Discoverer AT3 XLT",
            brand: "Cooper",
            category: "Tire",
            specsShort: "265/70R17", // the ORIGINAL fixture's size - a DIFFERENT product from OTHER_BARCODE's 275/65R18
            specsFull: "265/70R17 112T",
            primarySku: CANONICAL_PART_NUMBER,
            primaryBarcode: BARCODE,
            gtin: "",
            upc: BARCODE,
            ean: "",
            aliases: [],
            imageUrl: "",
            productUrl: "",
            sourceUrls: ["trusted-corpus"],
            confidence: 0.85,
            verifiedFacts: [],
            guesses: [],
          },
        ],
        decision: {
          status: "suggested",
          confidence: 0.85,
          reason: "Matched by part number in the tire knowledge base. Confirm before counting (part numbers are not unique like barcodes).",
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: false,
          crossCheck: { decision: "single_provider" },
        },
      };
    }

    const store = tireStore();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const code: string = body.cleanCode ?? body.rawCode ?? "";
      if (code === OTHER_BARCODE) return { ok: true, json: async () => verifiedBarcodeResponseOtherSize() };
      // PART_NUMBER here decodes to the ORIGINAL (different-size) product identity - same brand/model
      // text as OTHER_BARCODE's product, but a genuinely different tire size.
      if (code === PART_NUMBER) return { ok: true, json: async () => suggestedPartNumberResponseOtherSize() };
      return { ok: true, json: async () => ({ providerNames: [], results: [], decision: { status: "needs_review", confidence: 0, reason: "no fixture" } }) };
    }) as unknown as typeof fetch;

    try {
      store.getState().processScan(OTHER_BARCODE);
      await waitSettled(store, OTHER_BARCODE);
      store.getState().processScan(PART_NUMBER);
      await waitSettled(store, PART_NUMBER);

      // Two DIFFERENT sizes of the same model must remain two separate counted rows - never merged.
      const rows = countedProductRowsFor(store);
      expect(rows.length, `expected two separate counted product rows (different tire sizes), got ${JSON.stringify(rows)}`).toBe(2);
      expect(rows.every((r) => r.quantity === 1)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
