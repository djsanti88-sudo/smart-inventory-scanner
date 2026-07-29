// 5.5-family bakeoff: gpt-5.5 (full) vs gpt-5.4-mini (closest existing mini to the 5.5 gen; no true
// gpt-5.5-mini exists - 404) vs gpt-5.5-pro. Runs the 21 owner problem codes through EACH model using
// the EXACT production decode-ladder call (mirrors src/services/ai/gptFromScratch.ts: Responses API +
// web_search medium, reasoning.effort low, max_tool_calls 5, strict product_identity JSON schema,
// 35s cap). Grades identity vs the fixture's expected string with the same >=2-significant-word
// overlap heuristic the prior probe PDFs used. Key read from .env.local at runtime, never printed.
//
// COST-TRUTH (owner doctrine): $ figures below are a COMPUTED FLOOR from per-token ESTIMATES + the
// observable web_search_call count ($0.01/search). True spend = the OpenAI billing console. A hard
// --cap aborts the run before it can overspend. Usage:
//   node scripts/tmp-mini-bakeoff.mjs [--cap=45] [--models=gpt-5.5,gpt-5.4-mini,gpt-5.5-pro] [--limit=21]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const CAP_USD = Number(arg("cap", "45"));
const LIMIT = Number(arg("limit", "21"));

// keys (runtime only, never printed/committed)
const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

