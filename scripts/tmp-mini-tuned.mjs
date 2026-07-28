// TUNED gpt-5.4-mini variant — same model, knobs turned up (owner-selected 2026-07-26):
//   retrieval: search_context_size=high, max_tool_calls=10, explicit search-target hints in prompt
//   precision: reasoning.effort=medium (up from low), stricter calibrated prompt, REQUIRED evidenceQuote
//              field + a DETERMINISTIC honesty check (if exactCodeFound but the quote doesn't contain
//              the barcode digits, demote exactCodeFound->false). All mini-only; no app fetch, no 5.5.
// Emits rows labelled model="gpt-5.4-mini-tuned" so the report can A/B it vs the baseline mini.
// Key from .env.local at runtime, never printed. Usage: node scripts/tmp-mini-tuned.mjs [--limit=21] [--effort=medium] [--cap=8]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const LIMIT = Number(arg("limit", "21"));
const EFFORT = arg("effort", "medium");
const CAP = Number(arg("cap", "8"));
const LABEL = arg("label", "gpt-5.4-mini-tuned");

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); }
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

const PRICE = { in: 0.5, out: 4.0, worst: 0.15 };
const USD_PER_SEARCH = 0.01;
const fixture = JSON.parse(fs.readFileSync("e2e/fixtures/owner-problem-codes.json", "utf8"));
const CODES = fixture.codes.slice(0, LIMIT);

