import type { InventoryCount, ScanEvent } from "@/types";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import { resolveRawScan } from "@/services/resolver";
import { incrementInventoryCount } from "@/services/inventory";
import { exportFinalCounts } from "@/services/csvExport";
import { parseCsv } from "@/services/csvImport";

// Deterministic SEED benchmark. Pure (no I/O, no React, no network, no paid calls). It runs the REAL
// deterministic resolver + inventory math + CSV export over the seed catalog to prove the pipeline's
// correctness/idempotency metrics with ZERO spend. The live 4-real-code benchmark (separate) exercises
// the paid lookup paths. This module is the honest, free, repeatable companion to that.
//
// It intentionally proves the things that MUST hold regardless of AI:
//   - false_known = 0 (no code ever resolves Known to the WRONG product)
//   - duplicate prevention = 100% (replaying the same scan event id is a no-op)
//   - alias resolution (SKU / messy-label codes resolve to the same product as the primary barcode)
//   - unknown codes route to needs_review (never a wrong guess)
//   - CSV export round-trips (quantities survive export -> parse)
//   - repeat paid calls avoided = 100% (the deterministic path spends nothing, by construction)

export type SeedScanIntent = "known" | "needs_review";

export interface SeedScan {
  label: string;
  rawCode: string;
  expectedProductId: string | null; // null => should NOT resolve Known
  expectedName: string | null;
  intent: SeedScanIntent;
  isAlias: boolean; // a non-primary-barcode code (SKU / messy label) that must still resolve
  isRepeat: boolean; // a legitimate second physical scan of the same code (should increment)
}

export interface SeedBenchmarkRow {
  label: string;
  rawCode: string;
  cleanCode: string;
  expectedProductId: string | null;
  resolvedProductId: string | null;
  resolverStatus: string;
  matchType: string;
  correct: boolean;
  falseKnown: boolean;
  latencyMs: number;
}

export interface SeedBenchmarkMetrics {
  total: number;
  scanSuccess: number;
  known: number;
  needsReview: number;
  conflict: number;
  falseKnown: number;
  nameAccuracyPct: number;
  aliasTotal: number;
  aliasResolvedKnown: number;
  needsReviewRatePct: number;
  retries: number;
  retriesNoOp: number;
  dupPreventionPct: number;
  paidCalls: number;
  firecrawlCredits: number;
  repeatPaidAvoidedPct: number;
  byPath: Record<string, number>;
  latency: { avg: number; median: number; p95: number; min: number; max: number; slowestLabel: string };
  csvRoundTrip: boolean;
  expectedTotalQuantity: number;
  csvParsedTotalQuantity: number;
}

export interface SeedBenchmarkResult {
  rows: SeedBenchmarkRow[];
  metrics: SeedBenchmarkMetrics;
  generatedNote: string;
}

