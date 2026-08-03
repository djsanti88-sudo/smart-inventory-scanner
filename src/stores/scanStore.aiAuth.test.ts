import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getSession }));

import { createTestScanStore } from "@/stores/scanStore";

describe("scanStore live decode auth", () => {
  beforeEach(() => {
    getSession.mockReset().mockResolvedValue({ getIdToken: vi.fn().mockResolvedValue("firebase-token") });
  });

  it("sends the Firebase token and active business ID to the live decode route", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        decision: { status: "needs_review", confidence: 0, reason: "No verified match.", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false },
        results: [],
      }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    try {
      const applied: Array<{ operation: string; idempotencyKey: string }> = [];
      const store = createTestScanStore({
        cloudBackend: true,
        db: {
          apply: async (item) => {
            applied.push(item);
            return { ok: true, alreadyApplied: false };
          },
          setFailure: () => {},
          reset: () => {},
        },
      });
      store.getState().setBusinessContext("business-live", "user-live");
      store.getState().updateSettings({ aiLookupEnabled: false });
      store.getState().processScan("086699205636");
      const review = store.getState().needsReviewQueue.find((item) => item.cleanCode === "086699205636")!;
      store.getState().updateSettings({ aiLookupEnabled: true });

      await store.getState().liveDecode(review.id);

      const calls = (fetchSpy as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
      const call = calls.find(([url]) => url === "/api/ai-lookup");
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body).toMatchObject({ idToken: "firebase-token", businessId: "business-live", mode: "decode" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(applied.some((item) => item.operation === "SAVE_PRODUCT" && item.idempotencyKey.includes(":decode:"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the unredacted scan candidate separately while retaining redacted decode fields", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        decision: { status: "needs_review", confidence: 0, reason: "No verified match.", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false },
        results: [],
      }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    try {
      const store = createTestScanStore();
      store.getState().updateSettings({ aiLookupEnabled: false });
      store.getState().processScan("3220017209");
      const review = store.getState().needsReviewQueue.find((item) => item.cleanCode === "3220017209")!;
      store.getState().updateSettings({ aiLookupEnabled: true });

      await store.getState().liveDecode(review.id);

      const calls = (fetchSpy as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
      const call = calls.find(([url]) => url === "/api/ai-lookup");
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body).toMatchObject({
        mode: "decode",
        rawCode: "[redacted-phone]",
        cleanCode: "[redacted-phone]",
        exactScanCodeCandidate: "3220017209",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