// TUNED prompt: search-target hints + strict exactCodeFound calibration + mandatory evidence quote.
const promptFor = (code) =>
  `Identify the product for barcode ${code}. Search the web thoroughly. Try barcode-lookup databases ` +
  `(upcitemdb.com, barcodelookup.com, go-upc.com), the brand's own site, and major retailer product ` +
  `pages (Walmart, Target, Amazon, Sam's Club, grocery chains). GTIN zero-padding variants (the same ` +
  `digits with leading zeros added or removed) are the SAME product - also search the shortest form. ` +
  `Return JSON only: {"brand":"","productName":"","category":"","specs":"","gtin":"","confidence":0.0,` +
  `"exactCodeFound":false,"evidenceQuote":"","basis":"","sourceUrls":[]}. ` +
  `Set exactCodeFound TRUE ONLY IF you actually opened a real product page that shows THIS EXACT ` +
  `barcode, and copy the exact sentence or snippet from that page that contains the barcode into ` +
  `evidenceQuote - it MUST contain the digits ${code} (or its zero-pad variant). If you cannot quote ` +
  `the exact code from a real page, set exactCodeFound FALSE, leave evidenceQuote empty, set ` +
  `confidence 0.4 or less, and say what you searched in basis. When exactCodeFound is true, copy the ` +
  `product identity EXACTLY as the page states it (brand, full product name, size/variant). If you ` +
  `have no evidence-based guess, return an empty productName. Never invent a product or a quote. ` +
  `Always fill category with the product type. Keep it brief.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["brand", "productName", "category", "specs", "gtin", "confidence", "exactCodeFound", "evidenceQuote", "basis", "sourceUrls"],
  properties: {
    brand: { type: "string" }, productName: { type: "string" }, category: { type: "string" },
    specs: { type: "string" }, gtin: { type: "string" }, confidence: { type: "number" },
    exactCodeFound: { type: "boolean" }, evidenceQuote: { type: "string" }, basis: { type: "string" },
    sourceUrls: { type: "array", items: { type: "string" } },
  },
};

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };
const digits = (s) => str(s).replace(/\D/g, "");
// Does the quote contain the code (or a zero-pad variant)? Compare on stripped-leading-zero digit forms.
function quoteHasCode(quote, code) {
  const q = digits(quote), c = digits(code);
  if (!q || !c) return false;
  const strip = (x) => x.replace(/^0+/, "");
  return q.includes(c) || q.includes(strip(c)) || (strip(q) && c.includes(strip(q)) && strip(q).length >= 8);
}
const gptTierFor = (exact, conf, name) => (!str(name).trim() ? "none" : (exact && conf >= 0.8 ? "verified" : "suggested"));

async function callModel(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000); // higher effort + more searches = slower
  const body = {
    model: "gpt-5.4-mini", input: promptFor(code),
    tools: [{ type: "web_search", search_context_size: "high" }],
    reasoning: { effort: EFFORT }, max_output_tokens: 6000, max_tool_calls: 10,
    text: { format: { type: "json_schema", name: "product_identity_quoted", strict: true, schema: SCHEMA } },
  };
  const t0 = Date.now();
  let res;
  try { res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: controller.signal }); }
  catch (e) { clearTimeout(timer); return { error: e?.name === "AbortError" ? "aborted 60s" : String(e.message || e).slice(0, 80), ms: Date.now() - t0, usd: PRICE.worst, searches: 0 }; }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (!res.ok) { const txt = await res.text(); return { error: `HTTP ${res.status}: ${txt.slice(0, 160)}`, ms, usd: (res.status >= 400 && res.status < 500 && res.status !== 429) ? 0 : PRICE.worst, searches: 0, httpStatus: res.status }; }
  const data = await res.json();
  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok / 1e6) * PRICE.in + (outTok / 1e6) * PRICE.out + searches * USD_PER_SEARCH;
  const text = (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === "output_text").map((c) => c?.text ?? "").join("");
  let parsed; try { const m = text.match(/\{[\s\S]*\}/); parsed = JSON.parse(m ? m[0] : text); } catch { return { error: "non-JSON", ms, usd, searches }; }
  const productName = str(parsed.productName).trim();
  const claimedExact = parsed.exactCodeFound === true;
  const evidenceQuote = str(parsed.evidenceQuote).trim();
  // DETERMINISTIC honesty check: a verified claim must be backed by a quote that actually contains the code.
  const quoteOk = quoteHasCode(evidenceQuote, code);
  const exactCodeFound = claimedExact && quoteOk;
  const demoted = claimedExact && !quoteOk;
  const confidence = clamp01(parsed.confidence);
  return {
    brand: str(parsed.brand).trim(), productName, category: str(parsed.category).trim(), specs: str(parsed.specs).trim(),
    confidence, exactCodeFound, claimedExact, demoted, evidenceQuote: evidenceQuote.slice(0, 120),
    tier: gptTierFor(exactCodeFound, confidence, productName), ms, usd, searches,
  };
}

(async () => {
  console.log(`TUNED gpt-5.4-mini: ${CODES.length} codes | context=high tool_calls=10 effort=${EFFORT} +quote-check | cap $${CAP}\n`);
  const rows = []; let spent = 0, demoted = 0;
  for (const c of CODES) {
    if (spent + PRICE.worst > CAP) { console.log(`  !! CAP reached ($${spent.toFixed(2)}). Aborting.`); break; }
    const r = await callModel(c.code);
    spent += r.usd || 0;
    if (r.error) { console.log(`  ${c.code.padEnd(15)} ERROR ${r.error}`); rows.push({ code: c.code, expect: c.expect, weak: !!c.weak, model: LABEL, ...r }); continue; }
    if (r.demoted) demoted++;
    console.log(`  ${c.code.padEnd(15)} sr:${r.searches} ${r.tier.padEnd(9)} conf:${r.confidence.toFixed(2)} exact:${r.exactCodeFound ? "Y" : (r.demoted ? "demoted" : "-")} $${(r.usd || 0).toFixed(3)} "${`${r.brand} ${r.productName}`.trim().slice(0, 42)}"`);
    rows.push({ code: c.code, expect: c.expect, weak: !!c.weak, model: LABEL, ...r });
  }
  console.log(`\nDone. ${rows.filter((r) => !r.error).length}/${CODES.length} completed, ${demoted} exactCodeFound demoted by quote-check. Floor $${spent.toFixed(2)}.`);
  fs.writeFileSync("scripts/tmp-mini-tuned-results.json", JSON.stringify({ ts: "2026-07-26", model: LABEL, effort: EFFORT, rows, spentFloor: spent }, null, 2));
  console.log(`Wrote scripts/tmp-mini-tuned-results.json`);
})();
