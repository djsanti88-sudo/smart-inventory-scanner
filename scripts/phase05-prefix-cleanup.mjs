// PHASE 0.5 - Gemini Flash-Lite cleanup TEST on a small sample of ambiguous/thin OFF prefixes.
// Gemini ONLY normalizes + clusters messy brand strings and cleans category labels. It does NOT decide
// truth, invent companies, guess the official GS1 owner, or use web/grounding. Thinking OFF. Batched.
// HARD budget guard stops before $10 (target < $2). Local only. No commit/deploy. No runtime code touched.
//
//   node --max-old-space-size=4096 scripts/phase05-prefix-cleanup.mjs [--sample 500] [--dry]
//
// --dry prints the plan + PROJECTED cost and makes ZERO API calls.

import fs from "node:fs";
import readline from "node:readline";

const INPUT = "data/retail-knowledge/retail_off.jsonl";
const OUT = "reports/product-intel/prefix-phase05-cleanup.json";
const MODEL = "gemini-flash-lite-latest"; // Flash-Lite ONLY (per owner)
const PREFIX_LEN = 7, BRAND_CAP = 60, CAT_CAP = 30, BATCH = 15;
const HARD_CAP_USD = 10, SOFT_TARGET_USD = 2;
const PRICE_IN = 0.10 / 1e6, PRICE_OUT = 0.40 / 1e6; // Flash-Lite per-token
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(arg("sample", "500"));
const DRY = args.includes("--dry");

function loadKey() {
  try {
    const env = fs.readFileSync(".env.local", "utf8");
    const m = env.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
function norm13(d) { return d.length === 12 ? "0" + d : d.length === 14 ? d.slice(1) : d; }
function firstCat(r) {
  const m = (r.main_category_en || "").trim(); if (m) return m.toLowerCase();
  const c = (r.categories_en || "").trim(); return c ? c.split(",")[0].trim().toLowerCase() : "";
}
function brandOf(r) { return ((r.brands || "").split(",")[0].trim() || (r.brand_owner || "").trim()).toLowerCase(); }
function topShare(map, total) { let t = 0, k = ""; for (const [kk, v] of map) if (v > t) { t = v; k = kk; } return { share: total ? t / total : 0, key: k }; }

// ---- pass 1: aggregate ----
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
const ambiguous = [], thin = [];
for (const [pre, e] of agg) {
  const c = classify(e);
  if (c === "ambiguous") ambiguous.push(pre);
  else if (c === "thin" && e.usable >= 3) thin.push(pre); // only thin with something to clean
}
ambiguous.sort(); thin.sort();
const pick = (arr, n) => { const step = Math.max(1, Math.floor(arr.length / n)); const out = []; for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]); return out; };
const nAmb = Math.round(SAMPLE * 0.7), nThin = SAMPLE - nAmb;
const sample = [...pick(ambiguous, nAmb).map((p) => ["ambiguous", p]), ...pick(thin, nThin).map((p) => ["thin", p])];

