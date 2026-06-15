// Pure analysis for the Phase-1 decode benchmark. No I/O, no fetch - so it is fully unit-testable and
// is the single source of truth the runner script (scripts/benchmark-decodes.ts) imports. Only
// `import type` here (erased at runtime) so the plain-node runner can import this .ts without a build.

import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";

export interface BenchmarkInputRow {
  code: string;
  expectedName?: string;
  expectedBrand?: string;
  expectedCategory?: string;
  expectedSku?: string;
  expectedSource?: string;
  notes?: string;
}

export interface DecodeResponseLike {
  providerNames?: string[];
  results?: Array<{ productName?: string; brand?: string; sourceUrls?: string[] }>;
  providerStatuses?: ProviderStatus[];
  decision?: { status?: string; reason?: string };
  reasonCode?: string;
  reasonText?: string;
  timedOut?: boolean;
  debug?: {
    cached?: boolean;
    fallbackFound?: boolean;
    coverageMissed?: boolean;
    firecrawlCreditsEstimated?: number;
    firecrawlCandidates?: number;
    latencyMs?: number;
  };
}

// Where the resolved product came from (or why it didn't resolve).
export type LookupPath =
  | "cache"
  | "fast_page_fetch"
  | "gemini_flash"
  | "openai_mini"
  | "firecrawl_fallback"
  | "ai_deep_fallback"
  | "needs_review"
  | "failed";

export type AccuracyVerdict =
  | "pass"
  | "partial"
  | "fail"
  | "needs_manual_review"
  | "resolved_without_ground_truth"
  | "needs_review"
  | "failed"
  | "cached";

const USABLE_JUNK = /^(unknown|n\/?a|none|null|not found|product not found|no product|search|barcode lookup)\b/i;

export function isUsableName(name: string | undefined | null): boolean {
  const n = (name ?? "").trim();
  if (n.length < 3) return false;
  if (USABLE_JUNK.test(n)) return false;
  return /[a-z]/i.test(n);
}

