#!/usr/bin/env node
// Task B4 - Deterministic scorer for the tire-DB repair/enrichment bakeoff.
//
// Reads the 4 lane results files + answer_key.json (+ sample.json for coverage denominators)
// and produces a per-lane scorecard: coverage (raw + achievable), per-field accuracy, the
// wrong-answer rate (killer metric), mean latency, trusted-host share, and cost per successful
// fill. Actual usage (Firecrawl op counts, Codex invocation) and automation-friendliness scores
// are bound from the lane reports (task-B2-report.md / task-B3-lane{1,2,3}-report.md) since
// those numbers are not present in the machine-readable results files themselves.
//
// No web calls. No DB writes. Pure offline JSON scoring. Deterministic: same inputs -> same
// output every run.
//
// Usage: node scripts/tire-db-repair/bakeoff/score.mjs [--json]
//   --json   print the full scorecard object as JSON instead of the human-readable table.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BAKEOFF_DIR = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff"
);

const SAMPLE_PATH = path.join(BAKEOFF_DIR, "sample.json");
const ANSWER_KEY_PATH = path.join(BAKEOFF_DIR, "answer_key.json");
const LANE_FILES = {
  lane0: path.join(BAKEOFF_DIR, "results_lane0.json"),
  lane1: path.join(BAKEOFF_DIR, "results_lane1.json"),
  lane2: path.join(BAKEOFF_DIR, "results_lane2.json"),
  lane3: path.join(BAKEOFF_DIR, "results_lane3.json"),
};

// Placeholder/synthetic barcodes present in the 30-row sample (real DB rows with all-zero-style
// test barcodes). No lane can legitimately solve these from the web/DB; "achievable coverage"
// excludes them from the denominator. Ids verified against sample.json's `barcode` field.
const PLACEHOLDER_IDS = new Set([
  "B1-006", "B1-007", "B1-008", "B1-009", "B1-010",
  "B1-016", "B1-017", "B1-018", "B1-019", "B1-020",
]);

// Actual usage figures bound from the lane reports (not present in the results JSON files).
const ACTUAL_USAGE = {
  lane0: { summary: "$0 deterministic (local DB + static prefix map, zero network calls)", firecrawl_ops: 0, cost_usd: 0 },
  lane1: { summary: "$0 (WebSearch, built-in tool; 2 WebFetch attempts both failed)", firecrawl_ops: 0, cost_usd: 0 },
  lane2: { summary: "29 Firecrawl operations (18 search incl. 2 retries, 9 scrape; well under 70-op cap)", firecrawl_ops: 29, cost_usd: null },
  lane3: { summary: "Codex GPT-5.5 subscription, one ~11-minute batch invocation, $0 marginal (subscription billing)", firecrawl_ops: 0, cost_usd: 0 },
};

// Automation-friendliness (scriptability, rate limits, structured-output reliability), 1-5.
const AUTOMATION_FRIENDLINESS = {
  lane0: { score: 5, note: "Pure local code: no rate limits, no network flakiness, fully deterministic and re-runnable." },
  lane1: { score: 2, note: "WebSearch/WebFetch have no batch API, no explicit rate-limit contract, and 2/2 WebFetch calls failed in this run." },
  lane2: { score: 4, note: "Clean search+scrape API with an explicit operation budget/cap, but still consumes metered credits per call." },
  lane3: { score: 3, note: "Single batched subscription invocation is simple to script, but is an opaque ~11-minute black box per batch with no per-row cost lever." },
};

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function normalizeBrand(v) {
  if (v == null) return null;
  return String(v).trim().toLowerCase();
}

// Brand family map so corporate siblings never falsely conflict (mirrors the app's
// brandFamilies.ts intent, scoped to only the brands that appear in this bakeoff).
const BRAND_FAMILIES = {
  bfgoodrich: "michelin_family",
  michelin: "michelin_family",
  uniroyal: "michelin_family",
  general: "continental_family",
  continental: "continental_family",
  cooper: "goodyear_family",
  goodyear: "goodyear_family",
};

