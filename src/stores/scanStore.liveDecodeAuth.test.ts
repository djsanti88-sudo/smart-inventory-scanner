import { describe, it, expect, vi, beforeEach } from "vitest";

// D4-follow-up (owner-confirmed live prod bug 2026-07-25/26): route.ts's live-auth gate
// (src/app/api/ai-lookup/route.ts:294-324) requires body.idToken + body.businessId whenever
// isLiveAuth() && !e2eMode(); a missing/empty idToken 401s "unauthenticated". scanStore's decode
// POST call sites never attached them (grep-confirmed: "idToken" never appeared in a scanStore POST
// body pre-fix), so every live-auth decode 401'd. This test proves liveDecode's POST body now
// carries idToken + businessId when a user + selected business are present, via the shared
// authFieldsForDecode() helper (src/lib/decodeAuth.ts) - the SAME mechanism the already-working
// report/settings/import call sites use (isLiveAuth() + getSession().getIdToken() +
// getSelectedBusinessId()).

const mocks = vi.hoisted(() => ({
  isLiveAuth: vi.fn(),
  getSession: vi.fn(),
  getSelectedBusinessId: vi.fn(),
}));

vi.mock("@/services/auth/authMode", () => ({
  isLiveAuth: () => mocks.isLiveAuth(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: () => mocks.getSession(),
}));

vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => mocks.getSelectedBusinessId(),
}));

import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function aiOnStore() {
  return createTestScanStore({ db: new MockDb() });
}

function openReview(store: ReturnType<typeof aiOnStore>, code: string) {
  store.getState().processScan(code); // AI is off by default -> passive review, no auto-trigger
  store.getState().updateSettings({ aiLookupEnabled: true }); // enable AFTER the scan so we control the fetch below
  return store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open")!;
}

function okDecodeResponse() {
  return new Response(
    JSON.stringify({
      providerNames: ["mock"],
      results: [],
      decision: {
        status: "needs_review",
        confidence: 0,
        evidenceStrength: "none",
        exactCodeEvidenceVerifiedByApp: false,
        reason: "",
        crossCheck: {
          decision: "single_provider",
          confidence: 0,
          reason: "",
          brandSimilarity: 0,
          nameSimilarity: 0,
          contradictions: [],
        },
      },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  mocks.isLiveAuth.mockReset().mockReturnValue(false);
  mocks.getSession.mockReset();
  mocks.getSelectedBusinessId.mockReset().mockReturnValue(null);
});

describe("liveDecode attaches live-auth fields to the POST body (D4-follow-up)", () => {
  it("sends idToken + businessId when signed in with a selected business in live-auth mode", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    const getIdToken = vi.fn().mockResolvedValue("token-abc");
    mocks.getSession.mockResolvedValue({ getIdToken });
    mocks.getSelectedBusinessId.mockReturnValue("biz-123");

    const store = aiOnStore();
    const review = openReview(store, "086699998550");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okDecodeResponse());
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/ai-lookup"));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.idToken).toBe("token-abc");
    expect(body.businessId).toBe("biz-123");
  });

  it("omits idToken/businessId in mock mode (isLiveAuth false) - unaffected today's open-demo behavior", async () => {
    mocks.isLiveAuth.mockReturnValue(false);

    const store = aiOnStore();
    const review = openReview(store, "086699998551");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okDecodeResponse());
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await store.getState().liveDecode(review.id);
    } finally {
      globalThis.fetch = original;
    }

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/ai-lookup"));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.idToken).toBeUndefined();
    expect(body.businessId).toBeUndefined();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
