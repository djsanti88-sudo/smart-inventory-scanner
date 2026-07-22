import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// B1 regression (owner-reported, 268-row review, 2026-07-20): on MOST tire rows, Brand/Model/
// Category/Specs/Size columns showed "-" even when the row's Product name clearly contained
// brand+model+size, and even though a SIBLING row of the same product (e.g. Fortune ClimaFlex
// 840139640315) showed a full Specs string. Root cause: resolveUnknown's "matchedIds.size === 1"
// reuse branch (the path a decode/auto-count takes when it re-matches an EXISTING, already-counted
// PROVISIONAL product) only conditionally copies name/brand/category from the decode payload (`np`)
// -  and never touches specsShort/specsFull/primarySku at all, even when np carries real values. Any
// later, richer decode that re-matches the SAME provisional row therefore can never fill in its
// Specs/Size columns - they stay blank forever once the row is first counted.
//
// Fix: any decode identity application (including this reuse/re-match path) must write ALL
// structured fields it has, and a later richer decode may upgrade STILL-EMPTY fields on the same
// product - never overwrite a non-empty value (human or otherwise).

const qtyFor = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

describe("scanStore - structured fields (specsShort/specsFull/category/primarySku) survive the reuse/re-match dedup path", () => {
  it("re-matching an existing PROVISIONAL product with a richer decode fills its still-empty specs/category/sku", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // First scan: a bare, evidence-less guess mints a provisional product with NO specs (owner's
    // "blank Brand/Model/Category/Specs/Size" symptom - the placeholder has nothing structured yet).
    store.getState().processScan("VENDORCODE-B1-1");
    const review1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-1" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review1.id ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402" } : r,
      ),
    }));
    store.getState().resolveUnknown(review1.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", gtin: "840139640315" },
    });
    const p1 = store.getState().products.find((p) => qtyFor(store, p.id) > 0)!;
    expect(p1.specsShort ?? "", "the first bare guess has no specs yet").toBe("");
    expect(p1.specsFull ?? "", "the first bare guess has no specs yet").toBe("");

    // Second scan: a DIFFERENT scanned code decodes to the SAME GTIN identity, this time with a full
    // decode payload (brand/category/specsShort/specsFull/primarySku) - mirrors a richer provider
    // (corpus/tire-DB hit) re-matching the same physical item after a weaker first guess.
    store.getState().processScan("VENDORCODE-B1-2");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-2" && r.status === "open")!;
    // This decode carries REAL evidence (brand + gtin) - isWeakGuess() only treats a suggestion as
    // evidence-less when the REVIEW's own suggestedBrand/suggestedGtin/suggestedUpc/suggestedEan/
    // sourceUrls are all empty, so a real richer decode must stamp those onto the review too (mirrors
    // what the live decode pipeline does before calling resolveUnknown).
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review2.id
          ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402", suggestedBrand: "Fortune", suggestedGtin: "0840139640315" }
          : r,
      ),
    }));
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: {
        name: "Fortune ClimaFlex 4S FSR402",
        brand: "Fortune",
        category: "Tire",
        specsShort: "235/55R18",
        specsFull: "Model ClimaFlex 4S FSR402; Load Range XL; Load Index 104; Speed Index V; Black Sidewall; quantity 4",
        primarySku: "FSR402-2355518",
        gtin: "0840139640315", // zero-padded variant of the same GTIN
      },
    });

    // Same physical item -> ONE product row, and its structured fields are now filled from the
    // richer decode (never left blank just because the row already existed).
    const rows = store.getState().products.filter((p) => qtyFor(store, p.id) > 0);
    expect(rows.length, "still one merged row for the shared GTIN identity").toBe(1);
    const merged = rows[0];
    expect(merged.specsShort).toBe("235/55R18");
    expect(merged.specsFull).toBe(
      "Model ClimaFlex 4S FSR402; Load Range XL; Load Index 104; Speed Index V; Black Sidewall; quantity 4",
    );
    expect(merged.category).toBe("Tire");
    expect(merged.primarySku).toBe("FSR402-2355518");
    expect(merged.brand).toBe("Fortune");
  });

  it("a junky eBay-style decode name lands as a clean name + parsed brand/model/size columns (tireListingNormalizer integration)", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // First scan: bare provisional placeholder, no structure yet.
    store.getState().processScan("VENDORCODE-B1-JUNK-1");
    const review1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-JUNK-1" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review1.id ? { ...r, hasSuggestion: true, suggestedProductName: "junk placeholder" } : r,
      ),
    }));
    store.getState().resolveUnknown(review1.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "junk placeholder", gtin: "840139640711" },
    });
    const p1 = store.getState().products.find((p) => qtyFor(store, p.id) > 0)!;

    // Second scan: the decode's raw name is a junky marketplace-scraped title (quantity prefix,
    // condition word, "Fits:" clause) that CARRIES NO structured specsShort/size field itself - only
    // the raw listing title. The decode payload alone (no specsShort) is exactly the shape B1's fix
    // targets: still-empty columns must be filled from the name itself when the payload lacks
    // structured fields, via the shared tireListingNormalizer (cleanListingTitle/parseTireIdentity/
    // canonicalTireSize) - never guessed, only parsed deterministically.
    store.getState().processScan("VENDORCODE-B1-JUNK-2");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-JUNK-2" && r.status === "open")!;
    const junkName = "Set of 4 NEW Fortune ClimaFlex 4S FSR402 235/55R18 104V Tires Fits: 2019 Toyota Camry";
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review2.id
          ? { ...r, hasSuggestion: true, suggestedProductName: junkName, suggestedBrand: "Fortune", suggestedGtin: "0840139640711" }
          : r,
      ),
    }));
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: junkName, brand: "Fortune", gtin: "0840139640711" },
    });

    const merged = store.getState().products.find((p) => p.id === p1.id)!;
    // The stored name is cleaned (no "Set of 4", "NEW", "Fits: ..." junk survives).
    expect(merged.name).not.toMatch(/set of 4/i);
    expect(merged.name).not.toMatch(/\bnew\b/i);
    expect(merged.name).not.toMatch(/fits:/i);
    // The still-empty specsShort/size column is filled from the parsed identity (never guessed -
    // deterministically parsed from the listing title itself). Group B owner mandate (2026-07-21):
    // includes the parsed load/speed rating (104V) alongside the bare size.
    expect(merged.specsShort).toBe("235/55R18 104V");
  });

  it("never overwrites a non-empty (human-entered) specs value with a later decode's field", () => {
    const store = createTestScanStore({ db: new MockDb() });

    store.getState().processScan("VENDORCODE-B1-3");
    const review1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-3" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review1.id ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402" } : r,
      ),
    }));
    store.getState().resolveUnknown(review1.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", gtin: "840139640999" },
    });
    const p1 = store.getState().products.find((p) => qtyFor(store, p.id) > 0)!;

    // A human corrects the specs directly on the counted row (correctProduct - the existing safe
    // product-field editor).
    store.getState().correctProduct(p1.id, { specsShort: "HUMAN-ENTERED-SIZE" });
    expect(store.getState().products.find((p) => p.id === p1.id)?.specsShort).toBe("HUMAN-ENTERED-SIZE");

    // A later re-match with a DIFFERENT decoded specsShort must NOT clobber the human's value.
    store.getState().processScan("VENDORCODE-B1-4");
    const review2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDORCODE-B1-4" && r.status === "open")!;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === review2.id ? { ...r, hasSuggestion: true, suggestedProductName: "Fortune ClimaFlex 4S FSR402" } : r,
      ),
    }));
    store.getState().resolveUnknown(review2.id, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Fortune ClimaFlex 4S FSR402", specsShort: "AI-DECODED-SIZE", gtin: "0840139640999" },
    });

    expect(
      store.getState().products.find((p) => p.id === p1.id)?.specsShort,
      "the human's value survives a later decode re-match",
    ).toBe("HUMAN-ENTERED-SIZE");
  });
});
