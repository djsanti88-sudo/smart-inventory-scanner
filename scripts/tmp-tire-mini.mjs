// Test gpt-5.4-mini on 20 REAL tire barcodes from the corpus (data/tire-knowledge/tire_corpus_flat.csv),
// graded against corpus ground truth (brand / model / size). Same baseline mini config as the owner-code
// bakeoff: Responses API + web_search medium, reasoning.effort low, max_tool_calls 5, strict JSON schema.
// Tire-aware prompt (asks brand/model/size/load/speed). Key from .env.local at runtime, never printed.
// Usage: node scripts/tmp-tire-mini.mjs [--n=20] [--cap=4] [--effort=low] [--seedstride]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const N = Number(arg("n", "20"));
const CAP = Number(arg("cap", "4"));
const EFFORT = arg("effort", "low");

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); }
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

const PRICE = { in: 0.5, out: 4.0, worst: 0.10 };
const USD_PER_SEARCH = 0.01;

// --- CSV parse (quoted-safe) ---
function parseCSV(text) { const rows = []; let i = 0, f = "", row = [], q = false; while (i < text.length) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; } if (c === '"') { q = true; i++; continue; } if (c === ",") { row.push(f); f = ""; i++; continue; } if (c === "\r") { i++; continue; } if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; } f += c; i++; } if (f.length || row.length) { row.push(f); rows.push(row); } return rows; }

const rows = parseCSV(fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8"));
const H = rows[0];
const ix = (name) => H.indexOf(name);
const bI = ix("brand"), mI = ix("model"), sI = ix("size_canonical"), liI = ix("load_index"), srI = ix("speed_rating"), bcI = ix("barcode"), btI = ix("barcode_type"), pnI = ix("manufacturer_part_number");

// valid = rows with a real 12-13 digit UPC/EAN barcode + full brand/model/size truth
const valid = [];
const seen = new Set();
for (const r of rows.slice(1)) {
  const bc = (r[bcI] || "").replace(/\D/g, "");
  if (bc.length < 12 || bc.length > 13) continue;
  if (!(r[bI] && r[mI] && r[sI])) continue;
  if (seen.has(bc)) continue; seen.add(bc);
  valid.push({ code: bc, brand: r[bI], model: r[mI], size: r[sI], load: r[liI], speed: r[srI], pn: r[pnI], type: r[btI] });
}
// deterministic even-spaced sample across the whole corpus (brand diversity, no RNG)
const sample = [];
for (let i = 0; i < N; i++) sample.push(valid[Math.floor((i * valid.length) / N)]);

// --- grading helpers ---
const brandNorm = (b) => String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const modelNorm = (m) => String(m || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
function sizeToken(s) { if (!s) return ""; const t = String(s).toUpperCase().replace(/\s+/g, ""); const m = t.match(/\b(LT|P|ST)?\d{3}\/\d{2}(Z?R|-)\d{2}\b/) || t.match(/\b\d{2}(\.\d)?X\d{1,2}(\.\d)?R\d{2}(\.\d)?\b/); if (!m) return ""; return m[0].replace(/^(LT|P|ST)/, "").replace(/^(\d{3}\/\d{2})-(\d{2})$/, "$1R$2"); }
const brandOk = (said, truth) => { const a = brandNorm(said), b = brandNorm(truth); return !!a && (a.includes(b) || b.includes(a)); };
const sizeOk = (said, truth) => { const a = sizeToken(said), b = sizeToken(truth); return !!a && a === b; };
const modelOk = (said, truthModel) => { const a = modelNorm(said), toks = modelNorm(truthModel).split(" ").filter((w) => w.length > 2); return toks.length ? toks.filter((t) => a.includes(t)).length >= Math.ceil(toks.length / 2) : false; };

const promptFor = (t) =>
  `Identify the EXACT tire product for retail barcode ${t.code} (a ${t.type} barcode). Search the web ` +
  `- try tire retailers (Tire Rack, Discount Tire, SimpleTire, tiresandwheels), the manufacturer site, ` +
  `and barcode databases. Return JSON only: {"brand":"","model":"","size":"","loadIndex":"","speedRating":"",` +
  `"confidence":0.0,"exactCodeFound":false,"basis":""}. Use standard tire size format (265/70R17, ` +
  `LT265/70R17, 35X12.50R20). Set exactCodeFound true ONLY if you find a real page showing THIS exact ` +
  `barcode; then copy brand/model/size exactly as stated and set confidence to match. If you cannot find ` +
  `the exact code, give your best guess only with concrete evidence (set exactCodeFound false, confidence ` +
  `0.4 or less) or leave brand/model empty if nothing qualifies. Do not invent a size. Keep it brief.`;

const SCHEMA = { type: "object", additionalProperties: false, required: ["brand", "model", "size", "loadIndex", "speedRating", "confidence", "exactCodeFound", "basis"], properties: { brand: { type: "string" }, model: { type: "string" }, size: { type: "string" }, loadIndex: { type: "string" }, speedRating: { type: "string" }, confidence: { type: "number" }, exactCodeFound: { type: "boolean" }, basis: { type: "string" } } };
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

async function callModel(t) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
  const body = { model: "gpt-5.4-mini", input: promptFor(t), tools: [{ type: "web_search", search_context_size: "medium" }], reasoning: { effort: EFFORT }, max_output_tokens: 6000, max_tool_calls: 5, text: { format: { type: "json_schema", name: "tire_identity", strict: true, schema: SCHEMA } } };
  const t0 = Date.now(); let res;
  try { res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: controller.signal }); }
  catch (e) { clearTimeout(timer); return { error: e?.name === "AbortError" ? "aborted 45s" : String(e.message || e).slice(0, 70), ms: Date.now() - t0, usd: PRICE.worst, searches: 0 }; }
  clearTimeout(timer); const ms = Date.now() - t0;
  if (!res.ok) { const txt = await res.text(); return { error: `HTTP ${res.status}: ${txt.slice(0, 140)}`, ms, usd: (res.status >= 400 && res.status < 500 && res.status !== 429) ? 0 : PRICE.worst, searches: 0 }; }
  const data = await res.json();
  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok / 1e6) * PRICE.in + (outTok / 1e6) * PRICE.out + searches * USD_PER_SEARCH;
  const text = (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === "output_text").map((c) => c?.text ?? "").join("");
  let p; try { const m = text.match(/\{[\s\S]*\}/); p = JSON.parse(m ? m[0] : text); } catch { return { error: "non-JSON", ms, usd, searches }; }
  return { brand: str(p.brand).trim(), model: str(p.model).trim(), size: str(p.size).trim(), loadIndex: str(p.loadIndex).trim(), speedRating: str(p.speedRating).trim(), confidence: clamp01(p.confidence), exactCodeFound: p.exactCodeFound === true, basis: str(p.basis).slice(0, 160), ms, usd, searches };
}

