import { describe, it, expect, afterEach } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { setDerivedPrefixes } from "@/services/catalog/prefixIndex";

// Root-cause diagnostic 2026-08-04 (.superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/
// cocacola-bug-report.md): scanning a REAL Michelin/Nexen tire whose barcode's GS1 company prefix
// (049000 - Coca-Cola's real prefix) is DERIVED-tier "Coca-Cola" showed brand "Coca-Cola" in the UI next
// to the correct decoded tire name/size/part number. Root cause: ensureProvisionalCount mints the
// provisional row's brand from the prefix-floor STATISTICAL guess (prefixFloorName) before any decode
// ever runs. When the REAL decode later lands, enrichProductIdentity's fill-if-empty brand rule treats
// that guess as if it were a trustworthy prior identity (it is non-empty), so it wins forever.
//
// A guard for this exact defect CLASS already existed at ONE of three vulnerable call sites in
// scanStore.ts (2026-07-21 dated comment, "PREFIX-FLOOR BRAND LOCK FIX") - the fix was never propagated
// to the other two. This suite proves the class fix: the protection now lives INSIDE
// enrichProductIdentity itself (via an `existingBrandIsFloorGuess` flag every call site passes), so no
// future call site can regress it, and covers all three real call sites with one shared assertion shape.

const CODE = "049000026603"; // real Michelin X-Ice North 4 barcode; GS1 prefix 0049000 (Coca-Cola's)
const CODE_B = "049000021585"; // real Nexen N Priz AH8 barcode; same GS1 prefix, used for the reuse-path test

function seedCocaColaFloor() {
  setDerivedPrefixes({
    "0049000": {
      prefix: "0049000",
      candidates: [
        { name: "coca-cola", kind: "brand", productCount: 768, confidence: 0.63 },
        { name: "powerade", kind: "brand", productCount: 97, confidence: 0.37 },
      ],
      dominant: { name: "coca-cola", kind: "brand", productCount: 768, confidence: 0.63 },
      productCount: 768,
      categoryDist: { sodas: 115 },
      countryHints: ["US"],
      confidence: 0.63,
      ambiguity: 0.37,
      source: "derived_catalog",
    },
  });
}

function newStore() {
  return createTestScanStore({ db: new MockDb() });
}

function productFor(store: ReturnType<typeof createTestScanStore>, id: string) {
  return store.getState().products.find((p) => p.id === id)!;
}

afterEach(() => {
  setDerivedPrefixes({}); // never leak seeded derived-tier state into other test files
});

describe("prefix-floor brand guess must never outrank a real decode (class fix, 2026-08-04)", () => {
  it("sanity: the floor's statistical brand guess mints synchronously, before any decode runs", () => {
    seedCocaColaFloor();
    const store = newStore();
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    const before = productFor(store, review.provisionalProductId!);
    expect(before.brand).toBe("Coca-Cola");
    expect(before.name).toBe("Coca-Cola / product unconfirmed");
  });

  it("ORPHAN-UPGRADE path (resolveUnknown create_new, no other product owns the identity): the floor guess must yield to the real verified decode's brand", () => {
    seedCocaColaFloor();
    const store = newStore();
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    const provisionalId = review.provisionalProductId!;
    expect(productFor(store, provisionalId).brand, "sanity: floor guess minted pre-decode").toBe("Coca-Cola");

    // The real decode lands (tire corpus, verified) via resolveUnknown create_new - no OTHER product owns
    // this identity and this review's own provisional placeholder exists, so this is exactly the
    // "upgrade orphan into created product" branch (scanStore.ts ~5720-5776).
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: {
        name: "Michelin X-Ice North 4 225/60R18 104T",
        brand: "Michelin",
        specsShort: "225/60R18 104T",
        primarySku: "80171",
        primaryBarcode: CODE,
      },
    });

    const after = productFor(store, provisionalId);
    expect(after.name).toContain("Michelin X-Ice North 4");
    expect(
      after.brand,
      "the prefix floor's statistical guess must not survive a real verified decode",
    ).toBe("Michelin");
  });

  it("ORPHAN-UPGRADE path also yields when the decode payload carries NO separate brand field (brand parseable only from the name)", () => {
    seedCocaColaFloor();
    const store = newStore();
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    const provisionalId = review.provisionalProductId!;

    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      // NOTE: no `brand` key at all (name-only decode payload shape) - Michelin is only recoverable by
      // parsing the name, matching the ORIGINAL 2026-07-21 incident's own documented failure mode.
      newProduct: { name: "Michelin X-Ice North 4 225/60R18 104T", primaryBarcode: CODE },
    });

    const after = productFor(store, provisionalId);
    expect(after.brand).toBe("Michelin");
  });

  it("REUSE-EXISTING-PROVISIONAL path (a DIFFERENT already-counted product owns the scanned identity): the floor guess must yield too", () => {
    seedCocaColaFloor();
    const store = newStore();

    // Product A: minted by a first scan of CODE (floor guess "Coca-Cola"), still open/provisional.
    store.getState().processScan(CODE);
    const reviewA = store.getState().needsReviewQueue.at(-1)!;
    const productAId = reviewA.provisionalProductId!;
    expect(productFor(store, productAId).brand).toBe("Coca-Cola");

    // A SEPARATE scan (a different physical code, no floor hit) also needs resolving.
    store.getState().processScan("999888777001");
    const reviewB = store.getState().needsReviewQueue.find((r) => r.cleanCode === "999888777001")!;

    // Human resolves review B by supplying product A's OWN primaryBarcode as an identifier (e.g. a
    // corrected/known barcode for the same physical item) - this makes the dedup guard reuse product A
    // (matchedIds.size === 1) rather than minting a third row. No separate `brand` field (name-only).
    store.getState().resolveUnknown(reviewB.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Michelin X-Ice North 4 225/60R18 104T", primaryBarcode: CODE },
    });

    const afterA = productFor(store, productAId);
    expect(afterA.brand, "the reused row's floor guess must not survive the real decode").toBe("Michelin");
  });

  it("preserves the floor naming aid for a row NOTHING has ever resolved (genuinely unidentified - feature preserved)", () => {
    seedCocaColaFloor();
    const store = newStore();
    // No decode runs at all (aiLookupEnabled defaults false in createTestScanStore) and resolveUnknown is
    // never called - the row is genuinely still unidentified. The floor's naming aid must still be exactly
    // what ensureProvisionalCount minted; the class fix must not touch this untouched row.
    store.getState().processScan(CODE_B);
    const review = store.getState().needsReviewQueue.at(-1)!;
    const p = productFor(store, review.provisionalProductId!);
    expect(p.brand).toBe("Coca-Cola");
    expect(p.name).toBe("Coca-Cola / product unconfirmed");
  });
});
