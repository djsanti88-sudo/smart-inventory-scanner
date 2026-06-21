import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// Cross-identifier matching + GROUNDED discovered-alias approval. A decode-surfaced extra identifier is a
// DISCOVERED suggestion: persisted UNAPPROVED, never matching/counting until a human approves it. After
// approval the UPC and the part number both resolve to the SAME product, idempotently.

function reviewIdFor(store: ReturnType<typeof createTestScanStore>, cleanCode: string) {
  const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === cleanCode);
  if (!r) throw new Error(`no review for ${cleanCode}`);
  return r.id;
}

// Create a product from an unknown scan whose decode ALSO surfaced an extra identifier (discovered).
function makeWidgetWithDiscovered(store: ReturnType<typeof createTestScanStore>) {
  store.getState().processScan("700000000010"); // unknown UPC -> Needs Review
  const reviewId = reviewIdFor(store, "700000000010");
  // Simulate a decode that surfaced an extra code (a part number) as a SUGGESTION on the review.
  store.setState((s) => ({
    needsReviewQueue: s.needsReviewQueue.map((r) =>
      r.id === reviewId ? { ...r, suggestedAliases: ["PN-DISC-1"], hasSuggestion: true } : r,
    ),
  }));
  store.getState().resolveUnknown(reviewId, "create_new", {
    applyToCount: true,
    origin: "human",
    newProduct: { name: "Widget", primaryBarcode: "700000000010" },
  });
  return store.getState().products.find((p) => p.name === "Widget")!.id;
}

describe("discovered identifier approval (grounded, never auto-trusted)", () => {
  it("a decode-surfaced extra identifier is persisted UNAPPROVED and does not match until approved", () => {
    const store = createTestScanStore();
    const pid = makeWidgetWithDiscovered(store);

    const disc = store.getState().aliases.find((a) => a.productId === pid && a.cleanCode === "PN-DISC-1");
    expect(disc).toBeTruthy();
    expect(disc!.approved).toBe(false); // discovered, not trusted

    // scanning the discovered code BEFORE approval -> NOT known (the resolver ignores unapproved aliases)
    expect(store.getState().processScan("PN-DISC-1")?.resolverStatus).toBe("needs_review");
  });

  it("after one-click approval, UPC and part number both resolve to the SAME product, counting once each", () => {
    const store = createTestScanStore();
    const pid = makeWidgetWithDiscovered(store);
    const before = store.getState().finalCounts.find((c) => c.productId === pid)?.quantity ?? 0;

    store.getState().approveDiscoveredIdentifiers(pid, ["PN-DISC-1"]);
    expect(store.getState().aliases.find((a) => a.productId === pid && a.cleanCode === "PN-DISC-1")!.approved).toBe(true);

    const byUpc = store.getState().processScan("700000000010");
    const byPart = store.getState().processScan("PN-DISC-1");
    expect(byUpc?.matchedProductId).toBe(pid);
    expect(byPart?.matchedProductId).toBe(pid);
    expect(byPart?.resolverStatus).toBe("known");

    // exactly two known scans counted -> +2, one product row (no duplicate product, no double count)
    const after = store.getState().finalCounts.find((c) => c.productId === pid)!.quantity;
    expect(after).toBe(before + 2);
    expect(store.getState().finalCounts.filter((c) => c.productId === pid)).toHaveLength(1);
  });

  it("approving is idempotent: re-approving the same code makes no duplicate alias", () => {
    const store = createTestScanStore();
    const pid = makeWidgetWithDiscovered(store);
    store.getState().approveDiscoveredIdentifiers(pid, ["PN-DISC-1"]);
    store.getState().approveDiscoveredIdentifiers(pid, ["PN-DISC-1"]);
    const matches = store.getState().aliases.filter((a) => a.productId === pid && a.cleanCode === "PN-DISC-1");
    expect(matches).toHaveLength(1);
  });

  it("never fabricates: a code never present in product/decode is never an alias and never matches", () => {
    const store = createTestScanStore();
    const pid = makeWidgetWithDiscovered(store);
    expect(store.getState().aliases.some((a) => a.productId === pid && a.cleanCode === "NEVER-SEEN")).toBe(false);
    expect(store.getState().processScan("NEVER-SEEN")?.resolverStatus).toBe("needs_review");
  });

  it("conflict-safe: cannot approve a code already approved for a DIFFERENT product (no hijack)", () => {
    const store = createTestScanStore();
    const pid = makeWidgetWithDiscovered(store);
    // 885911484047 is seed DeWalt's approved barcode.
    store.getState().approveDiscoveredIdentifiers(pid, ["885911484047"]);
    const hijacked = store.getState().aliases.find((a) => a.cleanCode === "885911484047" && a.productId === pid && a.approved);
    expect(hijacked).toBeFalsy();
    expect(store.getState().lastAliasConflicts?.some((c) => c.code === "885911484047")).toBe(true);
    // still resolves to DeWalt
    expect(store.getState().processScan("885911484047")?.matchedProductId).toBe("prod-tool");
  });
});

describe("cross-identifier matching for a confirmed product (req 1)", () => {
  it("every identifier of a confirmed product resolves to it (barcode, part number, GTIN)", () => {
    const store = createTestScanStore();
    store.getState().processScan("700000000020");
    store.getState().resolveUnknown(reviewIdFor(store, "700000000020"), "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "MultiCode Widget", primaryBarcode: "700000000020", primarySku: "PNX-77", gtin: "700000000021" },
    });
    const pid = store.getState().products.find((p) => p.name === "MultiCode Widget")!.id;
    for (const code of ["700000000020", "PNX-77", "700000000021"]) {
      expect(store.getState().processScan(code)?.matchedProductId).toBe(pid);
    }
  });
});
