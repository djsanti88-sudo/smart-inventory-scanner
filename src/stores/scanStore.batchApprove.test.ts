import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { normalizeCode } from "@/services/codeNormalizer";

// Build 3: batch-approve for the Suggested pile (docs/superpowers/specs/2026-07-05-batch-approve-design.md).
// Approval MUST reuse resolveUnknown exactly as the single-approve flow (NeedsReviewTable "Approve
// suggestion" button) does - no new approval semantics, no new trust rule. batchApprove is a thin,
// chunked (25/commit) loop over that same call with per-row failure containment.

const clean = (s: string) => normalizeCode(s).clean;

function countFor(store: ReturnType<typeof createTestScanStore>, productId: string) {
  return store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;
}

/** Seed an OPEN "suggested" review for `code`: scans it (lands in Needs Review), then stamps it with
 *  an AI-style suggestion (hasSuggestion true, a product name/brand + a source URL) exactly like a
 *  live decode would, so it renders on the Suggested pile. */
function suggestedReview(store: ReturnType<typeof createTestScanStore>, code: string, n: number) {
  store.getState().processScan(code);
  const id = store.getState().needsReviewQueue.find((r) => r.cleanCode === clean(code) && r.status === "open")!.id;
  store.setState((s) => ({
    needsReviewQueue: s.needsReviewQueue.map((r) =>
      r.id === id
        ? {
            ...r,
            hasSuggestion: true,
            decodeStatus: "suggested" as const,
            suggestedProductName: `Suggested Widget ${n}`,
            suggestedBrand: `Brand${n}`,
            suggestedCategory: "widgets",
            suggestedSpecsShort: "",
            suggestedPrimarySku: "",
            suggestedPrimaryBarcode: r.cleanCode,
            suggestedGtin: "",
            suggestedUpc: "",
            suggestedEan: "",
            suggestedImageUrl: "",
            suggestedProductUrl: "",
            sourceUrls: [`https://example.com/widget-${n}`],
            confidence: 0.7,
          }
        : r,
    ),
  }));
  return id;
}

