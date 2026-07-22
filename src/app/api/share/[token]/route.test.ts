import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveShareToken = vi.hoisted(() => vi.fn());

vi.mock("@/server/share/shareTokenStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/share/shareTokenStore")>();
  return {
    ...original,
    resolveShareToken: (...args: unknown[]) => resolveShareToken(...args),
  };
});

import { GET } from "@/app/api/share/[token]/route";

const TOKEN = "c2505732-9d5d-4e35-9344-755bf15f8198";

function request(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/share/${TOKEN}`);
}

beforeEach(() => {
  resolveShareToken.mockReset();
});

describe("GET /api/share/[token]", () => {
  it("returns only the immutable Boss Report safe snapshot", async () => {
    resolveShareToken.mockResolvedValue({
      businessId: "private-business-id",
      sessionId: "s1",
      reportSnapshot: {
        totalItems: 5,
        moat: { identified: 4, total: 5 },
        byBrand: [{ brand: "Acme", qty: 5, internalCost: 42 }],
        byCategory: [{ category: "Tools", qty: 5 }],
        totalValue: null,
        hasAnyCostData: false,
        topVariances: [],
        sessionName: "Weekly count",
        countedBy: "Owner",
        countedAt: "2026-07-20T12:00:00.000Z",
        customerEmail: "private@example.com",
        rawCodes: ["012345678905"],
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const response = await GET(request(), { params: Promise.resolve({ token: TOKEN }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(resolveShareToken).toHaveBeenCalledWith(TOKEN);
    expect(body).toEqual({
      sessionId: "s1",
      report: {
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
      },
    });
    expect(body).not.toHaveProperty("businessId");
    expect(body.report).not.toHaveProperty("customerEmail");
    expect(body.report).not.toHaveProperty("rawCodes");
  });

  it("returns 404 for an unknown or expired token", async () => {
    resolveShareToken.mockResolvedValue(null);

    const response = await GET(request(), { params: Promise.resolve({ token: TOKEN }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This link has expired or does not exist.",
    });
  });
});
