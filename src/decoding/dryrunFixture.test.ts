import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rows = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/dryrun-codes.json"), "utf8")).codes as Array<{
  code: string; codeType: string; truth: string; expected: string; source: string; group: string;
}>;

const GROUPS: Record<string, number> = { owner: 21, canary: 10, tire: 20, part: 25, asin: 8, fnsku: 7, upcEan: 35, case: 12, obscure: 12 };

describe("dryrun fixture", () => {
  it("has exactly 150 rows in the agreed group sizes", () => {
    expect(rows.length).toBe(150);
    for (const [g, n] of Object.entries(GROUPS)) {
      expect(rows.filter((r) => r.group === g).length, `group ${g}`).toBe(n);
    }
  });
  it("has no duplicate codes", () => expect(new Set(rows.map((r) => r.code)).size).toBe(150));
  it("every row has code, truth, source and a legal expected value", () => {
    for (const r of rows) {
      expect(r.code.trim().length).toBeGreaterThan(3);
      expect(r.truth.trim().length).toBeGreaterThan(3);
      expect(r.source.trim().length).toBeGreaterThan(2);
      expect(["verified-ok", "suggest-only", "must-refuse"]).toContain(r.expected);
    }
  });
  it("all canaries must-refuse; all FNSKU/part suggest-only; all ASIN verified-ok", () => {
    expect(rows.filter((r) => r.group === "canary").every((r) => r.expected === "must-refuse")).toBe(true);
    expect(rows.filter((r) => r.group === "fnsku" || r.group === "part").every((r) => r.expected === "suggest-only")).toBe(true);
    expect(rows.filter((r) => r.group === "asin").every((r) => r.expected === "verified-ok")).toBe(true);
  });
});