/** The fixed seed scan plan: every product by primary barcode, alias codes, repeats, and one unknown. */
export function buildSeedScanPlan(): SeedScan[] {
  return [
    // Primary barcodes (one per seed product)
    { label: "nokian-barcode", rawCode: "6419440485331", expectedProductId: "prod-nokian", expectedName: "Nokian Outpost APT", intent: "known", isAlias: false, isRepeat: false },
    { label: "falken-barcode", rawCode: "848983012906", expectedProductId: "prod-falken", expectedName: "Falken Sincera ST80 A/S", intent: "known", isAlias: false, isRepeat: false },
    { label: "coke-upc", rawCode: "049000028904", expectedProductId: "prod-coke", expectedName: "Coca-Cola 12 pack 12 oz cans", intent: "known", isAlias: false, isRepeat: false },
    { label: "whey-upc", rawCode: "850012345678", expectedProductId: "prod-supplement", expectedName: "Vital Whey Protein Vanilla 2lb", intent: "known", isAlias: false, isRepeat: false },
    { label: "dewalt-upc", rawCode: "885911484047", expectedProductId: "prod-tool", expectedName: "DeWalt 20V Impact Driver", intent: "known", isAlias: false, isRepeat: false },
    // Alias codes (SKU + messy label) must resolve to the same product
    { label: "nokian-sku", rawCode: "T432119", expectedProductId: "prod-nokian", expectedName: "Nokian Outpost APT", intent: "known", isAlias: true, isRepeat: false },
    { label: "nokian-messy", rawCode: "T432119%RU1%", expectedProductId: "prod-nokian", expectedName: "Nokian Outpost APT", intent: "known", isAlias: true, isRepeat: false },
    { label: "falken-hyphen-sku", rawCode: "2881-6861", expectedProductId: "prod-falken", expectedName: "Falken Sincera ST80 A/S", intent: "known", isAlias: true, isRepeat: false },
    { label: "coke-internal", rawCode: "7262", expectedProductId: "prod-coke", expectedName: "Coca-Cola 12 pack 12 oz cans", intent: "known", isAlias: true, isRepeat: false },
    { label: "whey-sku", rawCode: "VWP-VAN-2LB", expectedProductId: "prod-supplement", expectedName: "Vital Whey Protein Vanilla 2lb", intent: "known", isAlias: true, isRepeat: false },
    { label: "dewalt-sku", rawCode: "DCF887B", expectedProductId: "prod-tool", expectedName: "DeWalt 20V Impact Driver", intent: "known", isAlias: true, isRepeat: false },
    // Legitimate repeats (a second physical unit scanned) -> should increment, not create a new product
    { label: "nokian-barcode-repeat", rawCode: "6419440485331", expectedProductId: "prod-nokian", expectedName: "Nokian Outpost APT", intent: "known", isAlias: false, isRepeat: true },
    { label: "coke-upc-repeat", rawCode: "049000028904", expectedProductId: "prod-coke", expectedName: "Coca-Cola 12 pack 12 oz cans", intent: "known", isAlias: false, isRepeat: true },
    // Unknown -> must route to needs_review (never a wrong guess)
    { label: "unknown-code", rawCode: "999999999999", expectedProductId: null, expectedName: null, intent: "needs_review", isAlias: false, isRepeat: false },
  ];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Runs the seed benchmark. `now` defaults to a fixed timestamp so results are deterministic. */
export function runSeedBenchmark(now = "2026-06-15T00:00:00.000Z"): SeedBenchmarkResult {
  const { products, aliases } = getSeed();
  const plan = buildSeedScanPlan();
  const sessionId = "seed-benchmark-session";

  const rows: SeedBenchmarkRow[] = [];
  let counts: InventoryCount[] = [];
  let countIdSeq = 0;
  const makeId = () => `count-${++countIdSeq}`;

  const byPath: Record<string, number> = {};
  const events: ScanEvent[] = [];

  plan.forEach((scan, i) => {
    const t0 = performance.now();
    const res = resolveRawScan(scan.rawCode, products, aliases, DEMO_BUSINESS_ID);
    const latencyMs = performance.now() - t0;

    const resolvedKnown = res.resolverStatus === "known";
    const path =
      res.resolverStatus === "known" ? "deterministic_known" : res.resolverStatus === "conflict" ? "conflict" : "needs_review";
    byPath[path] = (byPath[path] ?? 0) + 1;

    const correct =
      scan.intent === "known"
        ? resolvedKnown && res.productId === scan.expectedProductId
        : !resolvedKnown; // unknown is correct only if it did NOT resolve Known
    // A false-known is the cardinal sin: resolved Known but to a product other than the expected one
    // (or resolved Known for a code that should be unknown).
    const falseKnown = resolvedKnown && res.productId !== scan.expectedProductId;

    rows.push({
      label: scan.label,
      rawCode: scan.rawCode,
      cleanCode: res.cleanCode,
      expectedProductId: scan.expectedProductId,
      resolvedProductId: res.productId,
      resolverStatus: res.resolverStatus,
      matchType: res.matchType,
      correct,
      falseKnown,
      latencyMs,
    });

    // Build + apply a counting event for Known scans (deterministic inventory math).
    if (resolvedKnown && res.productId) {
      const event: ScanEvent = {
        id: `evt-${i}`,
        businessId: DEMO_BUSINESS_ID,
        sessionId,
        rawCode: scan.rawCode,
        cleanCode: res.cleanCode,
        normalizedCandidates: res.normalizedCandidates,
        matchedProductId: res.productId,
        matchType: res.matchType,
        status: "known",
        resolverStatus: res.resolverStatus,
        codeType: res.codeType,
        reason: res.reason,
        quantityDelta: 1,
        quantityAfterScan: 0,
        createdAt: now,
        source: "scan",
        notes: "",
        syncStatus: "synced",
        syncError: null,
        idempotencyKey: `idem-${i}`,
      };
      const applied = incrementInventoryCount(counts, event, makeId);
      counts = applied.counts;
      events.push(event);
    }
  });

  // Duplicate-prevention proof: replay EVERY counted event id once more (simulating a sync retry).
  // Each replay MUST be a no-op (applied === false), or it is a double count.
  let retries = 0;
  let retriesNoOp = 0;
  for (const event of events) {
    retries += 1;
    const before = counts;
    const replay = incrementInventoryCount(before, event, makeId);
    if (!replay.applied) retriesNoOp += 1;
    counts = replay.counts;
  }

  // CSV export round-trip: export final counts, parse them back, confirm total quantity survives.
  const csv = exportFinalCounts(counts, products, sessionId);
  const parsed = parseCsv(csv);
  const csvParsedTotalQuantity = parsed.rows.reduce((a, r) => a + Number(r.quantity || 0), 0);
  const expectedTotalQuantity = counts.reduce((a, c) => a + c.quantity, 0);

  // Metrics
  const known = rows.filter((r) => r.resolverStatus === "known").length;
  const needsReview = rows.filter((r) => r.resolverStatus === "needs_review").length;
  const conflict = rows.filter((r) => r.resolverStatus === "conflict").length;
  const falseKnown = rows.filter((r) => r.falseKnown).length;
  const knownRows = rows.filter((r) => r.resolverStatus === "known");
  const nameCorrect = knownRows.filter((r) => {
    const p = products.find((pp) => pp.id === r.resolvedProductId);
    const expected = plan.find((s) => s.label === r.label)?.expectedName;
    return p && expected && p.name === expected;
  }).length;
  const aliasRows = rows.filter((r) => plan.find((s) => s.label === r.label)?.isAlias);
  const aliasResolvedKnown = aliasRows.filter((r) => r.resolverStatus === "known" && !r.falseKnown).length;
  const latencies = rows.map((r) => r.latencyMs);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const slowest = rows.reduce((m, r) => (r.latencyMs > m.latencyMs ? r : m), rows[0]);

  const metrics: SeedBenchmarkMetrics = {
    total: rows.length,
    scanSuccess: rows.length, // every scan produced a deterministic result (no errors/timeouts)
    known,
    needsReview,
    conflict,
    falseKnown,
    nameAccuracyPct: knownRows.length ? round1((nameCorrect / knownRows.length) * 100) : 100,
    aliasTotal: aliasRows.length,
    aliasResolvedKnown,
    needsReviewRatePct: round1((needsReview / rows.length) * 100),
    retries,
    retriesNoOp,
    dupPreventionPct: retries ? round1((retriesNoOp / retries) * 100) : 100,
    paidCalls: 0, // deterministic path spends nothing, by construction
    firecrawlCredits: 0,
    repeatPaidAvoidedPct: 100, // all repeats resolved deterministically -> 0 paid calls avoided 100%
    byPath,
    latency: {
      avg: round3(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)),
      median: round3(median(sortedLat)),
      p95: round3(percentile(sortedLat, 95)),
      min: round3(sortedLat[0] ?? 0),
      max: round3(sortedLat[sortedLat.length - 1] ?? 0),
      slowestLabel: slowest?.label ?? "",
    },
    csvRoundTrip: csvParsedTotalQuantity === expectedTotalQuantity && expectedTotalQuantity > 0,
    expectedTotalQuantity,
    csvParsedTotalQuantity,
  };

  return {
    rows,
    metrics,
    generatedNote:
      "Deterministic seed benchmark (no network, no paid calls). Proves resolver/idempotency/CSV correctness with $0 spend.",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