const payload = sample.map(([kind, pre]) => {
  const e = agg.get(pre);
  return { kind, prefix: pre, usableCount: e.usable,
    brands: [...e.brands.entries()].sort((a, b) => b[1] - a[1]),
    categories: [...e.cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };
});

const batches = Math.ceil(payload.length / BATCH);
const projTokIn = batches * 400 + payload.length * 180, projTokOut = payload.length * 130;
const projCost = projTokIn * PRICE_IN + projTokOut * PRICE_OUT;
console.log(`[phase0.5] ambiguous=${ambiguous.length} thin(>=3)=${thin.length} | sampling ${payload.length} (${pick(ambiguous, nAmb).length} amb + ${pick(thin, nThin).length} thin)`);
console.log(`[phase0.5] batches=${batches} projectedCost=$${projCost.toFixed(4)} (Flash-Lite, model=${MODEL}) hardCap=$${HARD_CAP_USD}`);
if (DRY) { console.log("[phase0.5] DRY RUN - no API calls made. $0 spent."); process.exit(0); }

const KEY = loadKey();
if (!KEY) { console.error("[phase0.5] No GEMINI_API_KEY in .env.local - cannot run. $0 spent."); process.exit(1); }

const SYS = `You are a STRICT data-cleaning function for barcode-prefix groups from OUR OWN product database.
For EACH prefix do ONLY this, using ONLY the strings provided (no outside/world knowledge, no GS1 ownership guessing, do not invent companies, do not merge clearly different companies):
1) clusters: group brand strings that are obviously the SAME company (case/spelling/punctuation/legal-suffix/alias variants). Each: {canonical, variants:[...], count: summed counts}.
2) cleanedCategories: dedupe/normalize the given category labels into a few.
3) privateLabelOrOem: boolean - does the brand mix look like one maker producing private-label/OEM for multiple retail brands?
4) ambiguityReason: ONE short sentence, based ONLY on the given data.
Return ONLY a JSON array, one object per input prefix: {prefix, clusters, cleanedCategories, privateLabelOrOem, ambiguityReason}.`;

async function callGemini(batch) {
  const body = {
    contents: [{ role: "user", parts: [{ text: SYS + "\n\nINPUT:\n" + JSON.stringify(batch) }] }],
    generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 4096, responseMimeType: "application/json" },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const txt = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
  const u = data?.usageMetadata ?? {};
  let parsed = []; try { parsed = JSON.parse(txt); } catch { parsed = []; }
  return { parsed: Array.isArray(parsed) ? parsed : [], inTok: u.promptTokenCount ?? 0, outTok: u.candidatesTokenCount ?? 0 };
}

const cleaned = new Map();
let accIn = 0, accOut = 0, accCost = 0, stopped = false, errs = 0;
for (let i = 0; i < payload.length; i += BATCH) {
  if (accCost >= HARD_CAP_USD) { stopped = true; break; }
  const batch = payload.slice(i, i + BATCH).map((p) => ({ prefix: p.prefix, brands: p.brands, categories: p.categories }));
  try {
    const r = await callGemini(batch);
    accIn += r.inTok; accOut += r.outTok; accCost = accIn * PRICE_IN + accOut * PRICE_OUT;
    for (const o of r.parsed) if (o && o.prefix) cleaned.set(String(o.prefix), o);
    process.stdout.write(`\r[phase0.5] batch ${Math.floor(i / BATCH) + 1}/${batches} spend=$${accCost.toFixed(4)}   `);
  } catch (e) { errs++; if (errs <= 3) console.error(`\n[phase0.5] batch error: ${e.message}`); }
}
console.log("");

// ---- recompute strength after cleanup ----
function reclassify(p, clean) {
  const e = agg.get(p.prefix);
  if (!clean || !Array.isArray(clean.clusters) || clean.clusters.length === 0) return { after: p.kind, topShare: topShare(e.brands, e.usable).share, clusters: e.brands.size };
  const counts = clean.clusters.map((c) => Number(c.count) || 0);
  const total = counts.reduce((a, b) => a + b, 0) || e.usable;
  const top = Math.max(...counts, 0);
  const share = total ? top / total : 0, distinct = clean.clusters.length;
  let after;
  if (e.usable < 10) after = "thin";
  else if (share >= 0.7 && distinct <= 3) after = "strong";
  else if (distinct >= 8 || share < 0.4) after = "ambiguous";
  else after = "moderate";
  return { after, topShare: share, clusters: distinct };
}
let ambToModerate = 0, ambToStrong = 0, thinImproved = 0, vetoEligible = 0;
const examples = [];
for (const p of payload) {
  const clean = cleaned.get(p.prefix);
  const before = p.kind, beforeShare = topShare(agg.get(p.prefix).brands, p.usableCount).share, beforeDistinct = agg.get(p.prefix).brands.size;
  const { after, topShare: afterShare, clusters } = reclassify(p, clean);
  if (before === "ambiguous" && after === "moderate") ambToModerate++;
  if (before === "ambiguous" && after === "strong") ambToStrong++;
  if (before === "thin" && after !== "thin") thinImproved++;
  if (after === "strong" && afterShare >= 0.8 && p.usableCount >= 20) vetoEligible++;
  if (examples.length < 8 && before === "ambiguous" && (after === "moderate" || after === "strong")) {
    examples.push({ prefix: p.prefix, usable: p.usableCount, before: `${before} (${beforeDistinct} brands, top ${(beforeShare * 100).toFixed(0)}%)`,
      after: `${after} (${clusters} clusters, top ${(afterShare * 100).toFixed(0)}%)`,
      sampleClusters: (clean?.clusters ?? []).slice(0, 3).map((c) => `${c.canonical}<=${(c.variants || []).slice(0, 3).join("|")}`),
      privateLabel: clean?.privateLabelOrOem ?? null });
  }
}

const report = {
  model: MODEL, sampleRequested: SAMPLE, sampleActual: payload.length,
  sampled: { ambiguous: payload.filter((p) => p.kind === "ambiguous").length, thin: payload.filter((p) => p.kind === "thin").length },
  spend: { inputTokens: accIn, outputTokens: accOut, costUSD: +accCost.toFixed(4), hardCapUSD: HARD_CAP_USD, stoppedAtBudget: stopped, batchErrors: errs },
  results: {
    ambiguous_to_moderate: ambToModerate, ambiguous_to_strong: ambToStrong,
    thin_improved: thinImproved, veto_eligible_after: vetoEligible,
    upgrade_rate_ambiguous: +(((ambToModerate + ambToStrong) / Math.max(1, payload.filter((p) => p.kind === "ambiguous").length)) * 100).toFixed(1),
  },
  population: { total_ambiguous: ambiguous.length, total_thin_ge3: thin.length },
  examples,
};
fs.mkdirSync("reports/product-intel", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\n[phase0.5] wrote ${OUT} | EXACT SPEND $${accCost.toFixed(4)}`);
