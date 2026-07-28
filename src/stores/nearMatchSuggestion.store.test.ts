import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// QA Task 8 (owner-approved 2026-07-15): store-level wiring proof. The deterministic resolver's
// nearMatchSuggestion (resolver.ts) must reach the Needs Review row as suggestedLinkProductId -
// reusing the EXACT SAME one-tap "Link to <product>" UI/path as the existing identity-merge
// suggest_link (see identityMerge.store.test.ts) - and it must NEVER upgrade the scan to known,
// NEVER auto-count against the real product, and NEVER auto-create an alias.

describe("scanStore near-match SKU suggestion (QA Task 8)", () => {
  it("scanning a 1-off typo of the seeded T432119 SKU stays needs_review and attaches suggestedLinkProductId to prod-nokian", () => {
    const store = createTestScanStore({ db: new MockDb() });

    const event = store.getState().processScan("T432118");
    expect(event, "unknown scan still returns an event (never blocked)").not.toBeNull();
    expect(event!.resolverStatus, "resolver status must stay needs_review, never known").toBe("needs_review");
    expect(event!.matchedProductId, "scan must never be auto-matched to the near-match product").toBeNull();

    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "T432118" && r.status === "open");
    expect(review, "an open review is created for the unknown code").toBeDefined();
    expect(review!.suggestedLinkProductId, "near-match suggestion reaches the review as suggestedLinkProductId").toBe(
      "prod-nokian",
    );

    // The real product's count must be untouched - a suggestion is not a count.
    const nokianCount = store.getState().finalCounts.find((c) => c.productId === "prod-nokian");
    expect(nokianCount?.quantity ?? 0, "the near-match candidate product's quantity is untouched by the mere suggestion").toBe(0);

    // No alias was auto-created linking the typo to the real product.
    const autoAlias = store.getState().aliases.find((a) => a.cleanCode === "T432118" && a.productId === "prod-nokian");
    expect(autoAlias, "the suggestion never auto-creates an alias").toBeUndefined();
  });

  it("a human clicking the one-tap link resolves through the existing link_existing path (alias learned, review closed)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("T432118");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "T432118" && r.status === "open")!;
    expect(review.suggestedLinkProductId).toBe("prod-nokian");

    store.getState().resolveUnknown(review.id, "link_existing", { productId: "prod-nokian", applyToCount: true });

    const resolved = store.getState().needsReviewQueue.find((r) => r.id === review.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionAction).toBe("link_existing");
    const alias = store.getState().aliases.find((a) => a.cleanCode === "T432118");
    expect(alias?.productId).toBe("prod-nokian");
    expect(alias?.approved).toBe(true);

    // Only AFTER the human approves does the real product's count move.
    const nokianCount = store.getState().finalCounts.find((c) => c.productId === "prod-nokian");
    expect(nokianCount?.quantity ?? 0).toBeGreaterThan(0);
  });

  it("a non-alpha_sku (numeric) unknown code near a numeric SKU gets no suggestedLinkProductId", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // 28816861 is the seeded primarySku for a different product (numeric_sku shape); a 1-digit-off
    // numeric scan must not trigger the alpha_sku-only near-match path.
    store.getState().processScan("28816862");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "28816862" && r.status === "open");
    expect(review).toBeDefined();
    expect(review!.suggestedLinkProductId).toBeUndefined();
  });
});
