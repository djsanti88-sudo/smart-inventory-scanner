import type { ProviderStatus } from "@/decoding/decodeProviderStatus";

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
  debug?: { cached?: boolean; decodePath?: string; latencyMs?: number };
}

export type LookupPath =
  | "cache"
  | "tire_corpus"
  | "retail_corpus"
  | "learned_products"
  | "master_catalog"
  | "gpt_5_4_mini"
  | "needs_review"
  | "failed";

export type AccuracyVerdict = "pass" | "partial" | "fail" | "needs_manual_review" | "resolved_without_ground_truth" | "needs_review" | "failed" | "cached";

const USABLE_JUNK = /^(unknown|n\/?a|none|null|not found|product not found|no product|search|barcode lookup)\b/i;
const RESOLVED_PATHS: LookupPath[] = ["cache", "tire_corpus", "retail_corpus", "learned_products", "master_catalog", "gpt_5_4_mini"];

export function isUsableName(name: string | undefined | null): boolean {
  const value = (name ?? "").trim();
  return value.length >= 3 && !USABLE_JUNK.test(value) && /[a-z]/i.test(value);
}

export function classifyPath(response: DecodeResponseLike): LookupPath {
  if (response.debug?.cached) return "cache";
  const resolved = isUsableName(response.results?.[0]?.productName) && response.decision?.status !== "needs_review";
  if (!resolved) {
    return response.timedOut || ["lookup_budget_exceeded", "provider_error"].includes(response.reasonCode ?? "") ? "failed" : "needs_review";
  }
  const source = (response.debug?.decodePath ?? response.providerNames?.[0] ?? "").toLowerCase().replaceAll("-", "_");
  if (source.includes("tire_corpus")) return "tire_corpus";
  if (source.includes("retail_corpus")) return "retail_corpus";
  if (source.includes("learned_products")) return "learned_products";
  if (source.includes("master_catalog")) return "master_catalog";
  return "gpt_5_4_mini";
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(norm(left).split(" ").filter(Boolean));
  const rightTokens = new Set(norm(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let matches = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) matches++;
  return matches / Math.max(leftTokens.size, rightTokens.size);
}

export function accuracyVerdict(response: DecodeResponseLike, expected: BenchmarkInputRow): { verdict: AccuracyVerdict; reason: string } {
  if (response.debug?.cached) return { verdict: "cached", reason: "Served from decode cache." };
  const best = response.results?.[0];
  const name = best?.productName ?? "";
  const resolved = isUsableName(name) && response.decision?.status !== "needs_review";
  const groundTruth = expected.expectedName?.trim() || expected.expectedBrand?.trim();
  if (!groundTruth) {
    if (resolved) return { verdict: "resolved_without_ground_truth", reason: "Resolved, but no ground truth was supplied." };
    if (response.timedOut || response.reasonCode === "provider_error") return { verdict: "failed", reason: response.reasonText || response.reasonCode || "failed" };
    return { verdict: "needs_review", reason: response.reasonText || response.reasonCode || "needs_review" };
  }
  if (!resolved) return { verdict: "fail", reason: `Expected "${groundTruth}" but no product resolved.` };
  const overlap = expected.expectedName ? tokenOverlap(name, expected.expectedName) : 0;
  const expectedBrand = norm(expected.expectedBrand ?? "");
  const brandMatches = !!expectedBrand && (norm(name).includes(expectedBrand) || norm(best?.brand ?? "").includes(expectedBrand));
  if (expected.expectedName && overlap >= 0.6) return { verdict: "pass", reason: `Name overlap ${(overlap * 100).toFixed(0)}%.` };
  if (brandMatches || (expected.expectedName && overlap >= 0.3)) return { verdict: "partial", reason: `Brand/name partially matched (name overlap ${(overlap * 100).toFixed(0)}%).` };
  return { verdict: "needs_manual_review", reason: `Resolved "${name}" but it does not clearly match "${groundTruth}".` };
}

export interface LatencyStats { count: number; avg: number; median: number; p95: number; min: number; max: number }
export function latencyStats(values: number[]): LatencyStats {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, avg: 0, median: 0, p95: 0, min: 0, max: 0 };
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1))];
  return { count: sorted.length, avg: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length), median: percentile(0.5), p95: percentile(0.95), min: sorted[0], max: sorted.at(-1)! };
}

export function gptDecodeCallsForResponse(response: DecodeResponseLike): number {
  return (response.providerStatuses ?? []).some((status) => status.provider === "gpt-5.4-mini" && status.status !== "skipped") ? 1 : 0;
}

export function webSearchCallsForResponse(response: DecodeResponseLike): number {
  return gptDecodeCallsForResponse(response) ? 5 : 0;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") pushField();
    else if (!quoted && char === "\n") pushRow();
    else if (char !== "\r") field += char;
  }
  if (field.length || row.length) pushRow();
  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim()));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((header) => header.trim());
  return nonEmpty.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? "").trim()])));
}

export function toInputRows(records: Record<string, string>[]): BenchmarkInputRow[] {
  return records.map((record) => ({ code: (record.code ?? "").trim(), expectedName: record.expectedName, expectedBrand: record.expectedBrand, expectedCategory: record.expectedCategory, expectedSku: record.expectedSku, expectedSource: record.expectedSource, notes: record.notes })).filter((row) => row.code);
}

export interface BenchmarkRow { code: string; path: LookupPath; verdict: AccuracyVerdict; verdictReason: string; productName: string; decision: string; reasonCode: string; latencyMs: number; cached: boolean; gptDecodeCalls: number; webSearchCalls: number; cachedLatencyMs?: number; cachedConfirmed?: boolean }
export interface BenchmarkSummary { total: number; byPath: Record<string, number>; byVerdict: Record<string, number>; resolved: number; needsReview: number; failed: number; latency: LatencyStats; slowest: Array<{ code: string; latencyMs: number; path: LookupPath }>; gptDecodeCallsTotal: number; webSearchCallsReserved: number }

export function summarize(rows: BenchmarkRow[]): BenchmarkSummary {
  const byPath: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const row of rows) { byPath[row.path] = (byPath[row.path] ?? 0) + 1; byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1; }
  return {
    total: rows.length,
    byPath,
    byVerdict,
    resolved: rows.filter((row) => RESOLVED_PATHS.includes(row.path)).length,
    needsReview: byPath.needs_review ?? 0,
    failed: byPath.failed ?? 0,
    latency: latencyStats(rows.map((row) => row.latencyMs)),
    slowest: rows.slice().sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10).map(({ code, latencyMs, path }) => ({ code, latencyMs, path })),
    gptDecodeCallsTotal: rows.reduce((sum, row) => sum + row.gptDecodeCalls, 0),
    webSearchCallsReserved: rows.reduce((sum, row) => sum + row.webSearchCalls, 0),
  };
}