(async () => {
  console.log(`gpt-5.4-mini on ${sample.length} tire barcodes (of ${valid.length} valid in corpus) | web_search medium, effort ${EFFORT} | cap $${CAP}\n`);
  const out = []; let spent = 0;
  for (const t of sample) {
    if (spent + PRICE.worst > CAP) { console.log(`  !! CAP reached ($${spent.toFixed(2)}).`); break; }
    const r = await callModel(t);
    spent += r.usd || 0;
    if (r.error) { console.log(`  ${t.code}  ${t.brand}/${t.size}  ERROR ${r.error}`); out.push({ ...t, model_ans: null, error: r.error, ms: r.ms, usd: r.usd, searches: r.searches }); continue; }
    const bOk = brandOk(r.brand, t.brand), sOk = sizeOk(r.size, t.size), mOk = modelOk(r.model, t.model);
    const empty = !r.brand && !r.model && !r.size;
    const verdict = empty ? "no-guess" : (bOk && sOk && mOk) ? "MATCH" : (bOk && sOk) ? "PARTIAL(size-ok)" : (bOk) ? "PARTIAL(brand-only)" : "MISS";
    console.log(`  ${t.code}  truth: ${t.brand} ${t.model} ${t.size}\n     said: ${r.brand} ${r.model} ${r.size} [conf ${r.confidence.toFixed(2)} exact:${r.exactCodeFound ? "Y" : "-"} sr:${r.searches} $${(r.usd || 0).toFixed(3)}]  -> ${verdict}`);
    out.push({ ...t, model_ans: r, brandOk: bOk, sizeOk: sOk, modelOk: mOk, verdict, ms: r.ms, usd: r.usd, searches: r.searches });
  }
  const done = out.filter((o) => !o.error);
  const cnt = (f) => done.filter(f).length;
  console.log(`\n== TIRE SUMMARY (gpt-5.4-mini, ${done.length} graded) ==`);
  console.log(`  clean MATCH (brand+model+size): ${cnt((o) => o.verdict === "MATCH")}`);
  console.log(`  brand+size ok (model off):      ${cnt((o) => o.verdict === "PARTIAL(size-ok)")}`);
  console.log(`  brand-only:                     ${cnt((o) => o.verdict === "PARTIAL(brand-only)")}`);
  console.log(`  MISS:                           ${cnt((o) => o.verdict === "MISS")}`);
  console.log(`  no-guess:                       ${cnt((o) => o.verdict === "no-guess")}`);
  console.log(`  brand correct:  ${cnt((o) => o.brandOk)}/${done.length}   size correct: ${cnt((o) => o.sizeOk)}/${done.length}   model correct: ${cnt((o) => o.modelOk)}/${done.length}`);
  console.log(`  exactCodeFound claims: ${cnt((o) => o.model_ans?.exactCodeFound)}   | of those, size WRONG: ${cnt((o) => o.model_ans?.exactCodeFound && !o.sizeOk)}`);
  console.log(`  spend floor: $${spent.toFixed(2)}  (true = OpenAI console)`);
  fs.writeFileSync("scripts/tmp-tire-mini-results.json", JSON.stringify({ ts: "2026-07-26", model: "gpt-5.4-mini", n: done.length, rows: out, spentFloor: spent }, null, 2));
  console.log(`\nWrote scripts/tmp-tire-mini-results.json`);
})();
