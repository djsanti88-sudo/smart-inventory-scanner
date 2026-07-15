#!/usr/bin/env node
// A4 (owner-ratified 2026-07-15, "trace every non-decode"): offline rollup over the append-only
// decode outcome ledger (decode-outcomes/<YYYY-MM>.jsonl, file mode). Reads the CURRENT month's
// ledger, prints per-rung settled counts, per-status totals, and the top 10 miss reasons, then
// writes reports/decode-outcomes-<YYYY-MM-DD>.md. Pure Node, zero deps, $0 cost.
//
// AM-5 TRIMMED SCOPE: no eval-candidate export (nondecode-candidates.jsonl is dropped this round -
// see the plan amendment). This script is READ-ONLY over the ledger; it never mutates it.
//
// Smoke test: running this against an empty/missing ledger prints "0 outcomes" and exits 0.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function currentMonthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Read + parse the month's JSONL ledger file. Corrupt lines are skipped (never throws). */
function readOutcomes(dir, monthKey) {
  const file = join(dir, "decode-outcomes", `${monthKey}.jsonl`);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // corrupt line: skip, never throw (mirrors storage.ts's readJson resilience posture)
    }
  }
  return out;
}

function topMissReasons(outcomes, limit = 10) {
  const counts = new Map();
  for (const o of outcomes) {
    const reasons = Array.isArray(o.reasons) ? o.reasons : [];
    for (const r of reasons) {
      const key = typeof r?.reason === "string" ? r.reason : String(r?.reason ?? "unknown");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function perRungSettledCounts(outcomes) {
  const counts = new Map();
  for (const o of outcomes) {
    const rung = o.settledBy ?? "(none)";
    counts.set(rung, (counts.get(rung) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function perStatusTotals(outcomes) {
  const counts = new Map();
  for (const o of outcomes) {
    const status = typeof o.status === "string" ? o.status : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function buildReport(outcomes, monthKey) {
  const rungCounts = perRungSettledCounts(outcomes);
  const statusCounts = perStatusTotals(outcomes);
  const missReasons = topMissReasons(outcomes);

  const lines = [];
  lines.push(`# Decode Outcomes Report - ${monthKey}`);
  lines.push("");
  lines.push(`Total outcomes: ${outcomes.length}`);
  lines.push("");
  lines.push("## Settled-by rung (settled counts)");
  lines.push("");
  if (rungCounts.length === 0) {
    lines.push("(no outcomes)");
  } else {
    lines.push("| rung | count |");
    lines.push("| --- | --- |");
    for (const [rung, count] of rungCounts) lines.push(`| ${rung} | ${count} |`);
  }
  lines.push("");
  lines.push("## Per-status totals");
  lines.push("");
  if (statusCounts.length === 0) {
    lines.push("(no outcomes)");
  } else {
    lines.push("| status | count |");
    lines.push("| --- | --- |");
    for (const [status, count] of statusCounts) lines.push(`| ${status} | ${count} |`);
  }
  lines.push("");
  lines.push("## Top 10 miss reasons");
  lines.push("");
  if (missReasons.length === 0) {
    lines.push("(no miss reasons recorded)");
  } else {
    lines.push("| reason | count |");
    lines.push("| --- | --- |");
    for (const [reason, count] of missReasons) lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const dir = process.cwd();
  const monthKey = currentMonthKey();
  const outcomes = readOutcomes(dir, monthKey);

  console.log(`${outcomes.length} outcomes`);
  if (outcomes.length > 0) {
    console.log("Settled-by rung:", Object.fromEntries(perRungSettledCounts(outcomes)));
    console.log("Per-status totals:", Object.fromEntries(perStatusTotals(outcomes)));
    console.log("Top miss reasons:", topMissReasons(outcomes));
  }

  const reportsDir = join(dir, "reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `decode-outcomes-${todayKey()}.md`);
  writeFileSync(reportPath, buildReport(outcomes, monthKey), "utf8");
  console.log(`Report written: ${reportPath}`);
}

main();
