import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LANES = 20;
const UI_EVENTS = 13_346;
const CANONICAL_GROUPS = 5_316;
const WARM_P95_MS = 500;
const WARM_P99_MS = 750;
const MAX_MS = 2_000;
const CALIBRATION_SCANS_PER_LANE = 4;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}

function attachmentJson(attachment) {
  const body = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : null);
  if (!body) return null;
  try { return JSON.parse(Buffer.from(body).toString("utf8")); } catch { return null; }
}

export function summarizePreviewResults(results, expectedTotal) {
  const counts = { passed: 0, failed: 0, skipped: 0, interrupted: 0, timedOut: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const complete = expectedTotal > 0 && results.length === expectedTotal && counts.passed === expectedTotal && !counts.failed && !counts.skipped && !counts.interrupted && !counts.timedOut;
  return { counts, complete };
}

export function summarizePreviewAttachments(results) {
  const laneIds = new Set(); const fingerprints = new Set();
  const totals = { lanes: 0, uiEvents: 0, canonicalGroups: 0, unexpectedEgress: 0, coldLatencyP95Ms: Number.POSITIVE_INFINITY, coldLatencyMaxMs: Number.POSITIVE_INFINITY, warmP95Ms: Number.POSITIVE_INFINITY, warmP99Ms: Number.POSITIVE_INFINITY, warmMaxMs: Number.POSITIVE_INFINITY };
  const coldLatencies = []; const warmLatencies = [];
  for (const result of results) for (const attachment of result.attachments ?? []) {
    const payload = attachmentJson(attachment);
    if (attachment.name === "boss-preview-lane-summary") {
      if (!payload || !Number.isInteger(payload.lane) || payload.lane < 0 || payload.lane >= LANES || laneIds.has(payload.lane) ||
          !Number.isInteger(payload.uiEvents) || !Number.isInteger(payload.canonicalGroups) || !/^[a-f\d]{64}$/i.test(String(payload.fingerprint ?? "")) ||
          !Number.isInteger(payload.unexpectedEgress) || payload.unauthenticatedStatus !== 401 || payload.crossTenantStatus !== 403 || !Number.isFinite(payload.coldLatencyMs) || !Array.isArray(payload.warmLatenciesMs) || payload.warmLatenciesMs.length !== Math.min(CALIBRATION_SCANS_PER_LANE, payload.uiEvents) - 1 || payload.warmLatenciesMs.some((value) => !Number.isFinite(value) || value < 0) || payload.coldLatencyMs < 0) continue;
      laneIds.add(payload.lane); fingerprints.add(payload.fingerprint);
      totals.lanes++; totals.uiEvents += payload.uiEvents; totals.canonicalGroups += payload.canonicalGroups;
      totals.unexpectedEgress += payload.unexpectedEgress; coldLatencies.push(payload.coldLatencyMs); warmLatencies.push(...payload.warmLatenciesMs);
    }
  }
  totals.coldLatencyP95Ms = percentile(coldLatencies, 0.95); totals.coldLatencyMaxMs = Math.max(...coldLatencies);
  totals.warmP95Ms = percentile(warmLatencies, 0.95); totals.warmP99Ms = percentile(warmLatencies, 0.99); totals.warmMaxMs = Math.max(...warmLatencies);
  const complete = totals.lanes === LANES && totals.uiEvents === UI_EVENTS && totals.canonicalGroups === CANONICAL_GROUPS &&
    fingerprints.size === 1 && totals.unexpectedEgress === 0 && totals.coldLatencyP95Ms <= MAX_MS && totals.coldLatencyMaxMs <= MAX_MS && totals.warmP95Ms <= WARM_P95_MS && totals.warmP99Ms <= WARM_P99_MS && totals.warmMaxMs <= MAX_MS;
  return { totals, fingerprint: fingerprints.size === 1 ? [...fingerprints][0] : null, complete };
}

export const previewReporterDraftPath = (runId) => resolve("outputs/boss-barcode-certification/preview-runs", `${runId}.reporter-draft.json`);

export default class BossPreviewReporter {
  onBegin(_config, suite) { this.startedAt = Date.now(); this.expected = suite.allTests().length; this.results = []; this.failures = []; }
  onTestEnd(test, result) { this.results.push(result); if (result.status !== "passed") this.failures.push(`${test.title}: ${result.status}`); }
  onEnd(result) {
    const tests = summarizePreviewResults(this.results, this.expected);
    const evidence = summarizePreviewAttachments(this.results);
    const runId = process.env.BOSS_PREVIEW_RUN_ID ?? "";
    if (!/^boss-preview-[a-z0-9-]{16,64}-\d{3}$/.test(runId)) throw new Error("Preview reporter run id is invalid.");
    const draft = {
      schemaVersion: "1.0.0", runStatus: result.status, startedAtMs: this.startedAt,
      testsExpected: this.expected, testsObserved: this.results.length, tests: tests.counts,
      evidence, failures: this.failures,
    };
    const target = previewReporterDraftPath(runId); mkdirSync(resolve(target, ".."), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", flag: "w" }); renameSync(temp, target);
  }
}
