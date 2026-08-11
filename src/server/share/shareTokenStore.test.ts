import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

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

describe("shareTokenStore durable-write requirement in production", () => {
  const execute = vi.fn();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://example.turso.io");
    vi.stubEnv("TURSO_AUTH_TOKEN", "test-token");
    vi.stubEnv("SHARE_TOKEN_FILE", ":memory:");
    execute.mockReset().mockRejectedValue(new Error("turso unreachable"));
    createClient.mockReset().mockReturnValue({ execute });
    __resetShareTokenStoreForTests();
  });

  it("rejects (no token minted) when the Turso write fails in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const now = Date.now();
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: reportSnapshot(),
      createdAt: now,
      expiresAt: now + 60_000,
    };

    await expect(mintShareToken(payload, 60_000)).rejects.toThrow();
    expect(__getShareTokenStoreBackendForTests()).not.toBe("file");
    expect(__getShareTokenStoreBackendForTests()).not.toBe("memory");
  });

  it("still returns a token via the file/memory fallback when NODE_ENV is not production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const now = Date.now();
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: reportSnapshot(),
      createdAt: now,
      expiresAt: now + 60_000,
    };

    const token = await mintShareToken(payload, 60_000);

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const resolved = await resolveShareToken(token);
    expect(resolved).toEqual(payload);
  });
});

// M1 (resilience nit, not a fail-loud behavior change): the Turso client is module-memoized and was
// only marked "unavailable" when CONSTRUCTION fails, not when a subsequent durable WRITE (execute)
// fails - so once Turso goes bad mid-session, the same dead client instance kept being reused and
// re-failing on every request instead of being retried fresh. This suite proves the memoized client
// is invalidated after a write failure (next call re-attempts construction), while confirming F6's
// prod-throw / dev-fallback outcomes are unchanged (covered by the two suites above, which must stay
// green after this fix).
describe("shareTokenStore client resilience after a write failure (M1)", () => {
  const execute = vi.fn();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://example.turso.io");
    vi.stubEnv("TURSO_AUTH_TOKEN", "test-token");
    vi.stubEnv("SHARE_TOKEN_FILE", ":memory:");
    vi.stubEnv("NODE_ENV", "test"); // dev/test fallback path so the write failure doesn't throw
    execute.mockReset();
    createClient.mockReset();
    __resetShareTokenStoreForTests();
  });

  it("re-attempts client construction on the next call after a durable write failure, instead of reusing the dead client", async () => {
    // First call: construction succeeds, DDL (ensureTable) succeeds, but the INSERT write fails.
    execute.mockImplementationOnce(async () => ({ rows: [] })); // DDL
    execute.mockImplementationOnce(async () => { throw new Error("turso unreachable"); }); // INSERT
    createClient.mockReturnValueOnce({ execute });

    const now = Date.now();
    const payload = {
      businessId: "b1",
      sessionId: "s1",
      reportSnapshot: reportSnapshot(),
      createdAt: now,
      expiresAt: now + 60_000,
    };

    await mintShareToken(payload, 60_000);
    expect(createClient).toHaveBeenCalledTimes(1);
    // Falls back to file/memory since NODE_ENV is not production - proves the call still succeeded.
    expect(__getShareTokenStoreBackendForTests()).toBe("memory");

    // Second call: construction succeeds again and this time DDL + write both succeed. If the
    // memoized client from the first call were reused instead of reset, createClient would NOT be
    // called again here (it would stay at 1), and this call would still hit the failing execute mock.
    execute.mockImplementationOnce(async () => ({ rows: [] })); // DDL (tableReady was reset too)
    execute.mockImplementationOnce(async () => ({ rows: [] })); // INSERT
    createClient.mockReturnValueOnce({ execute });

    await mintShareToken(payload, 60_000);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(__getShareTokenStoreBackendForTests()).toBe("turso");
  });
});

describe("shareTokenStore failure logging privacy", () => {
  const secret =
    "libsql://private-db.turso.io authToken=TOP_SECRET SQL=SELECT_SECRET row=customer-secret";
  const now = Date.now();
  const payload = {
    businessId: "b-private",
    sessionId: "s-private",
    reportSnapshot: reportSnapshot(),
    createdAt: now,
    expiresAt: now + 60_000,
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://private-db.turso.io");
    vi.stubEnv("TURSO_AUTH_TOKEN", "TOP_SECRET");
    vi.stubEnv("SHARE_TOKEN_FILE", ":memory:");
    createClient.mockReset();
    __resetShareTokenStoreForTests();
  });

  it("never logs Turso URLs, tokens, driver messages, SQL, rows, or local paths", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Client construction.
    createClient.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    await mintShareToken(payload, 60_000);

    // DDL/table setup.
    __resetShareTokenStoreForTests();
    createClient.mockReturnValueOnce({ execute: vi.fn().mockRejectedValue(new Error(secret)) });
    await mintShareToken(payload, 60_000);

    // Insert after successful DDL.
    __resetShareTokenStoreForTests();
    const insertExecute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error(secret));
    createClient.mockReturnValueOnce({ execute: insertExecute });
    await mintShareToken(payload, 60_000);

    // Read after successful DDL + insert.
    __resetShareTokenStoreForTests();
    const readExecute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error(secret));
    createClient.mockReturnValueOnce({ execute: readExecute });
    const token = await mintShareToken(payload, 60_000);
    await resolveShareToken(token);

    // Local file fallback errors can contain absolute user paths, so they must be fixed markers too.
    __resetShareTokenStoreForTests();
    vi.stubEnv("TURSO_DATABASE_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHARE_TOKEN_FILE", "C:\\private\\customer-secret.json");
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error(`EPERM ${secret} C:\\private\\customer-secret.json`);
    });
    await mintShareToken(payload, 60_000);
    write.mockRestore();

    const output = warn.mock.calls.flat().join(" ");
    expect(output).not.toContain("private-db.turso.io");
    expect(output).not.toContain("TOP_SECRET");
    expect(output).not.toContain("SELECT_SECRET");
    expect(output).not.toContain("customer-secret");
    expect(output).not.toContain("EPERM");
    warn.mockRestore();
  });
});
