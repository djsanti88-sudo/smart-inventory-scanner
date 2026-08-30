// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const runDecodePipeline = vi.fn();
vi.mock("@/decoding/server/pipeline/pipeline", () => ({
  runDecodePipeline: (...args: unknown[]) => runDecodePipeline(...args),
  e2eMode: () => true,
}));

vi.mock("@/server/catalog/masterAppend", () => ({
  buildMasterCatalogEntry: () => null,
  appendMasterCatalogEntry: async () => "skipped_human" as const,
}));

vi.mock("@/decoding/server/log", () => ({
  logServerEvent: vi.fn(),
}));

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn() }),
  getAdminDb: () => ({ doc: () => ({ get: vi.fn() }) }),
}));

vi.mock("@/decoding/limits/aiSpendGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/decoding/limits/aiSpendGuard")>();
  return {
    ...orig,
    killSwitchOn: () => false,
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    readDailyUsedForAccount: vi.fn(),
    chargeDailySlotForAccount: vi.fn(),
  };
});

import { POST } from "./route";

function decodeRequest(cleanCode: string) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "decode", cleanCode, rawCode: cleanCode }),
  });
}

function noModeRequest(cleanCode: string) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cleanCode }),
  });
}

describe("bare numeric scan codes reach the pipeline unmasked", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    runDecodePipeline.mockReset();
    runDecodePipeline.mockResolvedValue({
      kind: "computed",
      payload: {
        mode: "decode",
        providerNames: [],
        results: [],
        decision: { status: "needs_review", confidence: 0, reason: "test", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "not_checked", confidence: 0, reason: "test", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
        timedOut: false,
        debug: {},
      },
      cached: false,
      paidComputeCharged: false,
    });
  });

  it("passes a bare 10-digit code through un-redacted", async () => {
    await POST(decodeRequest("3220015959"));
    expect(runDecodePipeline).toHaveBeenCalled();
    const flat = JSON.stringify(runDecodePipeline.mock.calls[0]);
    expect(flat).toContain("3220015959");
    expect(flat).not.toContain("redacted-phone");
  });

  it("still sanitizes free text with a formatted phone number", async () => {
    await POST(decodeRequest("call (305) 555-1234 about tire"));
    const flat = JSON.stringify(runDecodePipeline.mock.calls[0]);
    expect(flat).toContain("redacted-phone");
    expect(flat).not.toContain("305");
  });

  // Consolidation A1: the legacy 'lookup' response (which used to echo sanitizedInput for a
  // mode-less request) is deleted. A mode-less POST is now refused up front and never sanitizes,
  // never authenticates, and never reaches the pipeline.
  it("a mode-less request is refused with 400 unsupported_mode and never reaches the pipeline", async () => {
    const res = await POST(noModeRequest("3220015959"));
    expect(res.status).toBe(400);
    expect((await res.json()).reasonCode).toBe("unsupported_mode");
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });
});
