import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSeedBenchmark, type SeedBenchmarkResult } from "./seedBenchmark";

// Runs the deterministic seed benchmark, asserts the Stage-1 hard gates for the FREE path, and writes
// the proof artifacts to reports/benchmark/. The assertions ARE the gates (false_known=0, duplicate
// prevention=100%, alias resolution, unknown->needs_review, CSV round-trip). No network, no spend.

const OUT = resolve(process.cwd(), "reports/benchmark");

function writeArtifacts(r: SeedBenchmarkResult) {
  mkdirSync(OUT, { recursive: true });
  const m = r.metrics;

  // JSON (full)
  writeFileSync(`${OUT}/seed_benchmark_results.json`, JSON.stringify(r, null, 2) + "\n");

  // CSV (per-scan rows)
  const head = "label,raw_code,clean_code,expected_product_id,resolved_product_id,resolver_status,match_type,correct,false_known,latency_ms";
  const body = r.rows
    .map((x) =>
      [x.label, x.rawCode, x.cleanCode, x.expectedProductId ?? "", x.resolvedProductId ?? "", x.resolverStatus, x.matchType, x.correct, x.falseKnown, x.latencyMs.toFixed(3)].join(","),
    )
    .join("\n");
  writeFileSync(`${OUT}/seed_benchmark_results.csv`, head + "\n" + body + "\n");

  // Markdown summary
  const pathLines = Object.entries(m.byPath)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join("\n");
  const md = `# Seed benchmark (deterministic, $0 spend)

${r.generatedNote}

- Scans: **${m.total}**  |  Known: **${m.known}**  |  Needs review: **${m.needsReview}**  |  Conflict: **${m.conflict}**
- **false_known: ${m.falseKnown}** (gate: 0)
- Name accuracy (known): **${m.nameAccuracyPct}%**
- Alias resolution: **${m.aliasResolvedKnown}/${m.aliasTotal}**
- Needs-review rate: **${m.needsReviewRatePct}%**
- **Duplicate prevention: ${m.dupPreventionPct}%** (${m.retriesNoOp}/${m.retries} retries were no-ops; gate: 100%)
- Paid calls: **${m.paidCalls}**  |  Firecrawl credits: **${m.firecrawlCredits}**  |  Repeat paid avoided: **${m.repeatPaidAvoidedPct}%**
- CSV round-trip: **${m.csvRoundTrip ? "PASS" : "FAIL"}** (export->parse total qty ${m.csvParsedTotalQuantity} == ${m.expectedTotalQuantity})

## Lookup path distribution
| path | count |
|------|------:|
${pathLines}

## Latency (per resolve, ms)
| metric | ms |
|--------|---:|
| avg | ${m.latency.avg} |
| median | ${m.latency.median} |
| p95 | ${m.latency.p95} |
| min | ${m.latency.min} |
| max | ${m.latency.max} |
| slowest | ${m.latency.slowestLabel} (${m.latency.max} ms) |

> Note: this is the DETERMINISTIC path (resolver + inventory + CSV). It deliberately spends \$0 and
> exercises no AI/Firecrawl. The live paid lookup paths are measured separately in
> \`real_limited_4_code_results.*\` (4 real codes; the real 100-code benchmark is blocked — no owner file).
`;
  writeFileSync(`${OUT}/seed_benchmark_summary.md`, md);
}

describe("Stage 1 seed benchmark (deterministic, free)", () => {
  let result: SeedBenchmarkResult;
  beforeAll(() => {
    result = runSeedBenchmark();
    writeArtifacts(result);
  });

  it("resolves every scan and produces no errors", () => {
    expect(result.metrics.scanSuccess).toBe(result.metrics.total);
    expect(result.metrics.total).toBe(14);
  });

  it("HARD GATE: false_known === 0 (never resolves Known to the wrong product)", () => {
    expect(result.metrics.falseKnown).toBe(0);
    for (const row of result.rows) expect(row.falseKnown).toBe(false);
  });

  it("every scan outcome is correct vs ground truth", () => {
    const wrong = result.rows.filter((r) => !r.correct);
    expect(wrong.map((r) => r.label)).toEqual([]);
  });

  it("resolves ALL alias codes (SKU / messy label) to the right product", () => {
    expect(result.metrics.aliasResolvedKnown).toBe(result.metrics.aliasTotal);
    expect(result.metrics.aliasTotal).toBeGreaterThanOrEqual(6);
  });

  it("routes the unknown code to needs_review (no wrong guess), zero conflicts", () => {
    expect(result.metrics.needsReview).toBe(1);
    expect(result.metrics.conflict).toBe(0);
  });

  it("HARD GATE: duplicate prevention === 100% (every retry is a no-op)", () => {
    expect(result.metrics.dupPreventionPct).toBe(100);
    expect(result.metrics.retriesNoOp).toBe(result.metrics.retries);
    expect(result.metrics.retries).toBeGreaterThan(0);
  });

  it("HARD GATE: CSV export round-trips (quantities survive)", () => {
    expect(result.metrics.csvRoundTrip).toBe(true);
    expect(result.metrics.expectedTotalQuantity).toBe(13);
  });

  it("spends nothing on the deterministic path", () => {
    expect(result.metrics.paidCalls).toBe(0);
    expect(result.metrics.firecrawlCredits).toBe(0);
    expect(result.metrics.repeatPaidAvoidedPct).toBe(100);
  });
});
