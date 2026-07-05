import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Task 5: scan-store application of the GPT-5.5 ladder trust tiers + a bounded decode queue.
// All fetch calls are mocked - no live tokens are spent.

function stub(resp: object) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  return store;
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

const crossCheckSingleProvider = (confidence: number) => ({
  decision: "single_provider" as const,
  confidence,
  reason: "gpt-5.5 ladder rung: single provider, no second AI to cross-check",
  brandSimilarity: 0,
  nameSimilarity: 0,
  contradictions: [],
});

function gptResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productName: "",
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
    confidence: 0,
    verifiedFacts: [] as string[],
    guesses: [] as string[],
    needsHumanReview: true,
    ...overrides,
  };
}

describe("GPT ladder trust tiers - verified auto-count", () => {
  it("gpt_self_report verified at confidence 0.9 auto-counts once (product created, counted, alias written), idempotent on double-apply", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTV0001");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Falken Wildpeak A/T3W 265/70R17",
          brand: "Falken",
          specsShort: "265/70R17 115T",
          sourceUrls: ["https://www.tirerack.com/x"],
          confidence: 0.9,
          guesses: ["exact code on tirerack page"],
          needsHumanReview: false,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.9,
        reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "gpt_self_report",
        crossCheck: crossCheckSingleProvider(0.9),
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("resolved"); // auto-counted -> resolveUnknown flips it resolved

    const product = store.getState().products.find((p) => p.name === "Falken Wildpeak A/T3W 265/70R17");
    expect(product).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);
    const alias = store.getState().aliases.find((a) => a.cleanCode === "GPTV0001");
    expect(alias).toBeDefined();
    expect(alias!.approved).toBe(true);

    // Idempotent on a repeat application: re-running resolveUnknown's underlying count for the SAME
    // scan event must never double count. Re-scan the same code - it should now resolve deterministically
    // via the approved alias (no second AI call) and only add ONE more unit.
    const { spy: spy2, restore: restore2 } = stub(RESP);
    try {
      store.getState().processScan("GPTV0001");
    } finally {
      restore2();
    }
    expect(spy2).not.toHaveBeenCalled(); // known alias now -> deterministic match, no AI
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(2);
  });

  it("gpt_self_report verified but confidence 0.79 does NOT auto-count (blocked, provisional/unverified only)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTV0002");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Michelin Defender 225/65R17",
          brand: "Michelin",
          confidence: 0.79,
          needsHumanReview: false,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.79,
        reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "gpt_self_report",
        crossCheck: crossCheckSingleProvider(0.79),
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("open"); // never auto-resolved
    const product = store.getState().products.find((p) => p.primaryBarcode === "GPTV0002");
    expect(product).toBeDefined();
    expect(product!.verified).toBe(false);
    expect(product!.provisional).toBe(true);
    const alias = store.getState().aliases.find((a) => a.cleanCode === "GPTV0002" && a.approved === true);
    expect(alias).toBeUndefined();
  });

  it("a verified decode WITHOUT gpt_self_report and without app-verified evidence stays blocked (old gate unweakened)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTV0003");
    const RESP = {
      providerNames: ["gemini", "openai"],
      results: [
        gptResult({
          productName: "Some Product",
          brand: "SomeBrand",
          confidence: 0.95,
          needsHumanReview: false,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.95,
        reason: "two providers agree",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "two_ai_agreement",
        crossCheck: { decision: "agree", confidence: 0.95, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("open");
    const product = store.getState().products.find((p) => p.primaryBarcode === "GPTV0003");
    expect(product?.verified).toBe(false);
  });
});

describe("GPT ladder trust tiers - suggested tier flows through unchanged", () => {
  it("gpt_self_report suggested tier lands as a one-tap candidate (hasSuggestion true), no auto-count", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTS0001");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Michelin Defender 225/65R17",
          brand: "Michelin",
          confidence: 0.6,
          guesses: [],
          needsHumanReview: true,
        }),
      ],
      decision: {
        status: "suggested",
        confidence: 0.6,
        reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: crossCheckSingleProvider(0.6),
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("open");
    expect(r.hasSuggestion).toBe(true);
    expect(r.suggestedProductName).toBe("Michelin Defender 225/65R17");
  });
});

