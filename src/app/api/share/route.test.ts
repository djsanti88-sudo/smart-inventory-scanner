import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BossReportData } from "@/reports/variance/bossReport";

const mocks = vi.hoisted(() => ({
  mintShareToken: vi.fn(),
  verifyIdToken: vi.fn(),
  memberGet: vi.fn(),
}));

vi.mock("@/server/share/shareTokenStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/share/shareTokenStore")>();
  return {
    ...original,
    mintShareToken: (...args: unknown[]) => mocks.mintShareToken(...args),
  };
});

vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdminDb: () => ({ doc: () => ({ get: mocks.memberGet }) }),
}));

import { POST } from "@/app/api/share/route";

const TOKEN = "c2505732-9d5d-4e35-9344-755bf15f8198";

function reportSnapshot(overrides: Partial<BossReportData> = {}): BossReportData {
  return {
    totalItems: 5,
    moat: { identified: 4, total: 5 },
    byBrand: [{ brand: "Acme", qty: 5 }],
    byCategory: [{ category: "Tools", qty: 5 }],
    totalValue: null,
    hasAnyCostData: false,
    topVariances: [],
    sessionName: "Weekly count",
    countedBy: "Owner",
    countedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

function shareRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
  vi.stubEnv("IS_E2E", "");
  mocks.mintShareToken.mockReset().mockResolvedValue(TOKEN);
  mocks.verifyIdToken.mockReset().mockResolvedValue({ uid: "u1" });
  mocks.memberGet.mockReset().mockResolvedValue({ exists: true });
});

describe("POST /api/share authentication", () => {
  it("rejects live-mode minting without an ID token", async () => {
    const response = await POST(
      shareRequest({ businessId: "b1", sessionId: "s1", reportSnapshot: reportSnapshot() }),
    );

    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
    expect(mocks.mintShareToken).not.toHaveBeenCalled();
  });

  it("verifies the ID token and business membership before minting in live mode", async () => {
    const response = await POST(
      shareRequest({
        businessId: "b1",
        sessionId: "s1",
        idToken: "firebase-token",
        reportSnapshot: reportSnapshot(),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith("firebase-token");
    expect(mocks.memberGet).toHaveBeenCalledOnce();
    expect(mocks.mintShareToken).toHaveBeenCalledOnce();
  });

  it("does not mint when the verified caller is not a business member", async () => {
    mocks.memberGet.mockResolvedValue({ exists: false });

    const response = await POST(
      shareRequest({
        businessId: "b1",
        sessionId: "s1",
        idToken: "firebase-token",
        reportSnapshot: reportSnapshot(),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.verifyIdToken).toHaveBeenCalledOnce();
    expect(mocks.mintShareToken).not.toHaveBeenCalled();
  });

  it.each([
    ["IS_E2E", "live", "1"],
    ["mock auth mode", "mock", ""],
  ])("uses the explicit %s bypass without calling Firebase Auth", async (_label, authMode, isE2e) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    vi.stubEnv("IS_E2E", isE2e);

    const response = await POST(
      shareRequest({ sessionId: "s1", reportSnapshot: reportSnapshot() }),
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
    expect(mocks.mintShareToken).toHaveBeenCalledOnce();
  });
});

describe("POST /api/share durable-storage failure", () => {
  it("responds 503 with no token/url when mintShareToken rejects", async () => {
    vi.stubEnv("IS_E2E", "1");
    mocks.mintShareToken.mockReset().mockRejectedValue(
      new Error("Durable share storage is unavailable"),
    );

    const response = await POST(
      shareRequest({ sessionId: "s1", reportSnapshot: reportSnapshot() }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("url");
  });
});

describe("POST /api/share request limits and safe snapshot shape", () => {
  it.each([
    ["live", ""],
    ["live", "1"],
    ["mock", ""],
  ])("returns 413 for a body over 32KB in auth mode %s with IS_E2E=%s", async (authMode, isE2e) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    vi.stubEnv("IS_E2E", isE2e);

    const response = await POST(
      shareRequest({ sessionId: "s1", padding: "x".repeat(33 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    expect(mocks.memberGet).not.toHaveBeenCalled();
    expect(mocks.mintShareToken).not.toHaveBeenCalled();
  });

  it("projects the client snapshot onto Boss Report safe fields before minting", async () => {
    vi.stubEnv("IS_E2E", "1");
    const unsafeSnapshot = {
      ...reportSnapshot(),
      customerEmail: "private@example.com",
      rawCodes: ["012345678905"],
      byBrand: [{ brand: "Acme", qty: 5, internalCost: 42 }],
    };

    const response = await POST(
      shareRequest({ sessionId: "s1", reportSnapshot: unsafeSnapshot }),
    );

    expect(response.status).toBe(200);
    const storedPayload = mocks.mintShareToken.mock.calls[0][0] as {
      reportSnapshot: Record<string, unknown>;
    };
    expect(storedPayload.reportSnapshot).toEqual(reportSnapshot());
    expect(storedPayload.reportSnapshot).not.toHaveProperty("customerEmail");
    expect(storedPayload.reportSnapshot).not.toHaveProperty("rawCodes");
  });
});
