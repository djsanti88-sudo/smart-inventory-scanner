import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// P5b Task 2: proves the route hook wiring (fires on qualifying decode outcomes, never on
// cap_blocked, never under IS_E2E, never awaited into the response) without touching the real
// pipeline or a live Firestore instance.

const runDecodePipeline = vi.fn();
vi.mock("@/decoding/server/pipeline/pipeline", () => ({
  runDecodePipeline: (...a: unknown[]) => runDecodePipeline(...a),
  e2eMode: () => process.env.IS_E2E === "1",
}));

const appendMasterCatalogEntry = vi.fn();
const buildMasterCatalogEntry = vi.fn();
vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: (...a: unknown[]) => buildMasterCatalogEntry(...a),
  appendMasterCatalogEntry: (...a: unknown[]) => appendMasterCatalogEntry(...a),
}));

const logServerEvent = vi.fn();
vi.mock("@/decoding/server/log", () => ({
  logServerEvent: (...args: unknown[]) => logServerEvent(...args),
}));

const ORIG = { ...process.env };

beforeEach(() => {
  delete process.env.IS_E2E;
  delete process.env.MASTER_CATALOG_APPEND;
  process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
  runDecodePipeline.mockReset();
  appendMasterCatalogEntry.mockReset().mockResolvedValue("written");
  buildMasterCatalogEntry.mockReset().mockReturnValue({
    id: "gtin_012345678905",
    normalizedBarcode: "012345678905",
    name: "Widget 100",
    verificationStatus: "verified",
    provenanceTier: "ladder_verified_strong",
  });
  logServerEvent.mockReset();
});
afterEach(() => {
  process.env.IS_E2E = ORIG.IS_E2E;
  process.env.MASTER_CATALOG_APPEND = ORIG.MASTER_CATALOG_APPEND;
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
});

function decodeReq(extra: Record<string, unknown> = {}) {
  return new Request("http://x/api/ai-lookup", {
    method: "POST",
    body: JSON.stringify({ mode: "decode", cleanCode: "012345678905", ...extra }),
  });
}

function verifiedComputedOutcome() {
  return {
    kind: "computed" as const,
    payload: {
      mode: "decode" as const,
      providerNames: [],
      results: [{ productName: "Widget 100", brand: "Acme", category: "tools" }],
      evidences: [],
      providerStatuses: [],
      decision: { status: "verified", confidence: 0.9, reason: "x", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: "single_provider" },
      reasonCode: "ok",
      reasonText: "ok",
      timedOut: false,
      debug: {},
      sanitizedInput: { rawCodeSanitized: "012345678905", cleanCodeSanitized: "012345678905" },
    },
    cached: false,
    paidComputeCharged: true,
  };
}

