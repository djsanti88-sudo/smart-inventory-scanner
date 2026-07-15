import { describe, it, expect, beforeEach, vi } from "vitest";

// QA 2026-07-15 Task 5 - read-time garbage guard. A Turso mirror may still be dirty even after the
// local knowledge-DB rebuild, so retailKnowledgeIndex must FILTER a poisoned (run-on multi-brand /
// ingredient-blob) row rather than serve it as a trusted hit - otherwise it reaches the decode
// consensus path where evidence.verified is hand-set from the structured-DB vote.
//
// SQLite path is forced unavailable so the Turso path (which we control here) is exercised.
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => null, __resetKnowledgeDbForTests: () => {} }));

// Controllable Turso rows per test.
let tursoRows: Record<string, unknown>[] = [];
vi.mock("@libsql/client", () => ({
  createClient: () => ({ execute: async () => ({ rows: tursoRows }) }),
}));

describe("retail read-time garbage guard (Task 5 defense-in-depth)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TURSO_DATABASE_URL = "libsql://x";
    process.env.TURSO_AUTH_TOKEN = "t";
  });

  it("filters the live-poisoned 0123456789012 row (run-on multi-brand) - treated as a miss, not served", async () => {
    tursoRows = [
      {
        barcode: "0123456789012",
        product_name: "Peanut Butter Crunch",
        brand: "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti",
        category: "Dried fruits",
      },
    ];
    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("0123456789012");
    expect(res).toBeNull();
    expect(mod.getLastRetailLookupStatus()).toBe("turso_miss");
  });

  it("still serves a CLEAN row (guard does not over-block real corpus data)", async () => {
    tursoRows = [{ barcode: "049000028911", product_name: "Diet Coke", brand: "Coca-Cola", category: "Sodas" }];
    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000028911");
    expect(res).not.toBeNull();
    expect(res?.productName).toBe("Diet Coke");
    expect(mod.getLastRetailLookupStatus()).toBe("turso_hit");
  });

  it("skips a garbled row and returns a clean sibling variant if present", async () => {
    tursoRows = [
      { barcode: "0123456789012", product_name: "Junk", brand: "A, B, C, D, E", category: "" },
      { barcode: "049000028911", product_name: "Diet Coke", brand: "Coca-Cola", category: "Sodas" },
    ];
    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000028911");
    expect(res?.productName).toBe("Diet Coke");
    expect(mod.getLastRetailLookupStatus()).toBe("turso_hit");
  });
});
