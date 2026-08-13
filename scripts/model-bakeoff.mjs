// Model bakeoff: which model decodes a tire barcode to FULL specs (incl. size) from its own knowledge?
// Parametric only (no page fetch) - this isolates raw model capability, the gap the measurement found.
// Runs a fixed set of HARD tires (spec-less / no-web-presence, with corpus ground truth) through each model
// and scores: got-size, size-correct, brand-correct, latency, est cost.
//
// LANE SEPARATION (owner doctrine, CLAUDE.md "Delegation Model Policy", 2026-07-26): this is Lane 1 DEV
// TOOLING. It must NEVER read .env.local's OPENAI_API_KEY/GEMINI_API_KEY - those keys belong exclusively
// to Lane 2, the app runtime's decode ladder. A prior version of this script read .env.local directly and
// fired ~50 live paid calls on a bare `node scripts/model-bakeoff.mjs` with no flag and no warning; that
// caused a real owner charge (2026-07-26). This version:
//   1. Reads keys ONLY from BAKEOFF_OPENAI_KEY / BAKEOFF_GEMINI_KEY - separately named vars the owner must
//      set deliberately for this run. It never opens or parses .env.local.
//   2. Defaults to a DRY RUN: prints exactly which models and how many calls WOULD be made, and a
//      worst-case cost floor, then exits 0 having spent nothing.
//   3. Only calls live providers with BOTH `--live` AND `--yes-i-accept-cost` passed explicitly (no
//      interactive prompt - this repo's tooling runs non-interactively and a prompt would hang).
//   4. Reports cost as a computed FLOOR, never a final number (Paid API Cost Truth Rule, CLAUDE.md):
//      true spend must be read from the provider billing console.
//
// Usage:
//   node scripts/model-bakeoff.mjs [--count=10]                                    (dry run, $0, always safe)
//   BAKEOFF_OPENAI_KEY=... BAKEOFF_GEMINI_KEY=... node scripts/model-bakeoff.mjs --live --yes-i-accept-cost [--count=10]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const has = (n) => process.argv.includes(`--${n}`);
const COUNT = Number(arg("count", "10"));
const LIVE = has("live");
const ACCEPT_COST = has("yes-i-accept-cost");

// price per 1M tokens [input, output] - ESTIMATES for cost comparison, label as such.
const MODELS = [
  { id: "gemini-flash-lite-latest", provider: "gemini", label: "Gemini Flash-Lite (current)", price: [0.10, 0.40] },
  { id: "gemini-2.5-flash", provider: "gemini", label: "Gemini 2.5 Flash", price: [0.30, 2.50] },
  { id: "gemini-2.5-pro", provider: "gemini", label: "Gemini 2.5 Pro", price: [1.25, 10.0] },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini (current)", price: [0.25, 2.0] },
  { id: "gpt-5", provider: "openai", label: "GPT-5", price: [1.25, 10.0] },
];

// HARD barcodes (spec-less or no-web-presence in the live measurement). Ground truth comes from the corpus.
const HARD = [
  "4981910567783", "4981910521921", "054137082408", "6959655455755", "6419440443508",
  "8994234021233", "029142908500", "051342174706", "990498649365", "990498664993",
];

// Worst-case per-call token assumptions for the dry-run cost FLOOR (this prompt + a JSON reply is small,
// but we deliberately over-estimate per the Paid API Cost Truth Rule: budget worst case, not the average).
const WORST_CASE_INPUT_TOKENS = 600;
const WORST_CASE_OUTPUT_TOKENS = 1200;

function parseCSV(text) { const rows = []; let i = 0, f = "", row = [], q = false; while (i < text.length) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; } if (c === '"') { q = true; i++; continue; } if (c === ",") { row.push(f); f = ""; i++; continue; } if (c === "\r") { i++; continue; } if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; } f += c; i++; } if (f.length || row.length) { row.push(f); rows.push(row); } return rows; }
const brandNorm = (b) => String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function sizeToken(s) { if (!s) return ""; const t = String(s).toUpperCase(); const m = t.match(/\b(LT|P|ST)?\d{3}\/\d{2}\s?(Z?R|-)\s?\d{2}\b/) || t.match(/\b\d{2}(\.\d)?(X\d{2}(\.\d)?)?R\d{2}(\.\d)?\b/); return m ? m[0].replace(/\s+/g, "").replace(/(\d{2})-(\d{2})$/, "$1R$2") : ""; }

