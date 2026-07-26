// SEARCH-DEPTH SWEEP: does raising max_tool_calls get more hits, and where does recall plateau?
// Runs a fixed code set through gpt-5.5 (the ladder model) at several max_tool_calls CEILINGS and
// measures, per level: RIGHT / WRONG / no-guess, the searches ACTUALLY used (avg), cost, latency.
// Everything else is held identical to the production ladder call (Responses API, web_search medium,
// reasoning.effort low, strict JSON schema, 35s cap). Sweet spot = smallest cap where RIGHT stops
// climbing. Key read from .env.local at runtime, never printed.
//
// COST-TRUTH: $ = computed floor from per-token estimates (gpt-5.5 verified) + $0.01/search. True
// spend = OpenAI billing console. A hard --cap aborts before overspending.
// Usage: node scripts/tmp-depth-sweep.mjs [--caps=1,2,3,5,8] [--codes=scripts/tmp-depth-codes.json] [--budget=25] [--model=gpt-5.5]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const CAPS = arg("caps", "1,2,3,5,8").split(",").map((s) => Number(s.trim())).filter((x) => x > 0);
const CODES_FILE = arg("codes", "scripts/tmp-depth-codes.json");
const BUDGET = Number(arg("budget", "25"));
const MODEL = arg("model", "gpt-5.5");

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

const PRICE = { in: 5.0, out: 30.0, worst: 0.42 }; // gpt-5.5 verified; worst-case reservation for the budget guard
const USD_PER_SEARCH = 0.01;

// Code set: [{code, truth}]. Falls back to the 21 owner codes if the curated file is absent.
let CODES;
try { CODES = JSON.parse(fs.readFileSync(CODES_FILE, "utf8")).codes; }
catch {
  const owner = JSON.parse(fs.readFileSync("e2e/fixtures/owner-problem-codes.json", "utf8"));
  CODES = owner.codes.map((c) => ({ code: c.code, truth: c.expect }));
  console.log(`(no ${CODES_FILE}; using all 21 owner codes)`);
}

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
    exactCodeFound: { type: "boolean" }, basis: { type: "string" }, sourceUrls: { type: "array", items: { type: "string" } },
  },
};

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };
const STOP = new Set(["the", "a", "an", "of", "and", "for", "with", "in", "on", "to", "oz", "ct", "pack", "product", "size", "family"]);
const sig = (s) => str(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const identityMatch = (said, expected) => { const a = new Set(sig(said)); return sig(expected).filter((w) => a.has(w)).length >= 2; };
const gptTierFor = (exact, conf, name) => (!str(name).trim() ? "none" : (exact && conf >= 0.8 ? "verified" : "suggested"));

async function callModel(code, maxCalls) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  const body = {
    model: MODEL, input: promptFor(code),
    tools: [{ type: "web_search", search_context_size: "medium" }],
    reasoning: { effort: "low" }, max_output_tokens: 6000, max_tool_calls: maxCalls,
    text: { format: { type: "json_schema", name: "product_identity", strict: true, schema: PRODUCT_SCHEMA } },
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body), signal: controller.signal,
    });
  } catch (e) { clearTimeout(timer); return { error: e?.name === "AbortError" ? "aborted 40s" : String(e.message || e).slice(0, 70), ms: Date.now() - t0, usd: PRICE.worst, searches: 0 }; }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (!res.ok) { const txt = await res.text(); return { error: `HTTP ${res.status}: ${txt.slice(0, 120)}`, ms, usd: (res.status >= 400 && res.status < 500 && res.status !== 429) ? 0 : PRICE.worst, searches: 0 }; }
  const data = await res.json();
  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok / 1e6) * PRICE.in + (outTok / 1e6) * PRICE.out + searches * USD_PER_SEARCH;
  const text = (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === "output_text").map((c) => c?.text ?? "").join("");
  let parsed; try { const m = text.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : text); } catch { return { error: "non-JSON", ms, usd, searches }; }
  const productName = str(parsed.productName).trim(), exact = parsed.exactCodeFound === true, conf = clamp01(parsed.confidence);
  return { brand: str(parsed.brand).trim(), productName, confidence: conf, exactCodeFound: exact, tier: gptTierFor(exact, conf, productName), ms, usd, searches };
}

