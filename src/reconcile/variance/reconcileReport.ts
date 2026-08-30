// reconcileReport.ts (reconcile Phase 3, Task 6) - the reconcile round's deliverable core. Consumes
// MatchResult (Task 5, identityMatcher.ts) and AdapterResult (Task 4, shopwareCsvAdapter.ts / types.ts)
// and produces a bucketed ReconcileReport a human can read or export. PURE: no React/next imports,
// no store/DB access - every input is already in memory.
//
// This is a NEW service, not an extension of computeVariance (AM-R7): the existing shrinkage report
// compares two identically-shaped CountSnapshots keyed by productId and throws on duplicates. A
// reconcile compares a counted session against an externally-sourced expected-inventory feed keyed
// by part number, carrying match statuses (matched/ambiguous/unmatched/non_tire) the 4-column
// shrinkage report cannot represent. `varianceReport.ts` and the shrinkage report stay untouched;
// this file only reuses `buildCsv` (the shared CSV escaping helper) from `csvExport.ts`.
//
// THE core behavior (AM-R8, review blocker B2): Shop-Ware exports the whole catalog but a count
// session only covers a few bins. A matched product NOT counted this session is NOT a variance -
// reporting it as shrinkage would scream "off by thousands" on every partial count, which is noise.
// It goes to `expected_not_counted` instead, with an honest "not counted in this session" reason.
// Variance rows exist ONLY for matched products that DO have a counted quantity this session.

import { buildCsv } from "@/reports/export/csvExport";
import type { MatchResult } from "@/reconcile/match/identityMatcher";
import type { AdapterResult, ExpectedInventoryRow } from "@/reconcile/types";

export type ReconcileBucket =
  | "variance"
  | "agreement"
  | "expected_not_counted"
  | "ambiguous"
  | "unmatched"
  | "non_tire"
  | "uom_review"
  | "unparseable";

export interface ReconcileLine {
  bucket: ReconcileBucket;
  partNumbers: string[];
  brand?: string;
  model?: string;
  sizeText?: string;
  expectedQty?: number;
  countedQty?: number;
  delta?: number;
  reason: string;
}

export interface ReconcileReport {
  lines: ReconcileLine[];
  totals: Record<ReconcileBucket, number>;
  assumptions: string[];
}

export interface BuildReconcileReportInput {
  matches: MatchResult[];
  adapter: Pick<AdapterResult, "uomReview" | "unparseable" | "assumptions">;
  /** productId/uid -> counted qty THIS session. */
  countedByUid: Record<string, number>;
}

const ALL_BUCKETS: ReconcileBucket[] = [
  "variance",
  "agreement",
  "expected_not_counted",
  "ambiguous",
  "unmatched",
  "non_tire",
  "uom_review",
  "unparseable",
];

function emptyTotals(): Record<ReconcileBucket, number> {
  const totals = {} as Record<ReconcileBucket, number>;
  for (const b of ALL_BUCKETS) totals[b] = 0;
  return totals;
}

/** Build the base (pre-merge) line fields shared by every matched row, from the row + candidate. */
function baseFieldsFromRow(row: ExpectedInventoryRow): Pick<ReconcileLine, "partNumbers" | "brand" | "model" | "sizeText"> {
  return {
    partNumbers: [...row.partNumbers],
    brand: row.brand,
    model: row.model,
    sizeText: row.sizeText,
  };
}

/** Merge two matched MatchResults that share a corpus uid (AM-R10c, belt and suspenders - the
 *  adapter already aggregates by part number, but two different expected rows can still resolve to
 *  the same corpus product, e.g. two part-number spellings for one tire). Sums expectedQty and
 *  unions partNumbers rather than throwing, and the reason says so plainly. */
function mergeMatchedRows(uid: string, group: MatchResult[]): { expectedQty: number; fields: Pick<ReconcileLine, "partNumbers" | "brand" | "model" | "sizeText">; reason: string } {
  const partNumberSet = new Set<string>();
  let expectedQty = 0;
  let brand: string | undefined;
  let model: string | undefined;
  let sizeText: string | undefined;
  for (const m of group) {
    expectedQty += m.row.qty;
    for (const pn of m.row.partNumbers) partNumberSet.add(pn);
    brand = brand ?? m.row.brand;
    model = model ?? m.row.model;
    sizeText = sizeText ?? m.row.sizeText;
  }
  const partNumbers = [...partNumberSet];
  const reason =
    group.length > 1
      ? `Merged ${group.length} expected rows that matched the same corpus product (part numbers: ${partNumbers.join(", ")}); expected quantities combined.`
      : group[0].reason;
  return { expectedQty, fields: { partNumbers, brand, model, sizeText }, reason };
}

