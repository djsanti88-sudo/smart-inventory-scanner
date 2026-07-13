// One-shot: rebuild tmp-ladder-dryrun-results.json from the crashed live run's console log so the
// fixed probe can RESUME without re-spending. Reconstructed rows lack stage detail; we infer the
// verify path from cost (cheap verify spends ~<$0.02; a gpt-5.5 escalation adds >=$0.05) and mark
// every row reconstructed:true so the grader can disclose the inference.
import { readFileSync, writeFileSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath) { console.error("usage: node tmp-ladder-log-reconstruct.mjs <crashed-run-log>"); process.exit(1); }
const fixture = JSON.parse(readFileSync(new URL("../e2e/fixtures/dryrun-codes.json", import.meta.url), "utf8")).codes;
const truthOf = Object.fromEntries(fixture.map((r) => [r.code, r]));

const LINE_RE = /^\[(\w+)\] (\S+) -> (verified|suggested|refused)(?: "(.*)")? \| expected (\S+) \| \$([\d.]+) \| ([\d.]+)s \| spent \$([\d.]+)$/;
const rows = [];
let lastSpent = 0;
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  const m = line.match(LINE_RE);
  if (!m) continue;
  const [, group, code, outcome, product = "", expected, cost, secs, spent] = m;
  const fx = truthOf[code] ?? {};
  rows.push({
    code, group, expected, truth: fx.truth ?? "", codeType: fx.codeType ?? "",
    outcome, product, cost: Number(cost), secs: Number(secs),
    guessConfidence: outcome === "suggested" ? 0.4 : undefined,
    stageInferred: outcome === "verified" ? (Number(cost) < 0.02 ? "cheap" : "escalated") : Number(cost) >= 0.05 ? "escalated" : "cheap",
    reconstructed: true,
  });
  lastSpent = Number(spent);
}
writeFileSync(new URL("./tmp-ladder-dryrun-results.json", import.meta.url), JSON.stringify({ spent: lastSpent, rows }, null, 2));
console.log(`reconstructed ${rows.length} rows, spent carried forward $${lastSpent.toFixed(2)}`);