(async () => {
  console.log(`SEARCH-DEPTH SWEEP  model=${MODEL}  codes=${CODES.length}  caps=[${CAPS.join(", ")}]  calls max=${CODES.length * CAPS.length}`);
  console.log(`Budget cap: $${BUDGET.toFixed(2)} (aborts before exceeding)\n`);
  const agg = {}; for (const cap of CAPS) agg[cap] = { right: 0, wrong: 0, noGuess: 0, verified: 0, searchesUsed: [], usd: 0, ms: [], errors: 0 };
  const rows = [];
  let spent = 0;
  outer:
  for (const cap of CAPS) {
    console.log(`\n===== max_tool_calls = ${cap} =====`);
    for (const c of CODES) {
      if (spent + PRICE.worst > BUDGET) { console.log(`  !! BUDGET CAP reached ($${spent.toFixed(2)}). Aborting cleanly.`); break outer; }
      const r = await callModel(c.code, cap);
      spent += r.usd || 0; const a = agg[cap]; a.usd += r.usd || 0; if (r.ms) a.ms.push(r.ms);
      if (r.error) { a.errors++; console.log(`  ${c.code.padEnd(15)} ERROR ${r.error}`); rows.push({ cap, code: c.code, ...r }); continue; }
      a.searchesUsed.push(r.searches);
      if (r.tier === "verified") a.verified++;
      let verdict;
      if (r.tier === "none") { a.noGuess++; verdict = "no-guess"; }
      else if (identityMatch(`${r.brand} ${r.productName}`, c.truth)) { a.right++; verdict = "RIGHT"; }
      else { a.wrong++; verdict = "WRONG"; }
      console.log(`  ${c.code.padEnd(15)} sr:${r.searches} ${r.tier.padEnd(9)} conf:${r.confidence.toFixed(2)} $${(r.usd || 0).toFixed(3)} ${verdict.padEnd(8)} "${`${r.brand} ${r.productName}`.trim().slice(0, 40)}"`);
      rows.push({ cap, code: c.code, truth: c.truth, verdict, ...r });
    }
  }
  const n = CODES.length;
  const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : 0;
  const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  console.log(`\n\n== DEPTH SWEEP SUMMARY (${n} codes, gpt-5.5, only max_tool_calls varies) ==`);
  console.log(`cap  RIGHT  WRONG  no-guess  verified  avg-searches-used  med-lat   spend*`);
  for (const cap of CAPS) {
    const a = agg[cap];
    console.log(`${String(cap).padStart(3)}   ${String(a.right).padStart(4)}  ${String(a.wrong).padStart(4)}  ${String(a.noGuess).padStart(7)}  ${String(a.verified).padStart(7)}   ${avg(a.searchesUsed).toFixed(2).padStart(15)}  ${String(med(a.ms) + "ms").padStart(7)}  $${a.usd.toFixed(2).padStart(6)}${a.errors ? `  (${a.errors} err)` : ""}`);
  }
  console.log(`\n* computed floor (gpt-5.5 verified pricing + $0.01/search). TRUE spend = OpenAI console.`);
  console.log(`Total floor: $${spent.toFixed(2)} of $${BUDGET.toFixed(2)}. Sweet spot = smallest cap where RIGHT stops climbing.`);
  fs.writeFileSync("scripts/tmp-depth-sweep-results.json", JSON.stringify({ model: MODEL, caps: CAPS, n, agg, rows, spentFloor: spent }, null, 2));
  console.log(`Wrote scripts/tmp-depth-sweep-results.json`);
})();