// Per-model per-1M-token price ESTIMATES [in, out] + a worst-case reservation used ONLY by the budget
// guard (never reported as actual). gpt-5.5 pricing is the verified one from the probe PDFs; pro/mini
// are labelled estimates. Search billed separately at $0.01/call (observable, capped at 5).
const PRICE = {
  "gpt-5.5":      { in: 5.0,  out: 30.0,  worst: 0.39, note: "verified (probe PDFs)" },
  "gpt-5.4-mini": { in: 0.5,  out: 4.0,   worst: 0.10, note: "ESTIMATE" },
  "gpt-5.5-pro":  { in: 15.0, out: 120.0, worst: 1.60, note: "ESTIMATE (~10x, per Round-1 probe)" },
  "gpt-5-mini":   { in: 0.25, out: 2.0,   worst: 0.08, note: "ESTIMATE" },
};
const USD_PER_SEARCH = 0.01;
// Per-model reasoning effort. gpt-5.5-pro does NOT support 'low' (only medium/high/xhigh), so it runs
// at its floor 'medium' - a documented caveat; the primary gpt-5.5-vs-gpt-5.4-mini comparison stays
// identical at 'low' (exactly the production ladder setting).
const EFFORT = { "gpt-5.5-pro": "medium" };
const effortFor = (m) => EFFORT[m] || "low";
// gpt-5.5-pro is much slower (Round-1 probe: avg 73s, worst 129s). Give it a longer wall so it can
// actually finish and bill ACTUAL cost instead of aborting at worst-case. Others keep the prod ~35-45s.
const TIMEOUT_MS = { "gpt-5.5-pro": 150_000 };
const timeoutFor = (m) => TIMEOUT_MS[m] || 45_000;
const DEFAULT_MODELS = ["gpt-5.5", "gpt-5.4-mini", "gpt-5.5-pro"];
const MODELS = (arg("models", DEFAULT_MODELS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);

const fixture = JSON.parse(fs.readFileSync("e2e/fixtures/owner-problem-codes.json", "utf8"));
const CODES = fixture.codes.slice(0, LIMIT);

// --- EXACT production ladder prompt (verbatim from gptFromScratch.ts) ---
const promptFor = (code) =>
  `Identify the product for barcode ${code}. Search the web. ` +
  `GTIN zero-padding variants of a code (the same digits with leading zeros added or removed) ` +
  `are the SAME product - search the shortest form too. Return JSON only: ` +
  `{"brand":"","productName":"","category":"","specs":"","gtin":"","confidence":0.0,` +
  `"exactCodeFound":false,"basis":"","sourceUrls":[]}. ` +
  `If you find this exact code on a real page, set exactCodeFound true, copy the product ` +
  `identity EXACTLY as the page states it (brand, full product name, size/variant), and set ` +
  `confidence to match the evidence. If you cannot find the exact code, you may give ONE best ` +
  `guess ONLY when concrete evidence points to a specific product (prefix ownership, near-identical ` +
  `listings, partial code matches) - set exactCodeFound false, confidence 0.4 or less, name the ` +
  `category, and cite the evidence in basis. If you have no evidence-based guess, return an empty ` +
  `productName and say in basis what you searched and why nothing qualified. Never invent a product. ` +
  `Always fill category with the product type you believe the barcode belongs to, even when ` +
  `productName is empty. Keep it brief.`;

const PRODUCT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["brand", "productName", "category", "specs", "gtin", "confidence", "exactCodeFound", "basis", "sourceUrls"],
  properties: {
    brand: { type: "string" }, productName: { type: "string" }, category: { type: "string" },
    specs: { type: "string" }, gtin: { type: "string" }, confidence: { type: "number" },
    exactCodeFound: { type: "boolean" }, basis: { type: "string" },
    sourceUrls: { type: "array", items: { type: "string" } },
  },
};

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };
const STOP = new Set(["the", "a", "an", "of", "and", "for", "with", "in", "on", "to", "oz", "ct", "pack", "product", "size", "family"]);
const sig = (s) => str(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
// >=2 significant-word overlap = "match" (same heuristic family as the probe grader).
function identityMatch(said, expected) {
  const a = new Set(sig(said)); const b = sig(expected);
  const overlap = b.filter((w) => a.has(w)).length;
  return overlap >= 2;
}

function gptTierFor(exactCodeFound, confidence, productName) {
  if (!str(productName).trim()) return "none";
  if (exactCodeFound && confidence >= 0.8) return "verified";
  return "suggested";
}

async function callModel(model, code) {
  const price = PRICE[model] || { in: 5.0, out: 30.0, worst: 0.39, note: "fallback estimate" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(model)); // per-model (pro is slow)
  const body = {
    model,
    input: promptFor(code),
    tools: [{ type: "web_search", search_context_size: "medium" }],
    reasoning: { effort: effortFor(model) },
    max_output_tokens: 6000,
    max_tool_calls: 5,
    text: { format: { type: "json_schema", name: "product_identity", strict: true, schema: PRODUCT_SCHEMA } },
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === "AbortError";
    return { error: aborted ? `aborted at ${timeoutFor(model) / 1000}s` : String(e.message || e).slice(0, 80), ms: Date.now() - t0, usd: price.worst, searches: 0 };
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (!res.ok) {
    const txt = await res.text();
    return { error: `HTTP ${res.status}: ${txt.slice(0, 160)}`, ms, usd: (res.status >= 400 && res.status < 500 && res.status !== 429) ? 0 : price.worst, searches: 0, httpStatus: res.status };
  }
  const data = await res.json();
  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out + searches * USD_PER_SEARCH;
  const text = (data.output ?? [])
    .flatMap((o) => o?.content ?? [])
    .filter((c) => c?.type === "output_text")
    .map((c) => c?.text ?? "").join("");
  let parsed;
  try { const m = text.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : text); }
  catch { return { error: "non-JSON reply", ms, usd, searches, inTok, outTok }; }
  const productName = str(parsed.productName).trim();
  const exactCodeFound = parsed.exactCodeFound === true;
  const confidence = clamp01(parsed.confidence);
  return {
    brand: str(parsed.brand).trim(), productName, category: str(parsed.category).trim(),
    specs: str(parsed.specs).trim(), confidence, exactCodeFound,
    tier: gptTierFor(exactCodeFound, confidence, productName),
    basis: str(parsed.basis).slice(0, 200), ms, usd, searches, inTok, outTok,
  };
}

(async () => {
  console.log(`5.5-family bakeoff: ${CODES.length} owner codes x ${MODELS.length} models = ${CODES.length * MODELS.length} calls max`);
  console.log(`Models: ${MODELS.join(", ")}`);
  console.log(`Hard spend cap: $${CAP_USD.toFixed(2)} (run aborts before exceeding)\n`);

  const agg = {}; for (const m of MODELS) agg[m] = { right: 0, wrong: 0, noGuess: 0, verified: 0, suggested: 0, exactClaims: 0, errors: 0, usd: 0, searches: 0, ms: [] };
  const rows = [];
  let spent = 0;

  outer:
  for (const c of CODES) {
    console.log(`\n${c.code}  expect: ${c.expect}${c.weak ? "  [weak]" : ""}`);
    for (const m of MODELS) {
      // budget guard: reserve this call's worst case before firing.
      const reserve = (PRICE[m]?.worst ?? 0.39);
      if (spent + reserve > CAP_USD) { console.log(`  !! CAP REACHED (spent $${spent.toFixed(2)} + reserve $${reserve} > $${CAP_USD}). Aborting cleanly.`); break outer; }
      const r = await callModel(m, c.code);
      spent += r.usd || 0;
      const a = agg[m]; a.usd += r.usd || 0; a.searches += r.searches || 0; if (r.ms) a.ms.push(r.ms);
      if (r.error) { a.errors++; console.log(`  ${m.padEnd(14)} ERROR ${r.error}`); rows.push({ code: c.code, expect: c.expect, model: m, ...r }); continue; }
      if (r.tier === "verified") a.verified++; if (r.tier === "suggested") a.suggested++;
      if (r.exactCodeFound) a.exactClaims++;
      let verdict;
      if (r.tier === "none") { a.noGuess++; verdict = "no-guess"; }
      else if (identityMatch(`${r.brand} ${r.productName}`, c.expect)) { a.right++; verdict = "RIGHT"; }
      else { a.wrong++; verdict = "WRONG"; }
      const said = `${r.brand} ${r.productName}`.trim().slice(0, 54);
      console.log(`  ${m.padEnd(14)} ${String(r.ms).padStart(6)}ms  ${r.tier.padEnd(9)} conf:${r.confidence.toFixed(2)} exact:${r.exactCodeFound ? "Y" : "-"} sr:${r.searches} $${(r.usd || 0).toFixed(3)}  ${verdict.padEnd(8)} "${said}"`);
      rows.push({ code: c.code, expect: c.expect, weak: !!c.weak, model: m, verdict, ...r });
    }
  }

  const n = CODES.length;
  const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  console.log(`\n\n== BAKEOFF SUMMARY (${n} owner codes, live web_search, production ladder settings) ==`);
  console.log(`model           graded  RIGHT  WRONG  no-guess  exact-claims  verified  med-lat   spend*   per-code*`);
  for (const m of MODELS) {
    const a = agg[m]; const graded = a.right + a.wrong; const gradedN = graded || 1;
    console.log(
      `${m.padEnd(14)}  ${String(graded).padStart(4)}   ${String(a.right).padStart(4)}  ${String(a.wrong).padStart(4)}  ${String(a.noGuess).padStart(7)}   ${String(a.exactClaims).padStart(10)}   ${String(a.verified).padStart(7)}   ${String(med(a.ms) + "ms").padStart(7)}  $${a.usd.toFixed(2).padStart(6)}  $${(a.usd / (n) ).toFixed(3)}${a.errors ? `  (${a.errors} err)` : ""}`
    );
  }
  console.log(`\n* spend = COMPUTED FLOOR from per-token ESTIMATES (gpt-5.5 verified; pro/mini estimated) + $0.01/search. TRUE spend = OpenAI billing console.`);
  console.log(`Total computed floor: $${spent.toFixed(2)} of $${CAP_USD.toFixed(2)} cap.`);
  console.log(`RIGHT/WRONG = >=2 significant-word overlap vs the fixture 'expect' string (same heuristic family as prior probe PDFs).`);

  const out = { ts: "2026-07-26", models: MODELS, n, cap: CAP_USD, spentFloor: spent, agg, rows };
  const outFile = arg("out", "scripts/tmp-mini-bakeoff-results.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outFile}`);
})();
