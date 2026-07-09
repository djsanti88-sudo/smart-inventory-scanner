// Discount Tire harvest: Task 8 Step 1 - weekly top-up pure logic tests.
// No I/O, no Playwright, no network, no child_process - safe to unit test directly.

import { describe, it, expect } from "vitest";
import { newUrls, buildWeeklyReport, parseApplyOutput } from "./weekly.mjs";

describe("newUrls", () => {
  it("returns urls present in freshUrls but not in any doneMap (set difference over merged done maps)", () => {
    const fresh = ["u0", "u1", "u2", "u3"];
    const doneMaps = [{ u0: true }, { u1: true }];
    expect(newUrls(fresh, doneMaps)).toEqual(["u2", "u3"]);
  });

  it("returns empty array when every fresh url is already done across the merged maps", () => {
    const fresh = ["u0", "u1"];
    const doneMaps = [{ u0: true }, { u1: true }];
    expect(newUrls(fresh, doneMaps)).toEqual([]);
  });

  it("returns all fresh urls when doneMaps is empty", () => {
    const fresh = ["u0", "u1"];
    expect(newUrls(fresh, [])).toEqual(["u0", "u1"]);
  });

  it("treats missing/undefined doneMaps as empty (no urls done)", () => {
    const fresh = ["u0", "u1"];
    expect(newUrls(fresh, undefined)).toEqual(["u0", "u1"]);
  });

  it("returns empty array for an empty freshUrls list", () => {
    expect(newUrls([], [{ u0: true }])).toEqual([]);
  });

  it("preserves freshUrls order and does not de-duplicate freshUrls itself", () => {
    const fresh = ["u3", "u1", "u3", "u0"];
    const doneMaps = [{ u0: true }];
    expect(newUrls(fresh, doneMaps)).toEqual(["u3", "u1", "u3"]);
  });

  it("merges across many done maps (union of done keys)", () => {
    const fresh = ["u0", "u1", "u2", "u3", "u4"];
    const doneMaps = [{ u0: true }, { u1: true }, { u2: true }, {}];
    expect(newUrls(fresh, doneMaps)).toEqual(["u3", "u4"]);
  });

  it("ignores falsy values in a done map (only truthy marks done)", () => {
    const fresh = ["u0", "u1"];
    const doneMaps = [{ u0: false }];
    expect(newUrls(fresh, doneMaps)).toEqual(["u0", "u1"]);
  });
});

describe("buildWeeklyReport", () => {
  const baseInputs = {
    date: "2026-07-08",
    newUrlCount: 42,
    batch: { ok: 90, blocked: 3, error: 7, rows: 80, guardRejected: 10, blockRate: 0.033 },
    applyRan: true,
    applyResult: { added: 75, skipped: 5, spotCheck: { passed: 20, failed: 0 } },
    hardStopFired: false,
  };

  it("returns markdown containing new urls, fetched, ok/blocked/error, rows added/skipped, and block rate", () => {
    const { markdown } = buildWeeklyReport(baseInputs);
    expect(markdown).toContain("42");
    expect(markdown).toContain("90");
    expect(markdown).toContain("blocked");
    expect(markdown).toContain("error");
    expect(markdown).toContain("75");
    expect(markdown).toContain("5");
    expect(markdown).toContain("3.3%");
  });

  it("has no anomalies when block rate, error rate, spot-check, and hard stop are all clean", () => {
    const { anomalies } = buildWeeklyReport(baseInputs);
    expect(anomalies).toBe(false);
  });

  it("flags anomalies when block rate > 5%", () => {
    const inputs = { ...baseInputs, batch: { ...baseInputs.batch, blockRate: 0.06 } };
    const { anomalies, markdown } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(true);
    expect(markdown.toLowerCase()).toContain("block rate");
  });

  it("does not flag anomalies at exactly 5% block rate (boundary is > 5%, not >=)", () => {
    const inputs = { ...baseInputs, batch: { ...baseInputs.batch, blockRate: 0.05 } };
    const { anomalies } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(false);
  });

  it("flags anomalies when error rate > 10% of pages processed", () => {
    // 15 errors of 100 processed (ok+blocked+error) = 15%
    const inputs = { ...baseInputs, batch: { ok: 80, blocked: 5, error: 15, rows: 70, guardRejected: 10, blockRate: 0.05 } };
    const { anomalies, markdown } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(true);
    expect(markdown.toLowerCase()).toContain("error");
  });

  it("does not flag anomalies at exactly 10% error rate (boundary is > 10%, not >=)", () => {
    const inputs = { ...baseInputs, batch: { ok: 85, blocked: 5, error: 10, rows: 70, guardRejected: 10, blockRate: 0.05 } };
    const { anomalies } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(false);
  });

  it("flags anomalies when apply spot-check has any failure", () => {
    const inputs = {
      ...baseInputs,
      applyResult: { added: 75, skipped: 5, spotCheck: { passed: 18, failed: 2 } },
    };
    const { anomalies, markdown } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(true);
    expect(markdown.toLowerCase()).toContain("spot-check");
  });

  it("flags anomalies when the hard stop fired", () => {
    const inputs = { ...baseInputs, hardStopFired: true };
    const { anomalies, markdown } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(true);
    expect(markdown.toLowerCase()).toContain("hard stop");
  });

  it("handles a zero-new-urls run (no batch/apply) without throwing and reports no anomalies", () => {
    const inputs = {
      date: "2026-07-08",
      newUrlCount: 0,
      batch: null,
      applyRan: false,
      applyResult: null,
      hardStopFired: false,
    };
    const { markdown, anomalies } = buildWeeklyReport(inputs);
    expect(anomalies).toBe(false);
    expect(markdown).toContain("0");
    expect(markdown.toLowerCase()).toContain("skip");
  });

  it("notes apply was skipped when applyRan is false but there were pages fetched (e.g. 0 rows produced)", () => {
    const inputs = {
      ...baseInputs,
      batch: { ok: 50, blocked: 0, error: 0, rows: 0, guardRejected: 50, blockRate: 0 },
      applyRan: false,
      applyResult: null,
    };
    const { markdown, anomalies } = buildWeeklyReport(inputs);
    expect(markdown.toLowerCase()).toContain("skip");
    expect(anomalies).toBe(false);
  });

  it("includes an anomalies section header even when empty, for a stable haiku-parseable format", () => {
    const { markdown } = buildWeeklyReport(baseInputs);
    expect(markdown.toLowerCase()).toContain("anomal");
  });
});

