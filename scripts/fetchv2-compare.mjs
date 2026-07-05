// Fetch V2 (web-only) vs AI winners comparison over the 150-code fixture.
// Joins: scripts/fetchv2-web-results.json (Fetch V2, $0 web)
//      + scripts/tmp-gemini-probe-results.json (gemini-3.5-flash, 84 codes)
//      + scripts/tmp-pro-probe2-results.json  (gpt-5.5, 84 codes)
//      + scripts/tmp-ladder-dryrun-results.json (deployed cheap ladder, 150 codes, pre-fix run)
// Identity correctness uses the grader's word-overlap rule; the known trap (generic brand/category
// words masking identity swaps) means VERIFIED lists must still be manually spot-checked.
// Usage: node scripts/fetchv2-compare.mjs
import { readFileSync, writeFileSync } from "node:fs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const v2 = load("./fetchv2-web-results.json").rows;
const gem = load("./tmp-gemini-probe-results.json");
const gpt = load("./tmp-pro-probe2-results.json");
const ladder = load("./tmp-ladder-dryrun-results.json").rows;
const gemRows = Array.isArray(gem) ? gem : gem.rows;
const gptRows = Array.isArray(gpt) ? gpt : gpt.rows;

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
const overlap = (a, b) => { const A = new Set(norm(a)); return norm(b).filter((w) => A.has(w)).length; };
const matches = (truth, name) => (name ? overlap(truth, name) >= 2 : false);

const byCode = new Map(v2.map((r) => [r.code, r]));
const median = (ns) => { const s = [...ns].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function scoreModel(rows, { codeKey = "code", nameOf, secsOf, costOf, offeredOf }) {
  const joined = rows.filter((r) => byCode.has(r[codeKey]));
  const stats = { n: joined.length, offered: 0, correct: 0, wrong: 0, canaryOffered: 0, medianSecs: 0, totalCost: 0 };
  const secs = [];
  for (const r of joined) {
    const fx = byCode.get(r[codeKey]);
    const name = nameOf(r);
    const offered = offeredOf ? offeredOf(r) : !!name;
    secs.push(secsOf(r) ?? 0);
    stats.totalCost += costOf(r) ?? 0;
    if (fx.group === "canary") { if (offered) stats.canaryOffered++; continue; }
    if (!offered) continue;
    stats.offered++;
    if (matches(fx.truth, name)) stats.correct++; else stats.wrong++;
  }
  stats.medianSecs = +median(secs).toFixed(2);
  stats.totalCost = +stats.totalCost.toFixed(4);
  return stats;
}

// Fetch V2: verified = auto-count claim; suggested = surfaced candidate.
const v2Verified = v2.filter((r) => r.outcome === "verified");
const v2Stats = {
  n: v2.length,
  verified: v2Verified.length,
  verifiedCorrect: v2Verified.filter((r) => matches(r.truth, r.product)).length,
  verifiedWrong: v2Verified.filter((r) => !matches(r.truth, r.product)).map((r) => ({ code: r.code, product: r.product, truth: r.truth, source: r.winningSource })),
  suggested: v2.filter((r) => r.outcome === "suggested").length,
  suggestedCorrect: v2.filter((r) => r.outcome === "suggested" && matches(r.truth, r.product)).length,
  canaryVerified: v2.filter((r) => r.group === "canary" && r.outcome === "verified").length,
  canarySuggested: v2.filter((r) => r.group === "canary" && r.outcome === "suggested").length,
  refused: v2.filter((r) => r.outcome === "refused").length,
  errors: v2.filter((r) => r.outcome === "error").length,
  medianSecs: median(v2.map((r) => r.secs)),
  totalCostUsd: 0, // brave free tier; firecrawl spend reported by the benchmark run itself
};

// Findable = expected verified-ok or suggest-only with a real truth (matches the dry-run recall base).
const findable = v2.filter((r) => r.group !== "canary" && r.group !== "fnsku" && r.expected !== "must-refuse");
v2Stats.recallOnFindable = `${v2.filter((r) => findable.includes(r) && (r.outcome === "verified" || r.outcome === "suggested") && matches(r.truth, r.product)).length}/${findable.length}`;

const gemStats = scoreModel(gemRows, { nameOf: (r) => r.found ? `${r.found.brand ?? ""} ${r.found.productName ?? ""}` : "", secsOf: (r) => r.secs, costOf: (r) => r.cost, offeredOf: (r) => !!(r.found && r.found.productName) });
const gptStats = scoreModel(gptRows, { nameOf: (r) => r.found ? `${r.found.brand ?? ""} ${r.found.productName ?? ""}` : "", secsOf: (r) => r.secs, costOf: (r) => r.cost, offeredOf: (r) => !!(r.found && r.found.productName) });
const ladderStats = scoreModel(ladder, { nameOf: (r) => r.product, secsOf: (r) => r.secs, costOf: (r) => r.cost, offeredOf: (r) => r.outcome === "verified" || r.outcome === "suggested" });

const out = { generatedAt: "2026-07-04", fetchV2: v2Stats, geminiFlash35_claimsUnverified: gemStats, gpt55_claimsUnverified: gptStats, ladderPreFix: ladderStats };
writeFileSync(new URL("./fetchv2-compare-summary.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
