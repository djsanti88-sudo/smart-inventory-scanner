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
  // NOTE: this code MUST be a public-barcode shape (upc_a/ean_13/gtin_14). The gpt_self_report trust
  // tier is ONLY theoretically falsifiable (GPT claims to have found the exact code on a real page) for
  // a real public barcode - a vendor/SKU/part-number code has no public page to have been "found" on, so
  // trusting a bare self-report for those shapes is exactly the T20 code-1225 hallucination-auto-count
  // hole (see .superpowers/sdd/task-1225-report.md). A 12-digit numeric code is upc_a.
  it("gpt_self_report verified at confidence 0.9 on a PUBLIC BARCODE (upc_a) auto-counts once (product created, counted, alias written), idempotent on double-apply", async () => {
    const store = aiOnStore();
    const review = openReview(store, "012345678905");
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
    const alias = store.getState().aliases.find((a) => a.cleanCode === "012345678905");
    expect(alias).toBeDefined();
    expect(alias!.approved).toBe(true);

    // Idempotent on a repeat application: re-running resolveUnknown's underlying count for the SAME
    // scan event must never double count. Re-scan the same code - it should now resolve deterministically
    // via the approved alias (no second AI call) and only add ONE more unit.
    const { spy: spy2, restore: restore2 } = stub(RESP);
    try {
      store.getState().processScan("012345678905");
    } finally {
      restore2();
    }
    expect(spy2).not.toHaveBeenCalled(); // known alias now -> deterministic match, no AI
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(2);
  });

  // T20 code-1225 regression: a NON-public-barcode-shaped code (numeric_sku, 4 digits) can NEVER auto-count
  // off a bare gpt_self_report, even at high self-reported confidence with a plausible-looking product name.
  // GPT cannot have "found" a 4-digit vendor part number on a real public page - a self-report here is
  // intrinsically unverifiable and must be capped to a provisional/suggested candidate, never verified.
  it("gpt_self_report verified at confidence 0.9 on a NUMERIC_SKU code (vendor part number, e.g. 1225) does NOT auto-count - routes to provisional/needs review", async () => {
    const store = aiOnStore();
    const review = openReview(store, "1225");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Spitz Vorosafonya Cranberry Juice", // fabricated identity, mirrors the live T20 failure
          brand: "Spitz",
          confidence: 0.9,
          guesses: ["exact code self-reported"],
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
    expect(r.status).toBe("open"); // never auto-resolved on a non-public code shape
    const product = store.getState().products.find((p) => p.primaryBarcode === "1225");
    // A provisional count may still exist (DECODE-EVERYTHING rule), but it must never be verified/approved.
    if (product) {
      expect(product.verified).toBe(false);
    }
    const alias = store.getState().aliases.find((a) => a.cleanCode === "1225" && a.approved === true);
    expect(alias).toBeUndefined();
  });

  // Same hole, alpha_sku shape (a Moen-style vendor part number, letters+digits).
  it("gpt_self_report verified at confidence 0.95 on an ALPHA_SKU vendor part number does NOT auto-count", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GP1043211");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Fabricated Vendor Product Name",
          brand: "SomeBrand",
          confidence: 0.95,
          guesses: ["exact code self-reported"],
          needsHumanReview: false,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.95,
        reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        corroborationPath: "gpt_self_report",
        crossCheck: crossCheckSingleProvider(0.95),
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
    const alias = store.getState().aliases.find((a) => a.cleanCode === "GP1043211" && a.approved === true);
    expect(alias).toBeUndefined();
  });

  // Regression guard: a corpus/Go-UPC style app-verified result on a public barcode must still auto-count.
  // This is untouched by the fix - exactCodeEvidenceVerifiedByApp true is real app verification, not a
  // self-report, and decodeCorroborated() already covers this path independent of gptTrusted.
  it("app-verified exact code on a public barcode (upc_a) still auto-counts (legitimate corpus/Go-UPC path unchanged)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "078742222222");
    const RESP = {
      providerNames: ["corpus"],
      results: [
        gptResult({
          productName: "Moen Faucet Cartridge 1225",
          brand: "Moen",
          confidence: 0.95,
          needsHumanReview: false,
        }),
      ],
      decision: {
        status: "verified",
        confidence: 0.95,
        reason: "corpus: app-verified exact code match",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "exact_code_evidence",
        crossCheck: crossCheckSingleProvider(0.95),
      },
    };
    const { restore } = stub(RESP);
    try {
      await store.getState().liveDecode(review.id);
    } finally {
      restore();
    }

    const r = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
    expect(r.status).toBe("resolved");
    const product = store.getState().products.find((p) => p.name === "Moen Faucet Cartridge 1225");
    expect(product).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);
  });

  it("gpt_self_report verified but confidence 0.79 on a public barcode does NOT auto-count (confidence gate, isolated from the shape gate)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "036000291452");
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
    const product = store.getState().products.find((p) => p.primaryBarcode === "036000291452");
    expect(product).toBeDefined();
    expect(product!.verified).toBe(false);
    expect(product!.provisional).toBe(true);
    const alias = store.getState().aliases.find((a) => a.cleanCode === "036000291452" && a.approved === true);
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

describe("GPT ladder - weak guesses are normal candidates (info_only deleted, owner order 2026-07-06)", () => {
  it("a 0.3-confidence GPT best-guess populates the suggested* candidate fields like any suggestion", async () => {
    const store = aiOnStore();
    const review = openReview(store, "GPTI0001");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Goodyear (best guess, low confidence)",
          brand: "Goodyear",
          confidence: 0.3,
          guesses: ["barcode prefix suggests Goodyear family"],
          needsHumanReview: true,
        }),
      ],
      decision: {
        status: "suggested",
        confidence: 0.3,
        reason: "gpt-5.5 from-scratch: best guess shown as returned (owner trust rule)",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: crossCheckSingleProvider(0.3),
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
    expect(r.suggestedProductName).toBe("Goodyear (best guess, low confidence)");
    expect(r.suggestedBrand).toBe("Goodyear");
    expect(r.confidence).toBe(0.3);
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

  it("a rejected/failed decode in the middle of a burst does not wedge the queue - later queued decodes still run and complete", async () => {
    const store = aiOnStore();
    const codes = ["RJ1", "RJ2", "RJ3", "RJ4"];
    const reviewIds = codes.map((code) => {
      store.getState().processScan(code);
      return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!.id;
    });
    store.getState().updateSettings({ aiLookupEnabled: true });

    const original = globalThis.fetch;
    // Same manually-resolvable-promise pattern as the burst test above, extended with an "outcome" so a
    // caller can settle a given in-flight call as either a normal response OR a thrown/rejected fetch
    // (simulating a network failure / provider error for exactly one queued task).
    type Pending = { code: string; settle: (outcome: "ok" | "reject") => void };
    const pending: Pending[] = [];
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
      const outcome = await new Promise<"ok" | "reject">((resolve) => {
        pending.push({ code: body.cleanCode, settle: resolve });
      });
      concurrent--;
      if (outcome === "reject") {
        throw new Error(`simulated network failure for ${body.cleanCode}`);
      }
      return {
        ok: true,
        json: async () => ({
          providerNames: ["mock"],
          results: [],
          decision: { status: "needs_review", confidence: 0, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, reason: "", crossCheck: crossCheckSingleProvider(0) },
        }),
      };
    }) as unknown as typeof fetch;

    const settle = (code: string, outcome: "ok" | "reject") => {
      const idx = pending.findIndex((p) => p.code === code);
      const [item] = pending.splice(idx, 1);
      item.settle(outcome);
    };

    try {
      const donePromise = Promise.all(reviewIds.map((id) => store.getState().liveDecode(id)));

      await vi.waitFor(() => expect(pending.length).toBe(2));
      expect(maxConcurrent).toBe(2);
      expect(startedOrder).toEqual(["RJ1", "RJ2"]);

      // Reject the SECOND task mid-burst (synthetic throw from the mocked fetch/decodeOnce path). A
      // rejected/errored slot must free its concurrency slot exactly like a successful one and the FIFO
      // queue must keep draining - RJ3 must start next.
      settle("RJ2", "reject");
      await vi.waitFor(() => expect(pending.length).toBe(2));
      expect(startedOrder).toEqual(["RJ1", "RJ2", "RJ3"]);
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      settle("RJ1", "ok");
      await vi.waitFor(() => expect(pending.length).toBe(2));
      expect(startedOrder).toEqual(["RJ1", "RJ2", "RJ3", "RJ4"]);
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      settle("RJ3", "ok");
      settle("RJ4", "ok");
      await donePromise;

      expect(pending.length).toBe(0); // every queued task (including the rejected one) ran to completion
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(fetchCallCount).toBe(4);

      // Prove the concurrency counter (activeDecodes) actually returned to 0 and the queue is not wedged:
      // a brand-new decode enqueued AFTER the burst must start immediately, not sit stuck behind a phantom
      // "still active" slot left over from the rejected task.
      const postCode = "RJ5";
      store.getState().processScan(postCode);
      const postReview = store.getState().needsReviewQueue.find((r) => r.cleanCode === postCode && r.status === "open")!;
      const postResp = {
        providerNames: ["mock"],
        results: [],
        decision: { status: "needs_review", confidence: 0, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, reason: "", crossCheck: crossCheckSingleProvider(0) },
      };
      globalThis.fetch = (async () => ({ ok: true, json: async () => postResp })) as unknown as typeof fetch;
      await store.getState().liveDecode(postReview.id);
      const postAfter = store.getState().needsReviewQueue.find((r) => r.id === postReview.id)!;
      expect(postAfter.status).toBe("open"); // completed (not stuck "decoding" forever)
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Direct idempotency lock (liveDecode re-entry on an already-resolved review)", () => {
  it("calling liveDecode twice for the SAME review is a no-op the second time (open-status guard, not the rescan/alias path)", async () => {
    const store = aiOnStore();
    const review = openReview(store, "614141000418");
    const RESP = {
      providerNames: ["gpt-5.5-ladder"],
      results: [
        gptResult({
          productName: "Continental TerrainContact 235/65R18",
          brand: "Continental",
          specsShort: "235/65R18 106T",
          sourceUrls: ["https://www.tirerack.com/y"],
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
    const { spy, restore } = stub(RESP);
    try {
      // First call: GPT verified 0.9 -> auto-count fires, review resolves.
      await store.getState().liveDecode(review.id);
      const afterFirst = store.getState().needsReviewQueue.find((x) => x.id === review.id)!;
      expect(afterFirst.status).toBe("resolved");
      expect(spy).toHaveBeenCalledTimes(1);

      const product = store.getState().products.find((p) => p.name === "Continental TerrainContact 235/65R18");
      expect(product).toBeDefined();
      expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1);

      // Second call for the SAME reviewId, called DIRECTLY (not via processScan/rescan) - this exercises
      // the `review.status !== "open"` guard at the top of runLiveDecodeOnce, not the deterministic-alias
      // rescan path. The review is no longer open, so this must be a pure no-op: no second fetch, no
      // second count, no duplicate product or alias.
      await store.getState().liveDecode(review.id);

      expect(spy).toHaveBeenCalledTimes(1); // fetch NOT called a second time
      expect(store.getState().finalCounts.find((c) => c.productId === product!.id)?.quantity).toBe(1); // unchanged
      expect(store.getState().products.filter((p) => p.name === "Continental TerrainContact 235/65R18")).toHaveLength(1); // no duplicate product
      expect(store.getState().aliases.filter((a) => a.cleanCode === "614141000418")).toHaveLength(1); // no duplicate alias
    } finally {
      restore();
    }
  });
});
