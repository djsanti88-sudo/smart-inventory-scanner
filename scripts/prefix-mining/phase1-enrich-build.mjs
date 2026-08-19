// PHASE 1 - enrich ALL ambiguous OFF prefixes with Gemini Flash-Lite (normalize/cluster ONLY), recompute
// strength, and BUILD the runtime prefix map (strong + moderate + recovered) -> src/services/catalog/
// derivedPrefixMap.json. Flash-Lite only, thinking OFF, no grounding/web, batched + concurrent.
// HARD STOP at $3 (target <$2). Prints running spend. Local only. No commit/deploy. Curated seed stays in
// prefixIndex.ts and is NOT overwritten here. Thin prefixes are NOT enriched (Phase 0.5 showed 0%).
//
// LANE SEPARATION (owner doctrine, CLAUDE.md "Delegation Model Policy"): this is Lane 1 DEV TOOLING.
// It never reads .env.local's GEMINI_API_KEY (Lane 2's key, the app runtime's decode ladder,
// exclusively) - it reads PHASE1_GEMINI_KEY, a separately-named dev-tooling var the owner must set
// deliberately, via scripts/lib/paidScriptGuard.mjs.
//
//   node --max-old-space-size=4096 scripts/phase1-enrich-build.mjs
//
// Default is a DRY RUN: prints the plan + a worst-case cost FLOOR, makes ZERO API calls, writes no
// map, $0 spent. Only spends (and writes the map) with BOTH --live and --yes-i-accept-cost, and only
// after PHASE1_GEMINI_KEY is set.

import fs from "node:fs";
import readline from "node:readline";
import { requireLiveApproval, requireDevToolingKey } from "../lib/paidScriptGuard.mjs";

const INPUT = "data/retail-knowledge/retail_off.jsonl";
const OUT_MAP = "src/services/catalog/derivedPrefixMap.json";
const OUT_REPORT = "reports/product-intel/prefix-phase1-build.json";
const MODEL = "gemini-flash-lite-latest";
const PREFIX_LEN = 7, BRAND_CAP = 60, CAT_CAP = 30, BATCH = 20, CONCURRENCY = 8;
const HARD_STOP_USD = 3, TARGET_USD = 2;
const PRICE_IN = 0.10 / 1e6, PRICE_OUT = 0.40 / 1e6;
function norm13(d) { return d.length === 12 ? "0" + d : d.length === 14 ? d.slice(1) : d; }
function firstCat(r) { const m = (r.main_category_en || "").trim(); if (m) return m.toLowerCase(); const c = (r.categories_en || "").trim(); return c ? c.split(",")[0].trim().toLowerCase() : ""; }
function brandOf(r) { return ((r.brands || "").split(",")[0].trim() || (r.brand_owner || "").trim()).toLowerCase(); }
function topShare(map, total) { let t = 0, k = ""; for (const [kk, v] of map) if (v > t) { t = v; k = kk; } return { share: total ? t / total : 0, key: k, count: t }; }
function topCats(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }

