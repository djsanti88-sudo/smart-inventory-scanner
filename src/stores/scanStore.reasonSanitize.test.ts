import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): CLIENT-SIDE defense-in-depth. Even
// though the server now sanitizes reasonText/decision.reason before responding (pipeline.ts), the
// store must not trust that unconditionally - a raw vendor/service/model name reaching
// needsReviewQueue[].reason or scanFeed[].reason must be sanitized here too before it is ever
// rendered (LiveScanFeed.tsx / NeedsReviewTable.tsx render these fields verbatim to every role).

const DENYLIST_RE =
  /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

function crossCheckStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    decision: "single_provider",
    confidence: 0,
    reason: "",
    brandSimilarity: 0,
    nameSimilarity: 0,
    contradictions: [],
    ...overrides,
  };
}

describe("BUG #14: client-side reason sanitization (defense in depth)", () => {
  it("a leaking raw reasonText from a hypothetically unsanitized server never reaches needsReviewQueue[].reason or scanFeed[].reason", async () => {
    const store = aiOnStore();
    const code = "086699998540";
    const review = openReview(store, code);

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providerNames: ["fetchv2"],
          results: [],
          reasonText: "No rung resolved the code. upcitemdb: no match; openfoodfacts: no match; goupc: not a GTIN; fetchv2: no usable identity; gpt: gpt-5.5 skipped: gpt_call_failed",
          decision: {
            status: "needs_review",
            confidence: 0,
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            reason: "No rung resolved the code. upcitemdb: no match; openfoodfacts: no match; goupc: not a GTIN; fetchv2: no usable identity; gpt: gpt-5.5 skipped: gpt_call_failed",
            crossCheck: crossCheckStub(),
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.reason ?? "").not.toMatch(DENYLIST_RE);
    expect((r?.reason ?? "").length).toBeGreaterThan(0);

    const feedRow = store.getState().scanFeed.find((e) => e.cleanCode === code);
    expect(feedRow?.reason ?? "").not.toMatch(DENYLIST_RE);
  });

  it("a raw decision.reason naming the GPT decode never reaches the needs-review row's reason", async () => {
    const store = aiOnStore();
    const code = "086699998541";
    const review = openReview(store, code);

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providerNames: ["gpt-5.4-mini"],
          results: [
            {
              productName: "Goodyear (best guess, low confidence)",
              brand: "Goodyear",
              category: "",
              confidence: 0.3,
              needsHumanReview: true,
              sourceUrls: [],
              verifiedFacts: [],
              guesses: [],
            },
          ],
          reasonText: "",
          decision: {
            status: "suggested",
            confidence: 0.3,
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            reason: "gpt-5.5 from-scratch: best guess shown as returned (owner trust rule)",
            crossCheck: crossCheckStub({ decision: "single_provider" }),
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.reason ?? "").not.toMatch(DENYLIST_RE);
    expect((r?.reason ?? "").length).toBeGreaterThan(0);
  });

  it("honest server reasons (offline / cap / missing keys style prose) still survive intact through the client sanitizer", async () => {
    const store = aiOnStore();
    const code = "086699998542";
    const review = openReview(store, code);
    const honestReason = "Searched the barcode databases and the open web - no product matched this barcode.";

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providerNames: [],
          results: [],
          reasonText: honestReason,
          decision: {
            status: "needs_review",
            confidence: 0,
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            reason: honestReason,
            crossCheck: crossCheckStub(),
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const r = store.getState().needsReviewQueue.find((q) => q.id === review.id);
    expect(r?.reason).toBe(honestReason);
  });
});