describe("scanStore - batchApprove (Build 3: batch-approve for the Suggested pile)", () => {
  it("approves N suggested rows: each creates/reuses its product and counts exactly once", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ids = [1, 2, 3, 4, 5].map((n) => suggestedReview(store, `BATCHCODE${n}`, n));

    const result = store.getState().batchApprove(ids);

    expect(result.approved).toHaveLength(5);
    expect(result.failed).toHaveLength(0);
    for (const n of [1, 2, 3, 4, 5]) {
      const prod = store.getState().products.find((p) => p.name === `Suggested Widget ${n}`);
      expect(prod, `product ${n} should be created`).toBeTruthy();
      expect(prod!.brand).toBe(`Brand${n}`);
      expect(countFor(store, prod!.id)).toBe(1);
    }
    // Every approved review is now resolved (left the open Suggested pile).
    for (const id of ids) {
      expect(store.getState().needsReviewQueue.find((r) => r.id === id)?.status).toBe("resolved");
    }
  });

  it("is idempotent: calling it a second time with the same ids approves 0 and never double-counts", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ids = [1, 2, 3].map((n) => suggestedReview(store, `IDEMPOTENT${n}`, n));

    const first = store.getState().batchApprove(ids);
    expect(first.approved).toHaveLength(3);

    const second = store.getState().batchApprove(ids);
    expect(second.approved).toHaveLength(0);
    expect(second.failed).toHaveLength(0);

    for (const n of [1, 2, 3]) {
      const prod = store.getState().products.find((p) => p.name === `Suggested Widget ${n}`);
      expect(countFor(store, prod!.id), `product ${n} must not double-count`).toBe(1);
    }
    // No duplicate products were minted on the re-run.
    expect(store.getState().products.filter((p) => p.name.startsWith("Suggested Widget")).length).toBe(3);
  });

  it("contains a per-row failure: a thrown row lands in failed[] and later rows still approve", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ids = [1, 2, 3].map((n) => suggestedReview(store, `FAILROW${n}`, n));
    const failingId = ids[1]; // the middle row throws; row 1 and row 3 must still succeed

    const original = store.getState().resolveUnknown;
    store.setState({
      resolveUnknown: (reviewId, action, payload) => {
        if (reviewId === failingId) throw new Error("synthetic resolveUnknown failure");
        return original(reviewId, action, payload);
      },
    });

    const result = store.getState().batchApprove(ids);

    expect(result.approved).toEqual([ids[0], ids[2]]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: failingId, reason: "synthetic resolveUnknown failure" });

    // The failed row is untouched (still open, no product minted for it); the other two succeeded.
    expect(store.getState().needsReviewQueue.find((r) => r.id === failingId)?.status).toBe("open");
    expect(store.getState().products.some((p) => p.name === "Suggested Widget 2")).toBe(false);
    expect(store.getState().products.some((p) => p.name === "Suggested Widget 1")).toBe(true);
    expect(store.getState().products.some((p) => p.name === "Suggested Widget 3")).toBe(true);
  });

  it("processes more than one chunk (26+ rows) without dropping or double-counting any row", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ns = Array.from({ length: 26 }, (_, i) => i + 1);
    const ids = ns.map((n) => suggestedReview(store, `CHUNK${n}`, n));

    const result = store.getState().batchApprove(ids);

    expect(result.approved).toHaveLength(26);
    expect(result.failed).toHaveLength(0);
    for (const n of ns) {
      const prod = store.getState().products.find((p) => p.name === `Suggested Widget ${n}`);
      expect(prod, `product ${n} should be created`).toBeTruthy();
      expect(countFor(store, prod!.id)).toBe(1);
    }
  });

  it("skips a row that is not open (already resolved/ignored) without adding it to approved or failed", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const [id1, id2] = [1, 2].map((n) => suggestedReview(store, `ALREADY${n}`, n));
    store.getState().resolveUnknown(id1, "ignore", {});

    const result = store.getState().batchApprove([id1, id2]);

    expect(result.approved).toEqual([id2]);
    expect(result.failed).toHaveLength(0);
    expect(store.getState().needsReviewQueue.find((r) => r.id === id1)?.status).toBe("ignored");
  });

  it("rejects a row with no usable suggestion, recording a clear reason, and continues the batch", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("NOSUGGESTION1");
    const badId = store.getState().needsReviewQueue.find((r) => r.cleanCode === clean("NOSUGGESTION1"))!.id;
    const goodId = suggestedReview(store, "GOODSUGGESTION1", 1);

    const result = store.getState().batchApprove([badId, goodId]);

    expect(result.approved).toEqual([goodId]);
    expect(result.failed).toEqual([{ id: badId, reason: "No suggestion to approve" }]);
  });

  it("reject (ignore) path: resolveUnknown ignore routes the review to ignored and keeps the suggestion as background info", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = suggestedReview(store, "REJECTME1", 1);

    store.getState().resolveUnknown(id, "ignore", {});

    const review = store.getState().needsReviewQueue.find((r) => r.id === id)!;
    expect(review.status).toBe("ignored");
    expect(review.suggestedProductName).toBe("Suggested Widget 1"); // kept as background info, not wiped
    expect(store.getState().products.some((p) => p.name === "Suggested Widget 1")).toBe(false);
  });

  it("a STRONG (real-evidence) suggestion still approves fully via batch: verified true, provisional false (unchanged behavior)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = suggestedReview(store, "STRONGGUESS1", 1); // helper sets a brand + one sourceUrl (real evidence)

    const result = store.getState().batchApprove([id]);

    expect(result.approved).toEqual([id]);
    const product = store.getState().products.find((p) => p.name === "Suggested Widget 1");
    expect(product, "product should be created").toBeTruthy();
    expect(product!.verified).toBe(true);
    expect(product!.provisional).toBe(false);
  });
});

/** Build 3 review Finding 1 (HIGH, trust rule violation): batchApprove passed `origin: "human"` to
 *  resolveUnknown, which DISABLES the weak-guess poison guard at the two provisional-reuse branches
 *  (`isWeakGuessReuse = isWeakGuess(review, np) && payload.origin !== "human"`), while the single-approve
 *  button (NeedsReviewTable "Approve suggestion") passes NO origin and keeps the guard active. A
 *  zero-evidence AI suggestion (empty brand, no gtin/upc/ean, no sourceUrls) must NOT become a verified
 *  product / approved alias just because it went through the batch path instead of the single button.
 *  Spec invariant: "Trust rules do NOT change" between single-approve and batch-approve. */
