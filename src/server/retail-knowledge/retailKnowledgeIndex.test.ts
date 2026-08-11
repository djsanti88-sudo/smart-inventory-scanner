import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Force the SQLite path unavailable deterministically (mirrors the real Vercel case: no DB file
// in the bundle). A local dev machine may have a leftover knowledge.generated.db in %TEMP%
// (decompressed by a prior session, gitignored, not shipped to CI/Vercel) that would let
// getKnowledgeDb() succeed and short-circuit before this test ever reaches Turso.
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => null,
  __resetKnowledgeDbForTests: () => {},
}));

// Force the Turso client's query to throw, so lookupTurso's catch path runs.
vi.mock("@libsql/client", () => ({
  createClient: () => ({
    execute: async () => {
      throw new Error("auth failed");
    },
  }),
}));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.doUnmock("@libsql/client");
});

describe("retail Turso errors are distinguishable from misses", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TURSO_DATABASE_URL = "libsql://x";
    process.env.TURSO_AUTH_TOKEN = "t";
  });

  it("reports an error status when the Turso query throws", async () => {
    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000006346");
    expect(res).toBeNull();
    expect(mod.getLastRetailLookupStatus()).toBe("turso_error");
  });
});

describe("retail Turso logging does not disclose connection secrets", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not log Turso URL or token when the Turso client connects", async () => {
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async () => ({ rows: [] }),
      }),
    }));
    const sentinelUrl = "libsql://scanbin-prod-secret.turso.io?leak=retail-success";
    const sentinelToken = "retail-token-secret";
    process.env.TURSO_DATABASE_URL = sentinelUrl;
    process.env.TURSO_AUTH_TOKEN = sentinelToken;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    await mod.getTursoClient();

    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain(sentinelUrl);
    expect(output).not.toContain("scanbin-prod-secret.turso.io");
    expect(output).not.toContain("leak=retail-success");
    expect(output).not.toContain(sentinelToken);
  });

  it("does not log Turso URL or token when client construction fails", async () => {
    const sentinelUrl = "libsql://scanbin-prod-secret.turso.io?leak=retail-create";
    const sentinelToken = "retail-token-secret";
    vi.doMock("@libsql/client", () => ({
      createClient: () => {
        throw new Error(`failed for ${sentinelUrl} using ${sentinelToken}`);
      },
    }));
    process.env.TURSO_DATABASE_URL = sentinelUrl;
    process.env.TURSO_AUTH_TOKEN = sentinelToken;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    await mod.getTursoClient();

    const output = warn.mock.calls.flat().join(" ");
    expect(output).not.toContain(sentinelUrl);
    expect(output).not.toContain("scanbin-prod-secret.turso.io");
    expect(output).not.toContain("leak=retail-create");
    expect(output).not.toContain(sentinelToken);
    expect(output).not.toContain("failed for");
  });

  it("does not log Turso URL or token when a retail query fails", async () => {
    const sentinelUrl = "libsql://scanbin-prod-secret.turso.io?leak=retail-query";
    const sentinelToken = "retail-token-secret";
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async () => {
          throw new Error(`query failed for ${sentinelUrl} using ${sentinelToken}`);
        },
      }),
    }));
    process.env.TURSO_DATABASE_URL = sentinelUrl;
    process.env.TURSO_AUTH_TOKEN = sentinelToken;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000006346");

    expect(res).toBeNull();
    expect(mod.getLastRetailLookupStatus()).toBe("turso_error");
    const output = [...log.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(output).not.toContain(sentinelUrl);
    expect(output).not.toContain("scanbin-prod-secret.turso.io");
    expect(output).not.toContain("leak=retail-query");
    expect(output).not.toContain(sentinelToken);
    expect(output).not.toContain("query failed for");
  });
});

describe("retail example/test-row firewall (QA hardening fix #5, defense in depth)", () => {
  // The Turso store may still hold a poisoned example/test row (e.g. from before the build-script
  // filter shipped, or a store that has not been regenerated/purged yet). This guard must reject a
  // blocklisted code EVEN WHEN the row is genuinely present in the store, so lookupRetailBarcodeAsync
  // never hands back a fake product regardless of what data currently sits in Turso/SQLite.
  beforeEach(() => {
    vi.resetModules();
    process.env.TURSO_DATABASE_URL = "libsql://x";
    process.env.TURSO_AUTH_TOKEN = "t";
  });

  it("returns null for a blocklisted example code even when Turso genuinely has the row seeded", async () => {
    vi.doMock("@/server/knowledgeDb", () => ({
      getKnowledgeDb: () => null,
      __resetKnowledgeDbForTests: () => {},
    }));
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async () => ({
          rows: [{ barcode: "4006381333931", product_name: "Test Shopidoo", brand: "", category: "" }],
        }),
      }),
    }));

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("4006381333931");
    expect(res).toBeNull();
  });

  it("returns null for a Healthyholics example row even when seeded (brand-based marker)", async () => {
    vi.doMock("@/server/knowledgeDb", () => ({
      getKnowledgeDb: () => null,
      __resetKnowledgeDbForTests: () => {},
    }));
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async () => ({
          rows: [{ barcode: "0012345670121", product_name: "Multivitamin Gummies", brand: "Healthyholics", category: "Supplements" }],
        }),
      }),
    }));

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("0012345670121");
    expect(res).toBeNull();
  });

  it("still returns a genuine non-example row (guard does not over-block real products)", async () => {
    vi.doMock("@/server/knowledgeDb", () => ({
      getKnowledgeDb: () => null,
      __resetKnowledgeDbForTests: () => {},
    }));
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async () => ({
          rows: [{ barcode: "049000006346", product_name: "Coca-Cola Classic 12 pack", brand: "Coca-Cola", category: "Beverages" }],
        }),
      }),
    }));

    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000006346");
    expect(res).not.toBeNull();
    expect(res?.productName).toBe("Coca-Cola Classic 12 pack");
  });
});
