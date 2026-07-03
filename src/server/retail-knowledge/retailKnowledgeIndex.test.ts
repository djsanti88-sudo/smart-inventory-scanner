import { describe, it, expect, beforeEach, vi } from "vitest";

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