function varianceReason(expectedQty: number, countedQty: number, delta: number): string {
  if (delta === 0) {
    return `Counted ${countedQty} matches the expected quantity of ${expectedQty}; no variance.`;
  }
  const direction = delta > 0 ? "more" : "fewer";
  return `Counted ${countedQty}, expected ${expectedQty}: ${Math.abs(delta)} ${direction} than expected.`;
}

/**
 * Build the bucketed reconcile report. Every input line lands in exactly one bucket, each with an
 * honest reason. The scope boundary (AM-R8): a matched row not present in `countedByUid` is
 * `expected_not_counted`, never `variance` - there is no code path from "uncounted" to "variance"
 * below (that branch does not exist; see the matched-row handling for the only two matched buckets).
 */
export function buildReconcileReport(input: BuildReconcileReportInput): ReconcileReport {
  const { matches, adapter, countedByUid } = input;
  const lines: ReconcileLine[] = [];

  // --- Matched rows: group by candidate.uid first so duplicates merge instead of duplicating lines
  // or throwing (AM-R10c). Non-matched statuses pass straight through, one line each.
  const matchedByUid = new Map<string, MatchResult[]>();
  for (const m of matches) {
    if (m.status !== "matched" || !m.candidate) {
      lines.push(passthroughLine(m));
      continue;
    }
    const group = matchedByUid.get(m.candidate.uid) ?? [];
    group.push(m);
    matchedByUid.set(m.candidate.uid, group);
  }

  for (const [uid, group] of matchedByUid) {
    const { expectedQty, fields, reason } = mergeMatchedRows(uid, group);
    // Guard against inherited Object.prototype keys (e.g. a corpus uid literally named
    // "constructor" or "toString"): a plain bracket read on those returns the inherited
    // function, not undefined, which would silently smuggle an uncounted row into `variance`
    // with a NaN delta and defeat the AM-R8 scope boundary. hasOwnProperty forces a true
    // own-key check regardless of the key's name (review finding).
    const counted = Object.prototype.hasOwnProperty.call(countedByUid, uid) ? countedByUid[uid] : undefined;

    if (counted === undefined) {
      // AM-R8 scope boundary: NOT counted this session -> expected_not_counted, NEVER variance.
      lines.push({
        bucket: "expected_not_counted",
        ...fields,
        expectedQty,
        reason: `${reason} Not counted in this session (out of scope for this count); this is not shrinkage.`,
      });
      continue;
    }

    const delta = counted - expectedQty;
    lines.push({
      bucket: delta === 0 ? "agreement" : "variance",
      ...fields,
      expectedQty,
      countedQty: counted,
      delta,
      reason: `${reason} ${varianceReason(expectedQty, counted, delta)}`,
    });
  }

  // --- Adapter passthrough buckets: uomReview + unparseable (Task 4 output held out of matching).
  for (const row of adapter.uomReview) {
    lines.push({
      bucket: "uom_review",
      ...baseFieldsFromRow(row),
      expectedQty: row.qty,
      reason: `Quantity unit is not "each" for this row; needs manual review before it can be compared (uom_review).`,
    });
  }

  for (const u of adapter.unparseable) {
    lines.push({
      bucket: "unparseable",
      partNumbers: [],
      reason: `Line ${u.line}: ${u.reason}`,
    });
  }

  const totals = emptyTotals();
  for (const line of lines) totals[line.bucket] += 1;

  return { lines, totals, assumptions: [...adapter.assumptions] };
}

/** One passthrough line for a non-matched MatchResult status (ambiguous/unmatched/non_tire). The
 *  matcher's own reason is already honest and specific, so it is carried through verbatim. */
function passthroughLine(m: MatchResult): ReconcileLine {
  const bucket: ReconcileBucket = m.status === "ambiguous" ? "ambiguous" : m.status === "unmatched" ? "unmatched" : "non_tire";
  return {
    bucket,
    ...baseFieldsFromRow(m.row),
    expectedQty: m.row.qty,
    reason: m.reason,
  };
}

/** CSV export of the full reconcile report. Reuses buildCsv (escaping/BOM/CSV-injection guarding),
 *  the same helper every other export in the app uses. Works with 0 lines (header row only). */
export function reconcileReportCsv(report: ReconcileReport): string {
  const headers = [
    "bucket",
    "part_numbers",
    "brand",
    "model",
    "size",
    "expected_qty",
    "counted_qty",
    "delta",
    "reason",
  ];
  const rows = report.lines.map((l) => [
    l.bucket,
    l.partNumbers.join(" | "),
    l.brand ?? "",
    l.model ?? "",
    l.sizeText ?? "",
    l.expectedQty ?? "",
    l.countedQty ?? "",
    l.delta ?? "",
    l.reason,
  ]);
  return buildCsv(headers, rows);
}