console.log("[phase1] streaming + aggregating 4M rows...");
const agg = new Map();
const rl = readline.createInterface({ input: fs.createReadStream(INPUT, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  const d = String(r.code || "").replace(/\D/g, "");
  if (![12, 13, 14].includes(d.length) || new Set(d).size === 1) continue;
  const pre = norm13(d).slice(0, PREFIX_LEN);
  if (pre.length < PREFIX_LEN) continue;
  const name = (r.product_name || "").trim(), brand = brandOf(r), cat = firstCat(r);
  let e = agg.get(pre); if (!e) { e = { usable: 0, brands: new Map(), cats: new Map(), bOver: false }; agg.set(pre, e); }
  if (name && brand) {
    e.usable++;
    if (e.brands.has(brand)) e.brands.set(brand, e.brands.get(brand) + 1); else if (e.brands.size < BRAND_CAP) e.brands.set(brand, 1); else e.bOver = true;
    if (cat) { if (e.cats.has(cat)) e.cats.set(cat, e.cats.get(cat) + 1); else if (e.cats.size < CAT_CAP) e.cats.set(cat, 1); }
  }
}
function classify(e) {
  if (e.usable < 10) return "thin";
  const tb = topShare(e.brands, e.usable), distinct = e.brands.size + (e.bOver ? 1 : 0);
  if (tb.share >= 0.7 && distinct <= 3 && !e.bOver) return "strong";
  if (e.bOver || distinct >= 8 || tb.share < 0.4) return "ambiguous";
  return "moderate";
}
const strong = [], moderate = [], ambiguous = [];
for (const [pre, e] of agg) { const c = classify(e); if (c === "strong") strong.push(pre); else if (c === "moderate") moderate.push(pre); else if (c === "ambiguous") ambiguous.push(pre); }
console.log(`[phase1] strong=${strong.length} moderate=${moderate.length} ambiguous=${ambiguous.length} (enriching ambiguous only)`);
const projOut = ambiguous.length * 130, projIn = Math.ceil(ambiguous.length / BATCH) * 400 + ambiguous.length * 200;
const projCost = projIn * PRICE_IN + projOut * PRICE_OUT;
console.log(`[phase1] hardStop=$${HARD_STOP_USD}`);

const approval = requireLiveApproval({
  worstCaseFloorUsd: projCost,
  describe: () => `[phase1] Would enrich ${ambiguous.length} ambiguous prefixes via Gemini Flash-Lite (${MODEL}), then write ${OUT_MAP}. Projected cost ~$${projCost.toFixed(3)}.`,
});
if (!approval.live) process.exit(0); // requireLiveApproval already printed the dry-run report and exits 0

const KEY = requireDevToolingKey("PHASE1_GEMINI_KEY");

const SYS = `You are a STRICT data-cleaning function for barcode-prefix groups from OUR OWN product database.
For EACH prefix do ONLY this, using ONLY the strings provided (no outside/world knowledge, no GS1 ownership guessing, do not invent companies, do not merge clearly different companies):
1) clusters: group brand strings that are obviously the SAME company (case/spelling/punctuation/legal-suffix/alias variants). Each: {canonical, variants:[...], count: summed counts}.
2) cleanedCategories: dedupe/normalize the given category labels into a few.
3) privateLabelOrOem: boolean.
4) ambiguityReason: ONE short sentence based ONLY on the given data.
Return ONLY a JSON array, one object per input prefix: {prefix, clusters, cleanedCategories, privateLabelOrOem, ambiguityReason}.`;

async function callGemini(batch) {
  const body = { contents: [{ role: "user", parts: [{ text: SYS + "\n\nINPUT:\n" + JSON.stringify(batch) }] }], generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 8192, responseMimeType: "application/json" } };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const txt = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
  const u = data?.usageMetadata ?? {};
  let parsed = []; try { parsed = JSON.parse(txt); } catch { parsed = []; }
  return { parsed: Array.isArray(parsed) ? parsed : [], inTok: u.promptTokenCount ?? 0, outTok: u.candidatesTokenCount ?? 0 };
}
const toPayload = (pre) => { const e = agg.get(pre); return { prefix: pre, brands: [...e.brands.entries()].sort((a, b) => b[1] - a[1]), categories: topCats(e.cats, 6) }; };

const cleaned = new Map();
let accIn = 0, accOut = 0, accCost = 0, done = 0, errs = 0, stopped = false, cursor = 0;
async function worker() {
  while (true) {
    if (accCost >= HARD_STOP_USD) { stopped = true; return; }
    const i = cursor; cursor += BATCH;
    if (i >= ambiguous.length) return;
    const slice = ambiguous.slice(i, i + BATCH);
    try {
      const r = await callGemini(slice.map(toPayload));
      accIn += r.inTok; accOut += r.outTok; accCost = accIn * PRICE_IN + accOut * PRICE_OUT;
      for (const o of r.parsed) if (o && o.prefix) cleaned.set(String(o.prefix), o);
    } catch { errs++; }
    done += slice.length;
    if (done % 400 < BATCH) process.stdout.write(`\r[phase1] enriched ~${done}/${ambiguous.length} spend=$${accCost.toFixed(4)} errs=${errs}   `);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\n[phase1] enrichment done. spend=$${accCost.toFixed(4)} stoppedAtCap=${stopped} errs=${errs}`);

// recompute ambiguous strength from clusters
let recStrong = 0, recModerate = 0;
const recovered = new Map(); // prefix -> {after, clusters, share}
for (const pre of ambiguous) {
  const c = cleaned.get(pre); const e = agg.get(pre);
  if (!c || !Array.isArray(c.clusters) || c.clusters.length === 0) continue;
  const counts = c.clusters.map((x) => Number(x.count) || 0);
  const total = counts.reduce((a, b) => a + b, 0) || e.usable;
  const top = Math.max(...counts, 0), share = total ? top / total : 0, distinct = c.clusters.length;
  let after = "ambiguous";
  if (share >= 0.7 && distinct <= 3) after = "strong"; else if (distinct < 8 && share >= 0.4) after = "moderate";
  if (after === "strong") recStrong++; else if (after === "moderate") recModerate++;
  if (after !== "ambiguous") recovered.set(pre, { after, clusters: c.clusters, share, distinct });
}
console.log(`[phase1] recovered: strong=${recStrong} moderate=${recModerate}`);

// build runtime map (PrefixEntry shape, GTIN-13 7-digit keys)
function rawEntry(pre, tier) {
  const e = agg.get(pre);
  const brands = [...e.brands.entries()].sort((a, b) => b[1] - a[1]);
  const cats = topCats(e.cats, 3).map(([k]) => k);
  const candidates = brands.slice(0, 4).map(([name, count]) => ({ name, kind: "manufacturer", productCount: count, confidence: +(count / e.usable).toFixed(3), categories: cats }));
  const ts = topShare(e.brands, e.usable);
  const catDist = {}; for (const [k, v] of topCats(e.cats, 3)) catDist[k] = v;
  return { prefix: pre, candidates, dominant: ts.share >= 0.5 ? candidates[0] : null, productCount: e.usable, categoryDist: catDist, countryHints: [], confidence: +ts.share.toFixed(3), ambiguity: +(1 - ts.share).toFixed(3), source: "derived_catalog", tier };
}
function recoveredEntry(pre, rec) {
  const e = agg.get(pre);
  const cats = topCats(e.cats, 3).map(([k]) => k);
  const total = rec.clusters.reduce((a, c) => a + (Number(c.count) || 0), 0) || e.usable;
  const candidates = rec.clusters.slice(0, 4).map((c) => ({ name: String(c.canonical || "").toLowerCase(), kind: "manufacturer", productCount: Number(c.count) || 0, confidence: +(((Number(c.count) || 0) / total)).toFixed(3), categories: cats }));
  const catDist = {}; for (const [k, v] of topCats(e.cats, 3)) catDist[k] = v;
  return { prefix: pre, candidates, dominant: rec.share >= 0.5 ? candidates[0] : null, productCount: e.usable, categoryDist: catDist, countryHints: [], confidence: +rec.share.toFixed(3), ambiguity: +(1 - rec.share).toFixed(3), source: "derived_catalog", tier: rec.after, notes: "recovered via alias cleanup (Flash-Lite, normalization only)" };
}
const map = {};
for (const pre of strong) map[pre] = rawEntry(pre, "strong");
for (const pre of moderate) map[pre] = rawEntry(pre, "moderate");
for (const [pre, rec] of recovered) map[pre] = recoveredEntry(pre, rec);
fs.writeFileSync(OUT_MAP, JSON.stringify(map));
const mapBytes = fs.statSync(OUT_MAP).size;

const report = {
  model: MODEL, prefixesEnriched: ambiguous.length - (stopped ? (ambiguous.length - cursor) : 0),
  spend: { inputTokens: accIn, outputTokens: accOut, costUSD: +accCost.toFixed(4), targetUSD: TARGET_USD, hardStopUSD: HARD_STOP_USD, stoppedAtCap: stopped, batchErrors: errs },
  classified: { strong: strong.length, moderate: moderate.length, ambiguous: ambiguous.length },
  recovered: { strong: recStrong, moderate: recModerate, total: recStrong + recModerate },
  runtimeIndex: { entries: Object.keys(map).length, fileBytes: mapBytes, fileMB: +(mapBytes / 1048576).toFixed(2), composition: { strong: strong.length, moderate: moderate.length, recovered: recovered.size } },
  examples: [...recovered.entries()].slice(0, 6).map(([pre, r]) => ({ prefix: pre, after: r.after, topShare: +r.share.toFixed(2), clusters: r.clusters.slice(0, 3).map((c) => `${c.canonical}<=${(c.variants || []).slice(0, 3).join("|")}`) })),
  coverageLimit: "Open Food Facts = food/grocery only. No hardware/housewares/fans/tires. Curated seed (0051596 United Solutions, 0792145 King of Fans) covers the bucket/fan case; broad non-food coverage needs a licensed GS1-style source.",
};
fs.mkdirSync("reports/product-intel", { recursive: true });
fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\n[phase1] wrote ${OUT_MAP} (${report.runtimeIndex.fileMB} MB) + ${OUT_REPORT} | EXACT SPEND $${accCost.toFixed(4)}`);