describe("scanStore - batchApprove trust rule parity (Build 3 review Finding 1)", () => {
  /** Seed an OPEN "suggested" review with an evidence-less AI guess: hasSuggestion true, a product name,
   *  but NO brand, NO gtin/upc/ean, and NO sourceUrls - isWeakGuess(review, np) is true when a create_new
   *  accepts this exact suggested name, so the poison guard must fire regardless of caller. */
  function weakSuggestedReview(store: ReturnType<typeof createTestScanStore>, code: string, n: number) {
    store.getState().processScan(code);
    const id = store.getState().needsReviewQueue.find((r) => r.cleanCode === clean(code) && r.status === "open")!.id;
    store.setState((s) => ({
      needsReviewQueue: s.needsReviewQueue.map((r) =>
        r.id === id
          ? {
              ...r,
              hasSuggestion: true,
              decodeStatus: "suggested" as const,
              suggestedProductName: `Weak Guess ${n}`,
              suggestedBrand: "", // no brand -> no real evidence
              suggestedCategory: "",
              suggestedSpecsShort: "",
              suggestedPrimarySku: "",
              suggestedPrimaryBarcode: r.cleanCode,
              suggestedGtin: "",
              suggestedUpc: "",
              suggestedEan: "",
              suggestedImageUrl: "",
              suggestedProductUrl: "",
              sourceUrls: [], // no sourceUrls -> no real evidence
              confidence: 0.4,
            }
          : r,
      ),
    }));
    return id;
  }

  it("batchApprove on a zero-evidence suggestion keeps the poison guard active: product stays unverified/provisional, exactly like the single-approve button", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = weakSuggestedReview(store, "WEAKGUESS1", 1);

    const result = store.getState().batchApprove([id]);

    // resolveUnknown still resolves the review either way (matches single-approve: the poison guard
    // blocks trust, not resolution) - the row leaves "open" and is reported approved.
    expect(result.approved).toEqual([id]);
    const product = store.getState().products.find((p) => p.name === "Weak Guess 1");
    expect(product, "the provisional placeholder should still exist, upgraded in place").toBeTruthy();
    // TRUST RULE: batchApprove must NOT pass origin: "human" to resolveUnknown. That clause exists only
    // to let a human who typed their OWN product identity confirm a provisional; batch approval accepts
    // the AI's suggestion verbatim, so it must be held to the exact same evidence bar as one-at-a-time.
    expect(product!.verified, "must stay unverified - same as clicking Approve suggestion once").toBe(false);
    expect(product!.provisional, "must stay provisional - same as clicking Approve suggestion once").toBe(true);
  });

  it("single-approve parity baseline: resolveUnknown with the exact NeedsReviewTable button payload (no origin) on the same weak suggestion also stays provisional", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const id = weakSuggestedReview(store, "WEAKGUESS2", 2);
    const review = store.getState().needsReviewQueue.find((r) => r.id === id)!;

    // Exactly the NeedsReviewTable "Approve suggestion" button payload (src/components/NeedsReviewTable.tsx)
    // - no `origin` field at all.
    store.getState().resolveUnknown(id, "create_new", {
      applyToCount: true,
      newProduct: {
        name: review.suggestedProductName,
        brand: review.suggestedBrand,
        category: review.suggestedCategory,
        specsShort: review.suggestedSpecsShort,
        primarySku: review.suggestedPrimarySku,
        primaryBarcode: review.suggestedPrimaryBarcode || review.cleanCode,
        gtin: review.suggestedGtin,
        upc: review.suggestedUpc,
        ean: review.suggestedEan,
        imageUrl: review.suggestedImageUrl,
        productUrl: review.suggestedProductUrl,
      },
      selectedAliasCodes: [],
    });

    const product = store.getState().products.find((p) => p.name === "Weak Guess 2");
    expect(product, "the provisional placeholder should still exist, upgraded in place").toBeTruthy();
    expect(product!.verified).toBe(false);
    expect(product!.provisional).toBe(true);
  });
});
