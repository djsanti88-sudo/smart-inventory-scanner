import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore, trustedExactProbeCandidate } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { validatePendingSyncItem } from "@/services/db/firebase/firebaseSyncSafety";
import type { PendingSyncItem, ScanEvent } from "@/types";

const SHORT_CODE = "3220017438";
const OTHER_SHORT_CODE = "3220017439";
const VALID_GTIN = "036000291452";
const CANONICAL_ID = `trusted-exact:v1:${"B".repeat(32)}`;
const FINGERPRINT = { schemaVersion: "1.0.0", contentDigest: "A".repeat(64) };
const originalFetch = globalThis.fetch;

interface TrustedResponseBody {
  decision: {
    corroborationPath?: string;
    trustedExactCanonicalProductId?: string;
  };
  trustedExact: {
    index?: { contentDigest: string };
  };
  [key: string]: unknown;
}

function response(code = SHORT_CODE, canonicalId = CANONICAL_ID): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      mode: "decode",
      providerNames: ["tire-corpus"],
      results: [{
        productName: "Boss exact tire",
        brand: "Blackhawk",
        category: "Tire",
        specsShort: "235/60R18",
        primarySku: "BH-2356018",
        primaryBarcode: code,
        gtin: "",
        upc: "",
        ean: "",
        confidence: 1,
      }],
      decision: {
        status: "verified",
        confidence: 1,
        reason: "Authenticated trusted exact corpus match.",
        evidenceStrength: "fetched_source",
        exactCodeEvidenceVerifiedByApp: true,
        corroborationPath: "boss_trusted_exact_barcode",
        trustedExactCanonicalProductId: canonicalId,
        crossCheck: { decision: "single_provider" },
      },
      trustedExact: { path: "boss_trusted_exact_barcode", index: { ...FINGERPRINT } },
    }),
  } as Response;
}

function missResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      mode: "decode",
      providerNames: [],
      results: [],
      decision: {
        status: "needs_review",
        confidence: 0,
        reason: "No trusted exact match was found.",
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        crossCheck: { decision: "not_checked" },
      },
      trustedExact: { path: "trusted_exact_miss" },
    }),
  } as Response;
}

function decodeCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/ai-lookup");
}

class StrictValidationDb extends MockDb {
  readonly rejected: Array<{ item: PendingSyncItem; errorCode: string }> = [];

  override apply(item: PendingSyncItem) {
    const failure = validatePendingSyncItem(item);
    if (failure) {
      this.rejected.push({ item, errorCode: failure.errorCode });
      return { ok: false, alreadyApplied: false, error: failure.message, errorCode: failure.errorCode };
    }
    return super.apply(item);
  }
}

afterEach(async () => {
  // Queue finalizers run after the review state mutation awaited by most tests. Let those module-level
  // finalizers release their slots before the next fresh store replaces the global fetch double.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
});

