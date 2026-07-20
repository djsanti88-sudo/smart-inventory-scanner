import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());

vi.mock("@libsql/client", () => ({ createClient }));

import {
  __getShareTokenStoreBackendForTests,
  __resetShareTokenStoreForTests,
  mintShareToken,
  resolveShareToken,
} from "@/server/share/shareTokenStore";
import type { BossReportData } from "@/services/reports/bossReport";

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

describe("shareTokenStore fallback path", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TURSO_DATABASE_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubEnv("SHARE_TOKEN_FILE", ":memory:");
    createClient.mockReset();
    __resetShareTokenStoreForTests();
  });

  it("uses the in-memory fallback without constructing a Turso client", async () => {
    const now = Date.now();
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: reportSnapshot(),
      createdAt: now,
      expiresAt: now + 60_000,
    };

    const token = await mintShareToken(payload, 60_000);
    const resolved = await resolveShareToken(token);

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolved).toEqual(payload);
    expect(__getShareTokenStoreBackendForTests()).toBe("memory");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token", async () => {
    await expect(resolveShareToken("nonexistent-token-xyz")).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null for an expired token", async () => {
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: reportSnapshot(),
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    };

    const token = await mintShareToken(payload, -60_000);

    await expect(resolveShareToken(token)).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