describe("parseApplyOutput", () => {
  const realisticStdout = `[dt-harvest apply] Reading 3 harvest file(s):
  state/harvested-weekly.jsonl
[dt-harvest apply] 80 guard-ok row(s) with a gtin after batch dedupe.

[dt-harvest apply] Merge report
  Added:   75
  Skipped: 5
  Skip reasons:
    cross_source_duplicate     3
    less_complete_duplicate    2

[dt-harvest apply] Backed up corpus to: /path/tireKnowledge.generated.json.bak-2026-07-08

[dt-harvest apply] Corpus size: 1000 -> 1075 (+75)

[dt-harvest apply] Running: npm run build:knowledge-db

[dt-harvest apply] Spot-checking 20 random newly-added barcodes against the rebuilt DB...
  PASS  0123456789012  expected brand="michelin" got="michelin"

[dt-harvest apply] Spot-check summary: 20 PASS, 0 FAIL

[dt-harvest apply] Done.
`;

  it("parses added, skipped, and spot-check counts from apply.mjs's real stdout format", () => {
    const result = parseApplyOutput(realisticStdout);
    expect(result).toEqual({ added: 75, skipped: 5, spotCheck: { passed: 20, failed: 0 } });
  });

  it("parses a spot-check failure correctly", () => {
    const stdout = realisticStdout.replace("20 PASS, 0 FAIL", "18 PASS, 2 FAIL");
    const result = parseApplyOutput(stdout);
    expect(result.spotCheck).toEqual({ passed: 18, failed: 2 });
  });

  it("returns nulls (not zeros, not throws) when the expected lines are absent", () => {
    const result = parseApplyOutput("[dt-harvest apply] No harvest files found. Nothing to do.");
    expect(result).toEqual({ added: null, skipped: null, spotCheck: null });
  });

  it("handles empty/undefined stdout without throwing", () => {
    expect(parseApplyOutput("")).toEqual({ added: null, skipped: null, spotCheck: null });
    expect(parseApplyOutput(undefined)).toEqual({ added: null, skipped: null, spotCheck: null });
  });

  it("handles the 'nothing to add' path (Added: 0, no spot-check line)", () => {
    const stdout = `[dt-harvest apply] Merge report\n  Added:   0\n  Skipped: 12\n\n[dt-harvest apply] Nothing to add; leaving the corpus and DB untouched.\n`;
    const result = parseApplyOutput(stdout);
    expect(result).toEqual({ added: 0, skipped: 12, spotCheck: null });
  });
});