describe("authenticated trusted-exact scan settlement", () => {
  it("exports the pure probe eligibility contract for corpus certification", () => {
    expect(trustedExactProbeCandidate("3182205")).toBe(true);
    expect(trustedExactProbeCandidate("TST21017")).toBe(true);
    expect(trustedExactProbeCandidate("123 E+45")).toBe(true);
    expect(trustedExactProbeCandidate("01 Jan 2026")).toBe(true);
    expect(trustedExactProbeCandidate("12345'")).toBe(true);
    expect(trustedExactProbeCandidate("000000000000")).toBe(false);
    expect(trustedExactProbeCandidate("QA1")).toBe(false);
    expect(trustedExactProbeCandidate("LABEL")).toBe(false);
    expect(trustedExactProbeCandidate("????1")).toBe(false);
  });

  it.each([
    ["approved 3-digit", "550", `trusted-exact:v1:${"1".repeat(32)}`],
    ["approved 7-digit", "3182205", `trusted-exact:v1:${"2".repeat(32)}`],
    ["approved invalid EAN-8-shaped", "54199694", `trusted-exact:v1:${"3".repeat(32)}`],
    ["approved invalid UPC-shaped", "491910534204", `trusted-exact:v1:${"4".repeat(32)}`],
    ["approved alphanumeric", "TST21017", `trusted-exact:v1:${"5".repeat(32)}`],
    ["approved separated alphanumeric", "200624-777", `trusted-exact:v1:${"6".repeat(32)}`],
  ])("probes and settles a %s corpus spelling", async (_label, code, canonicalId) => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async () => response(code, canonicalId));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(code);

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));
    expect(JSON.parse(String(decodeCalls(fetchSpy)[0]?.[1]?.body))).toMatchObject({
      deterministicOnly: true,
      rawCode: code,
      cleanCode: code,
    });
    expect(store.getState().products.find((item) => item.trustedExactCanonicalId === canonicalId)).toBeDefined();
  });

  it("counts an approved-style short code immediately, then settles its own review without aliases or catalog writes", async () => {
    const db = new MockDb();
    const lookupGlobalCatalog = vi.fn(async () => null);
    const store = createTestScanStore({ db, lookupGlobalCatalog, trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const aliasesBefore = store.getState().aliases;
    const fetchSpy = vi.fn(async () => response());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const event = store.getState().processScan(SHORT_CODE);

    expect(event?.rawCode).toBe(SHORT_CODE);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    expect(store.getState().scanFeed).toHaveLength(1);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));

    const body = JSON.parse(String(decodeCalls(fetchSpy)[0]?.[1]?.body));
    expect(body).toMatchObject({ mode: "decode", deterministicOnly: true, cleanCode: SHORT_CODE });
    const state = store.getState();
    expect(state.needsReviewQueue[0]?.resolutionAction).toBe("trusted_exact");
    expect(state.scanFeed[0]).toMatchObject({
      rawCode: SHORT_CODE,
      cleanCode: SHORT_CODE,
      status: "known",
      resolverStatus: "known",
      decodeStatus: "verified",
      provenance: "app_verified",
    });
    const product = state.products.find((item) => item.trustedExactCanonicalId === CANONICAL_ID);
    expect(product).toMatchObject({ name: "Boss exact tire", verified: true, provisional: false, aliases: [] });
    expect(state.aliases).toEqual(aliasesBefore);
    expect(state.catalog).toEqual([]);
    expect(lookupGlobalCatalog).not.toHaveBeenCalled();
    expect(db.snapshot().reviews[state.needsReviewQueue[0].id]).toMatchObject({
      status: "resolved",
      resolutionAction: "trusted_exact",
    });
    expect(db.snapshot().scanEvents[event!.id]?.decodeStatus).toBe("verified");
  });

  it("drains every trusted-exact persistence operation through the Firebase safety envelope", async () => {
    const db = new StrictValidationDb();
    const store = createTestScanStore({ db, trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    globalThis.fetch = vi.fn(async () => response()) as unknown as typeof fetch;

    store.getState().processScan(SHORT_CODE);

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));
    await vi.waitFor(() => expect(store.getState().pendingSyncQueue).toEqual([]));
    expect(db.rejected).toEqual([]);
  });

  it("settles a rapid duplicate short scan exactly twice with one request and no duplicate product", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(() => pending);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(SHORT_CODE);
    store.getState().processScan(SHORT_CODE);

    const pendingSnapshot = {
      totalCount: store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0),
      rawCodes: store.getState().scanFeed.map((event) => event.rawCode),
      decodeStatuses: store.getState().scanFeed.map((event) => event.decodeStatus),
      reasons: store.getState().scanFeed.map((event) => event.reason),
      reviews: store.getState().needsReviewQueue.map((review) => ({ status: review.status, decodeStatus: review.decodeStatus })),
    };
    release(response());
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));

    expect(pendingSnapshot.totalCount).toBe(2);
    expect(pendingSnapshot.rawCodes).toEqual([SHORT_CODE, SHORT_CODE]);
    expect(pendingSnapshot.decodeStatuses).toEqual(["decoding", "decoding"]);
    expect(pendingSnapshot.reasons.every((reason) => !/suggested|needs review/i.test(reason))).toBe(true);
    expect(pendingSnapshot.reviews).toEqual([{ status: "open", decodeStatus: "decoding" }]);

    const state = store.getState();
    expect(decodeCalls(fetchSpy)).toHaveLength(1);
    expect(state.products.filter((item) => item.trustedExactCanonicalId === CANONICAL_ID && item.status === "active")).toHaveLength(1);
    expect(state.finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(2);
    expect(state.scanFeed.every((event) => event.decodeStatus === "verified")).toBe(true);
  });

  it("keeps the existing Suggested repeat presentation for an ordinary decode in flight", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: false });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    globalThis.fetch = vi.fn(() => pending) as unknown as typeof fetch;

    store.getState().processScan(SHORT_CODE);
    store.getState().processScan(SHORT_CODE);

    const pendingStatuses = store.getState().scanFeed.map((event) => event.decodeStatus);
    release(response());
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));

    expect(pendingStatuses).toEqual(["suggested", "decoding"]);
  });

  it("coalesces two short-code spellings with one opaque canonical id without learning aliases", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const aliasesBefore = store.getState().aliases;
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const code = JSON.parse(String(init?.body)).cleanCode as string;
      return response(code, CANONICAL_ID);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(SHORT_CODE);
    store.getState().processScan(OTHER_SHORT_CODE);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue.every((review) => review.status === "resolved")).toBe(true));

    const state = store.getState();
    const active = state.products.filter((item) => item.trustedExactCanonicalId === CANONICAL_ID && item.status === "active");
    expect(active).toHaveLength(1);
    expect(state.finalCounts).toEqual([expect.objectContaining({ productId: active[0].id, quantity: 2 })]);
    expect(state.aliases).toEqual(aliasesBefore);
    expect(state.catalog).toEqual([]);
    expect(state.scanFeed.every((event) => event.matchedProductId === active[0].id && event.decodeStatus === "verified")).toBe(true);
  });

  it("never repoints an unrelated null event while settling the matching review", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const unrelated: ScanEvent = {
      id: "unrelated-null-event",
      businessId: store.getState().businessId,
      sessionId: store.getState().sessionId,
      rawCode: "unrelated",
      cleanCode: "unrelated",
      normalizedCandidates: [],
      matchedProductId: null,
      matchType: "unknown",
      status: "needs_review",
      resolverStatus: "needs_review",
      codeType: "messy",
      reason: "unrelated",
      quantityDelta: 0,
      quantityAfterScan: 0,
      createdAt: "2026-08-04T00:00:00.000Z",
      source: "scan",
      notes: "",
      syncStatus: "pending",
      idempotencyKey: "unrelated-key",
      syncError: null,
    };
    store.setState((state) => ({ scanFeed: [unrelated, ...state.scanFeed] }));
    globalThis.fetch = vi.fn(async () => response()) as unknown as typeof fetch;

    store.getState().processScan(SHORT_CODE);
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));

    expect(store.getState().scanFeed.find((event) => event.id === unrelated.id)).toMatchObject({
      id: unrelated.id,
      rawCode: unrelated.rawCode,
      cleanCode: unrelated.cleanCode,
      matchedProductId: null,
      status: "needs_review",
      resolverStatus: "needs_review",
      reason: "unrelated",
    });
  });

  it("rejects self-claimed or incomplete trusted responses and leaves the counted row reviewable", async () => {
    for (const mutate of [
      (body: TrustedResponseBody) => { body.decision.corroborationPath = "corpus_exact_barcode"; },
      (body: TrustedResponseBody) => { delete body.decision.trustedExactCanonicalProductId; },
      (body: TrustedResponseBody) => { delete body.trustedExact.index; },
      (body: TrustedResponseBody) => { if (body.trustedExact.index) body.trustedExact.index.contentDigest = "bad"; },
    ]) {
      const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
      store.getState().updateSettings({ aiLookupEnabled: false });
      const trusted = await response().json() as TrustedResponseBody;
      mutate(trusted);
      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => trusted }) as Response) as unknown as typeof fetch;

      store.getState().processScan(SHORT_CODE);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).not.toBe("decoding"));

      const state = store.getState();
      expect(state.needsReviewQueue[0]?.status).toBe("open");
      expect(state.products.find((item) => item.primaryBarcode === SHORT_CODE)).toMatchObject({ verified: false });
      expect(state.products.some((item) => item.trustedExactCanonicalId === CANONICAL_ID)).toBe(false);
      expect(state.scanFeed[0]?.decodeStatus).not.toBe("verified");
      expect(state.finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
    }
  });

  it("probes a non-indexed safe spelling but keeps its counted review open on an exact miss", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async () => missResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan("3182206");

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(1));
    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));
    expect(store.getState().needsReviewQueue[0]?.status).toBe("open");
    expect(store.getState().products.find((item) => item.primaryBarcode === "3182206")).toMatchObject({ verified: false });
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("probes a valid GTIN through trusted exact first and stops before ordinary decode on an exact hit", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const fetchSpy = vi.fn(async () => response(VALID_GTIN));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(VALID_GTIN);

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.status).toBe("resolved"));
    const bodies = decodeCalls(fetchSpy).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => ({ mode: body.mode, code: body.cleanCode, deterministicOnly: body.deterministicOnly }))).toEqual([
      { mode: "decode", code: VALID_GTIN, deterministicOnly: true },
    ]);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("falls back exactly once through ordinary decode after a valid GTIN trusted-exact miss", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const fetchSpy = vi.fn(async () => missResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan(VALID_GTIN);

    await vi.waitFor(() => expect(decodeCalls(fetchSpy)).toHaveLength(2));
    const bodies = decodeCalls(fetchSpy).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.deterministicOnly)).toEqual([true, false]);
    expect(store.getState().needsReviewQueue[0]).toMatchObject({ status: "open", decodeStatus: "needs_review" });
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("does not fall through to ordinary decode when a non-GTIN trusted-exact probe misses", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    const fetchSpy = vi.fn(async () => missResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan("TST21018");

    await vi.waitFor(() => expect(store.getState().needsReviewQueue[0]?.decodeStatus).toBe("needs_review"));
    const bodies = decodeCalls(fetchSpy).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.deterministicOnly)).toEqual([true]);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(1);
  });

  it("does not dispatch placeholders or arbitrary non-identifier labels", async () => {
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: true });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const fetchSpy = vi.fn(async () => missResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    store.getState().processScan("000000000000"); // placeholder GTIN
    store.getState().processScan("???"); // arbitrary malformed label
    store.getState().processScan("QA1"); // arbitrary alphanumeric label

    await Promise.resolve();
    expect(decodeCalls(fetchSpy)).toHaveLength(0);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(3);
  });

  it("runs a trusted-exact burst in its own four-wide lane and releases a failed slot", async () => {
    // The production queues are module-scoped; allow finalizers from the preceding independent test to
    // drain before this test replaces fetch and measures only this burst.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Create passive reviews first, then invoke the public deterministic-only entry point. This isolates
    // lane scheduling from catalog/resolver data and makes the concurrency observation deterministic.
    const store = createTestScanStore({ db: new MockDb(), trustedExactProbeEnabled: false });
    store.getState().updateSettings({ aiLookupEnabled: false });

    type Pending = { code: string; settle: (outcome: "ok" | "reject") => void };
    const pending: Pending[] = [];
    const started: Array<{ code: string; deterministicOnly: boolean }> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      started.push({ code: body.cleanCode, deterministicOnly: body.deterministicOnly });
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const outcome = await new Promise<"ok" | "reject">((settle) => pending.push({ code: body.cleanCode, settle }));
      concurrent--;
      if (outcome === "reject") throw new Error(`trusted exact probe failed for ${body.cleanCode}`);
      return response(body.cleanCode, CANONICAL_ID);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const codes = ["QTP1", "QTP2", "QTP3", "QTP4", "QTP5", "QTP6"];
    for (const code of codes) store.getState().processScan(code);
    // A duplicate physical scan must count, but it must share the in-flight review/probe rather than
    // enqueueing a seventh trusted-exact request or flashing an ordinary Suggested presentation.
    store.getState().processScan(codes[0]);
    const reviewIds = codes.map((code) => store.getState().needsReviewQueue.find((review) => review.cleanCode === code)!.id);
    const done = Promise.all(reviewIds.map((reviewId) => store.getState().liveDecode(reviewId, { deterministicOnly: true })));
    const duplicate = store.getState().liveDecode(reviewIds[0], { deterministicOnly: true });

    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(maxConcurrent).toBe(4);
    expect(started).toEqual(codes.slice(0, 4).map((code) => ({ code, deterministicOnly: true })));
    expect(store.getState().needsReviewQueue.every((review) => review.status !== "suggested")).toBe(true);

    const reject = pending.find((item) => item.code === codes[1])!;
    pending.splice(pending.indexOf(reject), 1);
    reject.settle("reject");
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(maxConcurrent).toBeLessThanOrEqual(4);

    while (pending.length > 0) {
      const item = pending.shift()!;
      item.settle("ok");
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(started).toHaveLength(6));
    while (pending.length > 0) pending.shift()!.settle("ok");
    await done;
    await duplicate;

    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(decodeCalls(fetchSpy)).toHaveLength(6);
    expect(store.getState().finalCounts.reduce((sum, row) => sum + row.quantity, 0)).toBe(7);
  });
});