function loadSample() {
  const rows = parseCSV(fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8"));
  const h = rows[0].map((x) => x.trim());
  const bi = h.indexOf("brand"), mi = h.indexOf("model"), si = h.indexOf("size_canonical"), ci = h.indexOf("barcode");
  const truth = new Map();
  for (const r of rows.slice(1)) { const code = (r[ci] || "").trim(); if (code && !truth.has(code)) truth.set(code, { brand: (r[bi] || "").trim(), model: (r[mi] || "").trim(), size: (r[si] || "").trim() }); }
  return HARD.slice(0, COUNT).map((code) => ({ code, ...(truth.get(code) || {}) })).filter((t) => t.brand);
}

const prompt = (code, type) =>
  `You are an expert at identifying tires from a retail barcode (UPC/EAN). Identify the EXACT tire product for barcode ${code} (type ${type}). Reply ONLY as JSON: {"brand":"","model":"","size":"265/70R17","loadIndex":"115","speedRating":"T","confidence":0.0}. Use standard tire size format (265/70R17, LT265/70R17, 35X12.50R20). If you do not know a field, use null. Do not invent a size you are unsure of.`;

async function callModel(m, code, type, keys) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 45000);
  const p = prompt(code, type);
  try {
    if (m.provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${keys.gemini}`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } }), signal: ctrl.signal });
      const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
      const u = d.usageMetadata || {};
      return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || "", inTok: u.promptTokenCount || 0, outTok: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    }
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.openai}` }, body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: p }], response_format: { type: "json_object" } }), signal: ctrl.signal });
    const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
    const u = d.usage || {};
    return { text: d.choices?.[0]?.message?.content || "", inTok: u.prompt_tokens || 0, outTok: u.completion_tokens || 0 };
  } finally { clearTimeout(to); }
}
function parseJson(t) { try { return JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); if (m) try { return JSON.parse(m[0]); } catch {} return null; } }

function worstCaseFloor(sample) {
  let total = 0;
  for (const m of MODELS) total += sample.length * (WORST_CASE_INPUT_TOKENS / 1e6 * m.price[0] + WORST_CASE_OUTPUT_TOKENS / 1e6 * m.price[1]);
  return total;
}

function printDryRun(sample) {
  const calls = sample.length * MODELS.length;
  const floor = worstCaseFloor(sample);
  console.log("Bakeoff DRY RUN - no calls made, $0 spent.\n");
  console.log(`Would run ${sample.length} HARD tires x ${MODELS.length} models = ${calls} live paid calls against:`);
  for (const m of MODELS) console.log(`  - ${m.label} (${m.provider}, ${m.id})`);
  console.log(`\nComputed worst-case cost FLOOR: $${floor.toFixed(3)} (assumes ${WORST_CASE_INPUT_TOKENS} in / ${WORST_CASE_OUTPUT_TOKENS} out tokens per call at public per-token pricing).`);
  console.log("This is a FLOOR, not a final number - per the Paid API Cost Truth Rule, true spend must be read from each provider's own billing console, never computed from response metadata alone.");
  console.log("\nTo actually run this and spend real money:");
  console.log("  1. Set BAKEOFF_OPENAI_KEY and BAKEOFF_GEMINI_KEY (dev-tooling-only keys - NEVER read from .env.local; that key is Lane 2's, the app runtime's decode ladder, exclusively).");
  console.log("  2. Re-run with both --live and --yes-i-accept-cost.");
}