describe("GPT ladder trust tiers - info_only (background info, never a candidate)", () => {
  it("final-exit shape: decodeNote carries the guess, hasSuggestion false, no suggested* fields", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTI0001");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "", // forced empty per the cache-safety contract
          brand: "Goodyear",
          confidence: 0.3,
          guesses: ["background info: Goodyear (best guess, low confidence) - barcode prefix suggests Goodyear family"],
          needsHumanReview: true,
        }),
      ],
      decision: {
        status: "needs_review",
        confidence: 0.3,
        reason: "background info only: Goodyear (best guess, low confidence)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: crossCheckSingleProvider(0.3),
      },
      reasonText: "background info only: Goodyear (best guess, low confidence)",
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.hasSuggestion).toBe(false);
    expect(r.suggestedProductName).toBe("");
    expect(r.suggestedBrand).toBe("");
    expect(r.decodeNote).toContain("Goodyear");
  });

  it("Plan D exit shape: guess lives ONLY in debug.gptLadderInfoOnly - same decodeNote/no-candidate treatment", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTI0002");
    const RESP = {
      providerNames: ["parallel:barcodedb"],
      results: [
        gptResult({
          productName: "Unidentified item (barcode GPTI0002)", // the Plan D floor's OWN result, untouched
          confidence: 0.5,
          needsHumanReview: true,
        }),
      ],
      decision: {
        status: "suggested",
        confidence: 0.5,
        reason: "Unverified parallel barcodedb (suggestion/floor) - not auto-counted",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: crossCheckSingleProvider(0.5),
      },
      debug: {
        gptLadderInfoOnly: "background info: Goodyear (best guess, low confidence) - barcode prefix suggests Goodyear family",
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.hasSuggestion).toBe(false);
    expect(r.suggestedProductName).toBe("");
    expect(r.decodeNote).toContain("Goodyear");
  });

  it("skip-reason transparency: a skipped gpt-5.5-ladder providerStatus entry is appended to decodeNote", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTI0003");
    const RESP = {
      providerNames: ["gemini"],
      results: [gptResult({ productName: "", confidence: 0 })],
      decision: {
        status: "needs_review",
        confidence: 0,
        reason: "No provider returned a usable product",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: crossCheckSingleProvider(0),
      },
      providerStatuses: [
        { provider: "gemini", status: "ok", latencyMs: 10, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false },
        { provider: "gpt-5.5-ladder", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: "budget_exceeded" },
      ],
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.decodeNote).toContain("budget_exceeded");
  });
});

describe("Bounded decode queue (burst-safe)", () => {
  it("bounds concurrent /api/ai-lookup calls to 2, drains FIFO, and completes all 6 without duplicate enqueue", async () => {
    const store = aiOnStore();
    const codes = ["QA1", "QA2", "QA3", "QA4", "QA5", "QA6"];
    const reviewIds = codes.map((code) => {
      store.getState().processScan(code);
      return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!.id;
    });
    store.getState().updateSettings({ aiLookupEnabled: true });

    const original = globalThis.fetch;
    const resolvers: Array<() => void> = [];
    const startedOrder: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let fetchCallCount = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchCallCount++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      startedOrder.push(body.cleanCode);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      concurrent--;
      return {
        ok: true,
        json: async () => ({
          providerNames: ["mock"],
          results: [],
          decision: { status: "needs_review", confidence: 0, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, reason: "", crossCheck: crossCheckSingleProvider(0) },
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const donePromise = Promise.all(reviewIds.map((id) => store.getState().liveDecode(id)));
      // Fire a duplicate call for the FIRST review while it is still queued/in-flight - must not enqueue twice.
      const dupePromise = store.getState().liveDecode(reviewIds[0]);

      await vi.waitFor(() => expect(resolvers.length).toBe(2));
      expect(maxConcurrent).toBe(2);
      expect(startedOrder).toEqual(["QA1", "QA2"]);

      resolvers.shift()!();
      await vi.waitFor(() => expect(resolvers.length).toBe(2));
      expect(startedOrder).toEqual(["QA1", "QA2", "QA3"]);

      resolvers.shift()!();
      await vi.waitFor(() => expect(resolvers.length).toBe(2));
      expect(startedOrder).toEqual(["QA1", "QA2", "QA3", "QA4"]);

      resolvers.shift()!();
      resolvers.shift()!();
      await vi.waitFor(() => expect(resolvers.length).toBe(2));
      expect(startedOrder).toEqual(["QA1", "QA2", "QA3", "QA4", "QA5", "QA6"]);

      resolvers.shift()!();
      resolvers.shift()!();
      await donePromise;
      await dupePromise;

      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(fetchCallCount).toBe(6); // the duplicate liveDecode call never triggered a 7th fetch
    } finally {
      globalThis.fetch = original;
    }
  });
});