function brandFamily(v) {
  const n = normalizeBrand(v);
  if (!n) return null;
  return BRAND_FAMILIES[n] || n;
}

function brandsMatch(a, b) {
  if (a == null || b == null) return false;
  return brandFamily(a) === brandFamily(b);
}

// Structural size comparison: extract the digit sequence (width/aspect/rim, ignoring
// separators, LT/P prefixes, load/speed suffixes, and formatting noise) and compare digit-for-
// digit. This deliberately tolerates the known answer-key data quirk where B1-012's truth is
// recorded as "2356017" (no separators) instead of "235/60R17" - both normalize to "2356017".
function normalizeSizeDigits(v) {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  const digits = s.replace(/[^0-9]/g, "");
  return digits.length ? digits : null;
}

function sizesMatch(a, b) {
  const da = normalizeSizeDigits(a);
  const db = normalizeSizeDigits(b);
  if (!da || !db) return false;
  return da === db;
}

// MPN comparison: exact match after trimming and stripping leading zeros (barcodes/part numbers
// are TEXT everywhere per global constraints; we still tolerate zero-pad variants the way the
// lanes themselves did when verifying barcodes).
function normalizeMpn(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return s.replace(/^0+(?=\d)/, "");
}

function mpnsMatch(a, b) {
  const na = normalizeMpn(a);
  const nb = normalizeMpn(b);
  if (!na || !nb) return false;
  return na === nb;
}

const FIELD_MATCHERS = {
  brand: brandsMatch,
  size: sizesMatch,
  manufacturer_part_number: mpnsMatch,
};

const TRUSTED_HOSTS = new Set([
  "discounttire.com",
  "www.discounttire.com",
  "americastire.com",
  "www.americastire.com",
  "continental-tires.com",
  "www.continental-tires.com",
  "titan-intl.com",
  "www.titan-intl.com",
]);

function isTrustedHost(host) {
  if (!host) return false;
  return TRUSTED_HOSTS.has(host.toLowerCase());
}

function buildAnswerIndex(answerKey) {
  const idx = new Map();
  for (const row of answerKey) {
    idx.set(row.id, row);
  }
  return idx;
}