async function runLive(sample, keys) {
  console.log(`Bakeoff: ${sample.length} HARD tires x ${MODELS.length} models (parametric decode, no page fetch)`);
  console.log(`LIVE RUN - real paid calls will be made. Computed worst-case floor: $${worstCaseFloor(sample).toFixed(3)} (see notes above; not a final number).\n`);
  const agg = {};
  for (const m of MODELS) agg[m.id] = { label: m.label, gotSize: 0, sizeOk: 0, brandOk: 0, ms: [], cost: 0, errors: 0 };
  for (const t of sample) {
    const type = t.code.length === 13 ? "ean_13" : "upc_a";
    const trueSize = sizeToken(t.size);
    console.log(`\n${t.code}  truth: ${t.brand} ${t.model} ${t.size}`);
    for (const m of MODELS) {
      const t0 = Date.now();
      try {
        const res = await callModel(m, t.code, type, keys);
        const ms = Date.now() - t0;
        const j = parseJson(res.text) || {};
        const mSize = sizeToken(j.size);
        const gotSize = !!mSize, sizeOk = gotSize && trueSize && mSize === trueSize;
        const brandOk = j.brand ? brandNorm(t.brand).includes(brandNorm(j.brand)) || brandNorm(j.brand).includes(brandNorm(t.brand)) : false;
        const cost = res.inTok / 1e6 * m.price[0] + res.outTok / 1e6 * m.price[1];
        const a = agg[m.id]; if (gotSize) a.gotSize++; if (sizeOk) a.sizeOk++; if (brandOk) a.brandOk++; a.ms.push(ms); a.cost += cost;
        console.log(`  ${m.label.padEnd(28)} ${String(ms).padStart(6)}ms  brand:${brandOk ? "Y" : "-"} size:${mSize || "-"} ${sizeOk ? "OK" : (gotSize ? "WRONG" : "none")}  $${cost.toFixed(4)}`);
      } catch (e) { agg[m.id].errors++; console.log(`  ${m.label.padEnd(28)} ERROR ${String(e.message || e).slice(0, 50)}`); }
    }
  }
  const n = sample.length;
  const pct = (x) => `${Math.round((100 * x) / n)}%`;
  const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  console.log(`\n\n== BAKEOFF SUMMARY (${n} hard tires, parametric) ==`);
  console.log(`model                          got-size  size-correct  brand-correct  med-latency   total-cost  per-1000`);
  for (const m of MODELS) { const a = agg[m.id]; console.log(`${m.label.padEnd(30)} ${pct(a.gotSize).padStart(7)}  ${pct(a.sizeOk).padStart(11)}  ${pct(a.brandOk).padStart(12)}  ${String(med(a.ms) + "ms").padStart(10)}  ${("$" + a.cost.toFixed(3)).padStart(9)}  ${("$" + (a.cost / n * 1000).toFixed(2)).padStart(7)}${a.errors ? `  (${a.errors} errors)` : ""}`); }
  const total = MODELS.reduce((s, m) => s + agg[m.id].cost, 0);
  console.log(`\nComputed bakeoff spend (from response metadata): $${total.toFixed(3)} - this is a FLOOR/ESTIMATE from public per-token pricing, NOT the true billed amount. Reconcile against each provider's billing console before quoting a final number.`);
}

async function main() {
  const sample = loadSample();

  if (!LIVE) { printDryRun(sample); process.exit(0); }

  const OPENAI_KEY = process.env.BAKEOFF_OPENAI_KEY;
  const GEMINI_KEY = process.env.BAKEOFF_GEMINI_KEY;
  if (!OPENAI_KEY || !GEMINI_KEY) {
    console.error("Missing BAKEOFF_OPENAI_KEY and/or BAKEOFF_GEMINI_KEY.");
    console.error("This script never reads .env.local: that file's OPENAI_API_KEY/GEMINI_API_KEY belong exclusively");
    console.error("to Lane 2 (the app runtime's decode ladder) per CLAUDE.md's Delegation Model Policy. Set");
    console.error("BAKEOFF_OPENAI_KEY / BAKEOFF_GEMINI_KEY deliberately for this Lane 1 dev-tooling run, or omit");
    console.error("--live entirely for a $0 dry run.");
    process.exit(1);
  }
  if (!ACCEPT_COST) {
    console.error(`--live requires --yes-i-accept-cost as well (no interactive prompt - this tooling runs non-interactively).`);
    console.error(`Computed worst-case cost floor for this run: $${worstCaseFloor(sample).toFixed(3)}.`);
    process.exit(1);
  }

  await runLive(sample, { openai: OPENAI_KEY, gemini: GEMINI_KEY });
}

main();
