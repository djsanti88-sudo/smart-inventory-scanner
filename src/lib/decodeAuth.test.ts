import { describe, it, expect, vi, beforeEach } from "vitest";

// D4-follow-up (owner-confirmed live prod bug 2026-07-25/26): route.ts's live-auth gate
// (src/app/api/ai-lookup/route.ts:294-324) requires body.idToken + body.businessId whenever
// isLiveAuth() && !e2eMode(), but scanStore's five POST call sites never attached them, so every
// live-auth decode 401'd with reasonCode "unauthenticated". authFieldsForDecode() is the shared
// helper every call site now spreads into its POST body - it must resolve the same way the
// existing report/settings/import call sites do (isLiveAuth() gate + user.getIdToken() +
// getSelectedBusinessId()), and it must NEVER throw (mock mode / logged-out must degrade to {}).

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

import { authFieldsForDecode } from "@/lib/decodeAuth";

beforeEach(() => {
  mocks.isLiveAuth.mockReset().mockReturnValue(false);
  mocks.getSession.mockReset();
  mocks.getSelectedBusinessId.mockReset().mockReturnValue(null);
});

describe("authFieldsForDecode", () => {
  it("returns {} in mock mode (isLiveAuth false), never calling getSession", async () => {
    mocks.isLiveAuth.mockReturnValue(false);
    const result = await authFieldsForDecode();
    expect(result).toEqual({});
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("returns idToken + businessId when live-auth + signed in + a business is selected", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    const getIdToken = vi.fn().mockResolvedValue("token-abc");
    mocks.getSession.mockResolvedValue({ getIdToken });
    mocks.getSelectedBusinessId.mockReturnValue("biz-123");

    const result = await authFieldsForDecode();

    expect(result).toEqual({ idToken: "token-abc", businessId: "biz-123" });
  });

  it("omits businessId when none is selected (idToken still present)", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    const getIdToken = vi.fn().mockResolvedValue("token-abc");
    mocks.getSession.mockResolvedValue({ getIdToken });
    mocks.getSelectedBusinessId.mockReturnValue(null);

    const result = await authFieldsForDecode();

    expect(result).toEqual({ idToken: "token-abc" });
  });

  it("returns {} when live-auth but logged out (no user)", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    mocks.getSession.mockResolvedValue(null);
    mocks.getSelectedBusinessId.mockReturnValue("biz-123");

    const result = await authFieldsForDecode();

    expect(result).toEqual({});
  });

  it("never throws: a getSession rejection degrades to {}", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    mocks.getSession.mockRejectedValue(new Error("network down"));
    mocks.getSelectedBusinessId.mockReturnValue("biz-123");

    await expect(authFieldsForDecode()).resolves.toEqual({});
  });

  it("never throws: a getIdToken rejection degrades to {}", async () => {
    mocks.isLiveAuth.mockReturnValue(true);
    const getIdToken = vi.fn().mockRejectedValue(new Error("token refresh failed"));
    mocks.getSession.mockResolvedValue({ getIdToken });
    mocks.getSelectedBusinessId.mockReturnValue("biz-123");

    await expect(authFieldsForDecode()).resolves.toEqual({});
  });
});
