import { describe, it, expect } from "vitest";
import { buildReconcileReport, reconcileReportCsv } from "@/services/reconcile/reconcileReport";
import type { MatchResult } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

// SDD Task 6: reconcile report service (Phase 3 core). Consumes MatchResult (Task 5) + AdapterResult
// (Task 4) and produces the bucketed ReconcileReport (AM-R7). The scope boundary (AM-R8) is the
// core behavior under test: a matched row NOT counted this session must land in
// `expected_not_counted`, NEVER `variance` (AM-R10b) - a partial count must not flood variance with
// the whole uncounted catalog.

function row(overrides: Partial<ExpectedInventoryRow> = {}): ExpectedInventoryRow {
  return {
    externalId: overrides.externalId ?? "ext-1",
    partNumbers: overrides.partNumbers ?? ["PN-1"],
    brand: overrides.brand,
    model: overrides.model,
    sizeText: overrides.sizeText,
    specs: overrides.specs,
    qty: overrides.qty ?? 10,
    raw: overrides.raw ?? {},
  };
}

function matched(uid: string, overrides: Partial<ExpectedInventoryRow> = {}, reason = "matched"): MatchResult {
  return {
    row: row(overrides),
    status: "matched",
    reason,
    candidate: { uid, brand: "Michelin", name: "Defender", sizeToken: "225/45R17" },
  };
}

function ambiguous(overrides: Partial<ExpectedInventoryRow> = {}): MatchResult {
  return {
    row: row(overrides),
    status: "ambiguous",
    reason: "Part number matches 2 different corpus products; cannot pick one safely.",
    candidates: [
      { uid: "c1", brand: "Michelin", name: "Defender", sizeToken: "225/45R17" },
      { uid: "c2", brand: "Goodyear", name: "Assurance", sizeToken: "225/45R17" },
    ],
  };
}

function unmatched(overrides: Partial<ExpectedInventoryRow> = {}): MatchResult {
  return {
    row: row(overrides),
    status: "unmatched",
    reason: "No part-number hit and no identity match found in the corpus for this row.",
  };
}

function nonTire(overrides: Partial<ExpectedInventoryRow> = {}): MatchResult {
  return {
    row: row(overrides),
    status: "non_tire",
    reason: "No parseable tire size and no tire signals found on this row; not treated as a tire product.",
  };
}