/** Map a decode response to the lookup path that produced it (for the path-breakdown table). */
export function classifyPath(r: DecodeResponseLike): LookupPath {
  if (r.debug?.cached) return "cache";
  const best = r.results?.[0];
  const resolved = !!best && isUsableName(best.productName) && r.decision?.status !== "needs_review";
  if (!resolved) {
    if (r.timedOut || r.reasonCode === "lookup_budget_exceeded" || r.reasonCode === "provider_error") return "failed";
    return "needs_review";
  }
  const winner = (r.providerNames?.[0] ?? "").toLowerCase();
  const fallback = !!r.debug?.fallbackFound;
  if (winner.startsWith("firecrawl")) return "firecrawl_fallback";
  if (winner.startsWith("ai-deep") || winner.startsWith("ai-cited") || winner.startsWith("deep:")) return "ai_deep_fallback";
  if (winner.startsWith("page-fetch")) return fallback ? "ai_deep_fallback" : "fast_page_fetch";
  if (winner.startsWith("gemini")) return fallback ? "ai_deep_fallback" : "gemini_flash";
  if (winner.startsWith("openai")) return fallback ? "ai_deep_fallback" : "openai_mini";
  return fallback ? "ai_deep_fallback" : "fast_page_fetch";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function tokenOverlap(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

/** Honest accuracy: only claim correctness when ground truth exists. */
export function accuracyVerdict(r: DecodeResponseLike, expected: BenchmarkInputRow): { verdict: AccuracyVerdict; reason: string } {
  if (r.debug?.cached) return { verdict: "cached", reason: "Served from decode cache." };
  const best = r.results?.[0];
  const name = best?.productName ?? "";
  const resolved = isUsableName(name) && r.decision?.status !== "needs_review";

  const hasGroundTruth = !!(expected.expectedName?.trim() || expected.expectedBrand?.trim());
  if (!hasGroundTruth) {
    if (resolved) return { verdict: "resolved_without_ground_truth", reason: "Resolved a product, but no expectedName/Brand to verify against." };
    if (r.timedOut || r.reasonCode === "provider_error") return { verdict: "failed", reason: r.reasonText || r.reasonCode || "failed" };
    return { verdict: "needs_review", reason: r.reasonText || r.reasonCode || "needs_review" };
  }

  // Ground truth present.
  if (!resolved) return { verdict: "fail", reason: `Expected "${expected.expectedName ?? expected.expectedBrand}" but app did not resolve a product (${r.reasonCode ?? "needs_review"}).` };

  const nameSim = expected.expectedName ? tokenOverlap(name, expected.expectedName) : 0;
  const brandOk = expected.expectedBrand ? norm(name).includes(norm(expected.expectedBrand)) || norm(best?.brand ?? "").includes(norm(expected.expectedBrand)) : false;

  if (expected.expectedName && nameSim >= 0.6) return { verdict: "pass", reason: `Name overlap ${(nameSim * 100).toFixed(0)}%.` };
  if (brandOk || (expected.expectedName && nameSim >= 0.3)) return { verdict: "partial", reason: `Brand/name partially matched (name overlap ${(nameSim * 100).toFixed(0)}%).` };
  return { verdict: "needs_manual_review", reason: `Resolved "${name}" but it does not clearly match expected "${expected.expectedName ?? expected.expectedBrand}".` };
}

export interface LatencyStats {
  count: number;
  avg: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export function latencyStats(msList: number[]): LatencyStats {
  const xs = msList.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return { count: 0, avg: 0, median: 0, p95: 0, min: 0, max: 0 };
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))];
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length,
    avg: Math.round(sum / xs.length),
    median: at(0.5),
    p95: at(0.95),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

/** Firecrawl credits for one decode response (actual if reported, else 1 search + 1 per candidate). */
export function firecrawlCreditsForResponse(r: DecodeResponseLike): number {
  const fromDebug = r.debug?.firecrawlCreditsEstimated;
  if (typeof fromDebug === "number" && fromDebug > 0) return fromDebug;
  const fc = r.providerStatuses?.find((s) => s.provider === "firecrawl");
  if (fc && fc.status !== "skipped") return 1 + (fc.sourceUrlsReturned || 0);
  return 0;
}

/** AI calls attempted on a response (gemini/openai, fast + deep), for rough cost estimation. */
export function aiCallsForResponse(r: DecodeResponseLike): { gemini: number; openai: number } {
  let gemini = 0;
  let openai = 0;
  for (const s of r.providerStatuses ?? []) {
    const p = s.provider.toLowerCase();
    if (p.includes("gemini")) gemini++;
    else if (p.includes("openai")) openai++;
  }
  return { gemini, openai };
}

// Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/newlines/escaped quotes).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRow();
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

export function toInputRows(records: Record<string, string>[]): BenchmarkInputRow[] {
  return records
    .map((r) => ({
      code: (r.code ?? "").trim(),
      expectedName: r.expectedName,
      expectedBrand: r.expectedBrand,
      expectedCategory: r.expectedCategory,
      expectedSku: r.expectedSku,
      expectedSource: r.expectedSource,
      notes: r.notes,
    }))
    .filter((r) => r.code !== "");
}

export interface BenchmarkRow {
  code: string;
  path: LookupPath;
  verdict: AccuracyVerdict;
  verdictReason: string;
  productName: string;
  decision: string;
  reasonCode: string;
  latencyMs: number;
  cached: boolean;
  firecrawlCredits: number;
  cachedLatencyMs?: number; // from the 2nd (repeat) call, when run
  cachedConfirmed?: boolean;
}

export interface BenchmarkSummary {
  total: number;
  byPath: Record<string, number>;
  byVerdict: Record<string, number>;
  resolved: number;
  needsReview: number;
  failed: number;
  latency: LatencyStats;
  slowest: Array<{ code: string; latencyMs: number; path: LookupPath }>;
  firecrawlCreditsTotal: number;
  aiCallsTotal: { gemini: number; openai: number };
}

export function summarize(rows: BenchmarkRow[]): BenchmarkSummary {
  const byPath: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const r of rows) {
    byPath[r.path] = (byPath[r.path] ?? 0) + 1;
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  }
  const resolvedPaths: LookupPath[] = ["cache", "fast_page_fetch", "gemini_flash", "openai_mini", "firecrawl_fallback", "ai_deep_fallback"];
  const resolved = rows.filter((r) => resolvedPaths.includes(r.path)).length;
  const slowest = rows.slice().sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10).map((r) => ({ code: r.code, latencyMs: r.latencyMs, path: r.path }));
  return {
    total: rows.length,
    byPath,
    byVerdict,
    resolved,
    needsReview: byPath["needs_review"] ?? 0,
    failed: byPath["failed"] ?? 0,
    latency: latencyStats(rows.map((r) => r.latencyMs)),
    slowest,
    firecrawlCreditsTotal: rows.reduce((a, r) => a + (r.firecrawlCredits || 0), 0),
    aiCallsTotal: { gemini: 0, openai: 0 },
  };
}