describe("ai-lookup master-append hook wiring (P5b Task 2)", () => {
  // (a) verified app-verified -> append called once with the sanitized entry
  it("calls the append hook exactly once on a fresh verified/app-verified compute", async () => {
    runDecodePipeline.mockResolvedValue(verifiedComputedOutcome());
    const { POST } = await import("./route");
    await POST(decodeReq());
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget microtask flush
    expect(buildMasterCatalogEntry).toHaveBeenCalledOnce();
    expect(appendMasterCatalogEntry).toHaveBeenCalledOnce();
    const arg = buildMasterCatalogEntry.mock.calls[0][0];
    expect(arg.decision.status).toBe("verified");
    expect(arg.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
  });

  // (b) suggested -> never called
  it("does not call the append hook when the decision is only 'suggested'", async () => {
    buildMasterCatalogEntry.mockReturnValue(null); // the real builder would gate this out
    const outcome = verifiedComputedOutcome();
    outcome.payload.decision = { ...outcome.payload.decision, status: "suggested" };
    runDecodePipeline.mockResolvedValue(outcome);
    const { POST } = await import("./route");
    await POST(decodeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  it("never calls the append hook on cap_blocked (no decision was ever settled)", async () => {
    runDecodePipeline.mockResolvedValue({ kind: "cap_blocked" as const, message: "cap reached", reasonCode: "daily_cap" });
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(429);
    expect(logServerEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "paid_cap_exhausted",
      reasonCode: "daily_cap",
      status: 429,
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  // (c) append rejection does not change the HTTP response
  it("a rejected append never changes the HTTP response shape or status", async () => {
    appendMasterCatalogEntry.mockRejectedValue(new Error("firestore down"));
    runDecodePipeline.mockResolvedValue(verifiedComputedOutcome());
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).toBe("verified");
    await new Promise((r) => setTimeout(r, 0)); // the rejection resolves after the response
  });

  // (d) IS_E2E -> never called
  it("never calls the append hook under IS_E2E", async () => {
    process.env.IS_E2E = "1";
    runDecodePipeline.mockResolvedValue(verifiedComputedOutcome());
    const { POST } = await import("./route");
    await POST(decodeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  it("never calls the append hook when MASTER_CATALOG_APPEND=0 (kill switch)", async () => {
    process.env.MASTER_CATALOG_APPEND = "0";
    runDecodePipeline.mockResolvedValue(verifiedComputedOutcome());
    const { POST } = await import("./route");
    await POST(decodeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  // FIX 3 (review MEDIUM, sync-throw): a SYNCHRONOUS throw inside buildMasterCatalogEntry (called
  // directly, not awaited) must never break the POST response - the whole hook body must be wrapped
  // in try/catch, not just the async appendMasterCatalogEntry().catch() tail.
  it("a synchronous throw in buildMasterCatalogEntry never breaks the HTTP response", async () => {
    buildMasterCatalogEntry.mockImplementation(() => {
      throw new Error("boom: synchronous builder failure");
    });
    runDecodePipeline.mockResolvedValue(verifiedComputedOutcome());
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision.status).toBe("verified");
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  // FIX 4 (review MEDIUM, stale-verified replay + transaction storm): the `persisted` (cached/L2-replay)
  // branch must NEVER call the append hook - a cached payload may have been written under a looser
  // historical verify gate, and replaying it to master on every cache hit is both a trust hole and a
  // per-request transaction storm. Only the fresh `computed` branch appends.
  // FIX 2 (max-review, L1 replay append): the computed branch ALSO carries an in-memory L1 cache
  // replay (outcome.cached === true). Those replays were excluded from the sibling `persisted` branch
  // for the SAME staleness + transaction-storm reasons, so a cached computed outcome must not append
  // either - only a FRESH compute (cached === false) is trusted to write master truth.
  it("does NOT call the append hook on a computed outcome that is an L1 cache replay (cached:true)", async () => {
    const outcome = verifiedComputedOutcome();
    outcome.cached = true;
    runDecodePipeline.mockResolvedValue(outcome);
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });

  it("DOES call the append hook on a fresh computed outcome (cached:false)", async () => {
    const outcome = verifiedComputedOutcome();
    outcome.cached = false;
    runDecodePipeline.mockResolvedValue(outcome);
    const { POST } = await import("./route");
    await POST(decodeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).toHaveBeenCalledOnce();
    expect(appendMasterCatalogEntry).toHaveBeenCalledOnce();
  });

  it("does NOT call the append hook on a persisted/L2-replay outcome (fresh-compute only)", async () => {
    runDecodePipeline.mockResolvedValue({
      kind: "persisted" as const,
      body: {
        decision: { status: "verified", exactCodeEvidenceVerifiedByApp: true, confidence: 0.9 },
        results: [{ productName: "Widget 100", brand: "Acme", category: "tools" }],
        sanitizedInput: { cleanCodeSanitized: "012345678905" },
        debug: {},
      },
    });
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(buildMasterCatalogEntry).not.toHaveBeenCalled();
    expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
  });
});