function scoreLane(laneId, laneResults, sampleIndex, answerIndex) {
  const perField = {
    brand: { attempted: 0, correct: 0, wrong: 0, noTruth: 0 },
    size: { attempted: 0, correct: 0, wrong: 0, noTruth: 0 },
    manufacturer_part_number: { attempted: 0, correct: 0, wrong: 0, noTruth: 0 },
  };

  let rawAskedRows = 0;
  let rawFilledRows = 0;
  let achievableAskedRows = 0;
  let achievableFilledRows = 0;
  let wrongFillCount = 0; // strong-truth-only, the killer metric
  let totalFillCount = 0; // all fields actually filled, any confidence
  let strongTruthFillCount = 0; // fills where a strong-truth answer existed (denominator for wrong rate)
  let latencies = [];
  let trustedHostFillCount = 0;
  let totalHostBearingFills = 0;
  let disciplineViolations = []; // lane filled a field on a placeholder-barcode row with no truth

  for (const row of laneResults) {
    const sampleRow = sampleIndex.get(row.id);
    if (!sampleRow) continue;
    const missingFields = sampleRow.missing_fields || [];
    const isPlaceholder = PLACEHOLDER_IDS.has(row.id);
    const fills = row.fills || {};
    const latency = typeof row.latency_ms === "number" ? row.latency_ms : null;
    if (latency != null) latencies.push(latency);

    for (const field of missingFields) {
      rawAskedRows += 1;
      if (!isPlaceholder) achievableAskedRows += 1;

      const filledValue = Object.prototype.hasOwnProperty.call(fills, field) ? fills[field] : undefined;
      const wasFilled = filledValue !== undefined && filledValue !== null && String(filledValue).length > 0;

      if (wasFilled) {
        rawFilledRows += 1;
        if (!isPlaceholder) achievableFilledRows += 1;
        totalFillCount += 1;

        // Host / trusted-host accounting only for genuine fills.
        if (row.source_host) {
          totalHostBearingFills += 1;
          if (isTrustedHost(row.source_host)) trustedHostFillCount += 1;
        }

        const answerRow = answerIndex.get(`${row.id}:${field}`);
        const matcher = FIELD_MATCHERS[field];
        perField[field].attempted += 1;

        if (answerRow && answerRow.has_hidden_truth && answerRow.truth && answerRow.truth[field] != null) {
          const truthVal = answerRow.truth[field];
          const isMatch = matcher(filledValue, truthVal);
          if (isMatch) {
            perField[field].correct += 1;
          } else {
            perField[field].wrong += 1;
            if (answerRow.confidence === "strong") {
              wrongFillCount += 1;
            }
          }
          if (answerRow.confidence === "strong") {
            strongTruthFillCount += 1;
          }
        } else {
          // No hidden truth for this row/field: filled but nothing to check against.
          perField[field].noTruth += 1;
          if (isPlaceholder) {
            disciplineViolations.push({ id: row.id, field, filledValue });
          }
        }
      }
    }
  }

  const meanLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  const successfulFills = rawFilledRows;
  const usage = ACTUAL_USAGE[laneId];
  const costPerFill =
    usage && typeof usage.cost_usd === "number" && successfulFills > 0
      ? usage.cost_usd / successfulFills
      : usage && usage.cost_usd === 0
      ? 0
      : null; // lane2 cost is metered/unknown in USD -> report as "see actual usage" (not fabricated)

  return {
    lane: laneId,
    coverage: {
      raw_asked: rawAskedRows,
      raw_filled: rawFilledRows,
      raw_pct: rawAskedRows ? Math.round((rawFilledRows / rawAskedRows) * 1000) / 10 : 0,
      achievable_asked: achievableAskedRows,
      achievable_filled: achievableFilledRows,
      achievable_pct: achievableAskedRows
        ? Math.round((achievableFilledRows / achievableAskedRows) * 1000) / 10
        : 0,
    },
    per_field_accuracy: Object.fromEntries(
      Object.entries(perField).map(([field, v]) => [
        field,
        {
          ...v,
          accuracy_pct:
            v.correct + v.wrong > 0
              ? Math.round((v.correct / (v.correct + v.wrong)) * 1000) / 10
              : null,
          advisory: field === "manufacturer_part_number",
        },
      ])
    ),
    wrong_answer_rate: {
      wrong_strong_truth_fills: wrongFillCount,
      strong_truth_fill_attempts: strongTruthFillCount,
      pct: strongTruthFillCount
        ? Math.round((wrongFillCount / strongTruthFillCount) * 1000) / 10
        : 0,
    },
    mean_latency_ms: meanLatencyMs,
    actual_usage: usage,
    total_successful_fills: successfulFills,
    cost_per_successful_fill_usd: costPerFill,
    trusted_host_share: {
      trusted: trustedHostFillCount,
      total_host_bearing_fills: totalHostBearingFills,
      pct: totalHostBearingFills
        ? Math.round((trustedHostFillCount / totalHostBearingFills) * 1000) / 10
        : null,
    },
    automation_friendliness: AUTOMATION_FRIENDLINESS[laneId],
    placeholder_discipline_violations: disciplineViolations,
  };
}