describe("buildReconcileReport", () => {
  it("counted matched row with delta -> variance with correct delta", () => {
    const m = matched("uid-1", { qty: 10 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: { "uid-1": 7 },
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({
      bucket: "variance",
      expectedQty: 10,
      countedQty: 7,
      delta: -3,
    });
    expect(report.lines[0].reason).toMatch(/counted 7.*expected 10|expected 10.*counted 7/i);
  });

  it("counted matched row, delta 0 -> agreement", () => {
    const m = matched("uid-2", { qty: 5 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: { "uid-2": 5 },
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].bucket).toBe("agreement");
    expect(report.lines[0].delta).toBe(0);
  });

  it("UNCOUNTED matched row -> expected_not_counted, never variance (AM-R10b)", () => {
    const m = matched("uid-3", { qty: 20 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {}, // nothing counted this session
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].bucket).toBe("expected_not_counted");
    expect(report.lines[0].bucket).not.toBe("variance");
    expect(report.lines[0].reason).toMatch(/not counted in this session/i);
    // countedQty must not be silently coerced into a false "0 counted" variance-looking shape.
    expect(report.lines[0].countedQty).toBeUndefined();
    expect(report.lines[0].delta).toBeUndefined();
  });

  it("a large uncounted catalog does not flood variance (scope boundary sanity)", () => {
    const matches: MatchResult[] = Array.from({ length: 50 }, (_, i) => matched(`uid-bulk-${i}`, { qty: 3 }));
    const report = buildReconcileReport({
      matches,
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {},
    });
    expect(report.totals.variance).toBe(0);
    expect(report.totals.expected_not_counted).toBe(50);
  });

  it("two matches sharing a uid merge, never throw (AM-R10c)", () => {
    const m1 = matched("uid-shared", { externalId: "ext-a", partNumbers: ["PN-A"], qty: 4 });
    const m2 = matched("uid-shared", { externalId: "ext-b", partNumbers: ["PN-B"], qty: 6 });
    let report: ReturnType<typeof buildReconcileReport> | undefined;
    expect(() => {
      report = buildReconcileReport({
        matches: [m1, m2],
        adapter: { uomReview: [], unparseable: [], assumptions: [] },
        countedByUid: { "uid-shared": 10 },
      });
    }).not.toThrow();
    expect(report!.lines).toHaveLength(1);
    // Summed expected qty: 4 + 6 = 10; counted 10 -> agreement.
    expect(report!.lines[0].expectedQty).toBe(10);
    expect(report!.lines[0].bucket).toBe("agreement");
    expect(report!.lines[0].partNumbers).toEqual(expect.arrayContaining(["PN-A", "PN-B"]));
    expect(report!.lines[0].reason).toMatch(/merged|combined|multiple rows/i);
  });

  it("ambiguous/unmatched/non_tire pass through to their buckets with reasons", () => {
    const a = ambiguous();
    const u = unmatched();
    const n = nonTire();
    const report = buildReconcileReport({
      matches: [a, u, n],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {},
    });
    const byBucket = Object.fromEntries(report.lines.map((l) => [l.bucket, l]));
    expect(byBucket.ambiguous).toBeDefined();
    expect(byBucket.ambiguous.reason).toBe(a.reason);
    expect(byBucket.unmatched).toBeDefined();
    expect(byBucket.unmatched.reason).toBe(u.reason);
    expect(byBucket.non_tire).toBeDefined();
    expect(byBucket.non_tire.reason).toBe(n.reason);
  });

  it("uomReview and unparseable adapter rows pass through with reasons", () => {
    const uomRow = row({ externalId: "uom-1", partNumbers: ["PN-UOM"], raw: { uom: "case" } });
    const report = buildReconcileReport({
      matches: [],
      adapter: {
        uomReview: [uomRow],
        unparseable: [{ line: 4, reason: "Missing quantity column value." }],
        assumptions: [],
      },
      countedByUid: {},
    });
    const byBucket = Object.fromEntries(report.lines.map((l) => [l.bucket, l]));
    expect(byBucket.uom_review).toBeDefined();
    expect(byBucket.uom_review.partNumbers).toEqual(["PN-UOM"]);
    expect(byBucket.uom_review.reason).toMatch(/uom|unit/i);
    expect(byBucket.unparseable).toBeDefined();
    expect(byBucket.unparseable.reason).toMatch(/line 4/i);
    expect(byBucket.unparseable.reason).toMatch(/missing quantity/i);
  });

  it("totals count every line exactly once across all buckets", () => {
    const matches: MatchResult[] = [
      matched("uid-a", { qty: 10 }),
      matched("uid-b", { qty: 5 }),
      ambiguous(),
      unmatched(),
      nonTire(),
    ];
    const report = buildReconcileReport({
      matches,
      adapter: {
        uomReview: [row({ externalId: "uom-x", partNumbers: ["PN-UOM-X"] })],
        unparseable: [{ line: 2, reason: "Bad row." }],
        assumptions: [],
      },
      countedByUid: { "uid-a": 10, "uid-b": 1 }, // agreement + variance
    });
    const totalFromBuckets = Object.values(report.totals).reduce((s, n) => s + n, 0);
    expect(totalFromBuckets).toBe(report.lines.length);
    expect(report.lines.length).toBe(7);
    // Every bucket key from the ReconcileBucket union must be present (even if 0), so a caller can
    // always render every column without a defensive `?? 0`.
    const expectedBuckets = [
      "variance",
      "agreement",
      "expected_not_counted",
      "ambiguous",
      "unmatched",
      "non_tire",
      "uom_review",
      "unparseable",
    ];
    for (const b of expectedBuckets) {
      expect(report.totals).toHaveProperty(b);
    }
  });

  it("carries adapter assumptions through to the report", () => {
    const report = buildReconcileReport({
      matches: [],
      adapter: { uomReview: [], unparseable: [], assumptions: ['Quantities assumed unit "each" (no UOM column).'] },
      countedByUid: {},
    });
    expect(report.assumptions).toEqual(['Quantities assumed unit "each" (no UOM column).']);
  });

  it("matched row with a corpus uid equal to an inherited Object.prototype property name (e.g. \"constructor\") and an EMPTY countedByUid -> expected_not_counted, never variance with NaN delta (review finding, AM-R8 path)", () => {
    const m = matched("constructor", { qty: 9 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {}, // no own key "constructor" - naive countedByUid[uid] would read the inherited function
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].bucket).toBe("expected_not_counted");
    expect(report.lines[0].bucket).not.toBe("variance");
    expect(report.lines[0].countedQty).toBeUndefined();
    expect(report.lines[0].delta).toBeUndefined();
    expect(Number.isNaN(report.lines[0].delta as unknown as number)).toBe(false);
  });

  it("matched row with corpus uid \"toString\" and an explicit countedByUid entry of 0 still lands in variance (0-vs-undefined semantics preserved)", () => {
    const m = matched("toString", { qty: 4 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: { toString: 0 }, // counted zero IS counted, not "absent"
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].bucket).toBe("variance");
    expect(report.lines[0].countedQty).toBe(0);
    expect(report.lines[0].delta).toBe(-4);
  });

  it("never presents raw.location as a complete location list (carry-forward from Task 4 review)", () => {
    // qty on ExpectedInventoryRow is authoritative; raw.location only holds the LAST aggregated
    // row's location, so a reason string must not claim it is the complete location list.
    const m = matched("uid-loc", { qty: 3, raw: { location: "Bay 3" } });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {},
    });
    expect(report.lines[0].reason.toLowerCase()).not.toMatch(/all location|complete location|every location/);
  });
});

describe("reconcileReportCsv", () => {
  it("renders an empty report (0 lines) without throwing", () => {
    const report = buildReconcileReport({
      matches: [],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {},
    });
    const csv = reconcileReportCsv(report);
    expect(csv).toContain("bucket");
    expect(csv).toContain("reason");
    // Header line only (plus BOM prefix from buildCsv).
    const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("escapes commas and quotes in reason/part number fields (reuses buildCsv)", () => {
    const m: MatchResult = {
      row: row({ partNumbers: ['PN,1', 'PN"2'], qty: 1 }),
      status: "ambiguous",
      reason: 'Reason with a comma, and a "quote" inside.',
    };
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: {},
    });
    const csv = reconcileReportCsv(report);
    expect(csv).toContain('"Reason with a comma, and a ""quote"" inside."');
    expect(csv).toMatch(/"PN,1.*PN""2"|"PN""2.*PN,1"/);
  });

  it("includes bucket and reason columns for a populated report", () => {
    const m = matched("uid-csv", { qty: 8 });
    const report = buildReconcileReport({
      matches: [m],
      adapter: { uomReview: [], unparseable: [], assumptions: [] },
      countedByUid: { "uid-csv": 8 },
    });
    const csv = reconcileReportCsv(report);
    const [header, ...rows] = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(header.split(",")).toEqual(expect.arrayContaining(["bucket", "reason"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("agreement");
  });
});