function buildRowComparisonMatrix(sampleRows, laneData, answerIndex) {
  const matrix = [];
  for (const sampleRow of sampleRows) {
    const field = sampleRow.missing_fields[0];
    const answerRow = answerIndex.get(`${sampleRow.id}:${field}`);
    const truth =
      answerRow && answerRow.has_hidden_truth && answerRow.truth ? answerRow.truth[field] : null;
    const entry = {
      id: sampleRow.id,
      barcode: sampleRow.barcode,
      field,
      is_placeholder: PLACEHOLDER_IDS.has(sampleRow.id),
      truth,
      truth_confidence: answerRow ? answerRow.confidence : null,
      lanes: {},
    };
    for (const [laneId, results] of Object.entries(laneData)) {
      const row = results.find((r) => r.id === sampleRow.id);
      const filledValue = row && row.fills ? row.fills[field] : undefined;
      let verdict = "empty";
      if (filledValue !== undefined && filledValue !== null && String(filledValue).length > 0) {
        if (truth != null) {
          const matcher = FIELD_MATCHERS[field];
          verdict = matcher(filledValue, truth) ? "correct" : "wrong";
        } else {
          verdict = "filled_no_truth";
        }
      }
      entry.lanes[laneId] = { value: filledValue ?? null, verdict, confidence: row ? row.confidence : null };
    }
    matrix.push(entry);
  }
  return matrix;
}

function main() {
  const sample = loadJson(SAMPLE_PATH);
  const answerKey = loadJson(ANSWER_KEY_PATH);
  const sampleIndex = new Map(sample.map((r) => [r.id, r]));

  const answerIndex = new Map();
  for (const row of answerKey) {
    answerIndex.set(`${row.id}:${row.category}`, row);
  }

  const laneData = {};
  for (const [laneId, filePath] of Object.entries(LANE_FILES)) {
    const raw = loadJson(filePath);
    laneData[laneId] = Array.isArray(raw) ? raw : raw.results;
  }

  const scorecard = {};
  for (const [laneId, results] of Object.entries(laneData)) {
    scorecard[laneId] = scoreLane(laneId, results, sampleIndex, answerIndex);
  }

  const rowMatrix = buildRowComparisonMatrix(sample, laneData, answerIndex);

  const output = { generated_at: new Date().toISOString(), scorecard, row_comparison_matrix: rowMatrix };

  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // Human-readable table.
  const lanes = Object.keys(scorecard);
  console.log("Lane scorecard (bakeoff, 30-row sample, 3 fields asked):\n");
  for (const laneId of lanes) {
    const s = scorecard[laneId];
    console.log(`## ${laneId}`);
    console.log(
      `  Coverage: raw ${s.coverage.raw_filled}/${s.coverage.raw_asked} (${s.coverage.raw_pct}%)  ` +
        `achievable ${s.coverage.achievable_filled}/${s.coverage.achievable_asked} (${s.coverage.achievable_pct}%)`
    );
    for (const [field, v] of Object.entries(s.per_field_accuracy)) {
      console.log(
        `  ${field}${v.advisory ? " [ADVISORY]" : ""}: correct=${v.correct} wrong=${v.wrong} no_truth=${v.noTruth} accuracy=${
          v.accuracy_pct == null ? "n/a" : v.accuracy_pct + "%"
        }`
      );
    }
    console.log(
      `  Wrong-answer rate (strong-truth only): ${s.wrong_answer_rate.wrong_strong_truth_fills}/${s.wrong_answer_rate.strong_truth_fill_attempts} (${s.wrong_answer_rate.pct}%)`
    );
    console.log(`  Mean latency: ${s.mean_latency_ms == null ? "n/a" : s.mean_latency_ms + " ms"}`);
    console.log(`  Actual usage: ${s.actual_usage.summary}`);
    console.log(`  Trusted-host share: ${JSON.stringify(s.trusted_host_share)}`);
    console.log(`  Automation-friendliness: ${s.automation_friendliness.score}/5 - ${s.automation_friendliness.note}`);
    if (s.placeholder_discipline_violations.length) {
      console.log(`  DISCIPLINE VIOLATIONS: ${JSON.stringify(s.placeholder_discipline_violations)}`);
    } else {
      console.log(`  Placeholder discipline: PASSED (no fills claimed on all-zero placeholder rows)`);
    }
    console.log("");
  }
}

main();
