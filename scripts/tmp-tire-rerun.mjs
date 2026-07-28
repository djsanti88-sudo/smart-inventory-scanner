// RE-RUN only the tire codes that didn't cleanly decode, with two owner-selected tweaks:
//   (1) brand seeded from the GS1 company prefix via the app's tirePrefixMap.generated.json (legit:
//       brand is prefix-derivable public info; we do NOT leak the size/model/SKU answer).
//   (2) GTIN code-form variants (leading-zero add/remove, UPC-A/EAN-13/GTIN-14 padding) fed to the
//       model with an instruction to search each form.
// Same baseline mini call otherwise (web_search medium, effort low) but max_tool_calls raised to 8 so
// it has room to try the variant forms. Grades vs corpus truth and compares to the first run.
// Key from .env.local at runtime, never printed. Usage: node scripts/tmp-tire-rerun.mjs [--cap=3]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const CAP = Number(arg("cap", "3"));

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); }
const KEY = env.OPENAI_API_KEY;
if (!KEY) { console.error("missing OPENAI_API_KEY in .env.local"); process.exit(1); }

const PRICE = { in: 0.5, out: 4.0, worst: 0.12 };
const USD_PER_SEARCH = 0.01;
const prefixMap = JSON.parse(fs.readFileSync("src/services/catalog/tirePrefixMap.generated.json", "utf8"));
const prev = JSON.parse(fs.readFileSync("scripts/tmp-tire-mini-results.json", "utf8"));

// failing set = every first-run row that was NOT a clean MATCH, excluding Giovanna (769382853610),
// which actually decoded correctly (grader artifact on the model name).
const GIOVANNA = "769382853610";
const targets = prev.rows.filter((r) => !r.error && r.verdict !== "MATCH" && r.code !== GIOVANNA);

// brand from the GS1 company prefix (longest-matching 9..6 digit prefix)
function brandFromPrefix(code) { for (let L = 9; L >= 6; L--) { const p = code.slice(0, L); if (prefixMap[p]) return prefixMap[p]; } return ""; }
// GTIN code-form variants: original, leading-zeros stripped, zero-padded to 12/13/14
function variants(code) { const d = code.replace(/\D/g, ""); const bare = d.replace(/^0+/, ""); const set = new Set([d, bare]); for (const L of [12, 13, 14]) if (bare.length <= L) set.add(bare.padStart(L, "0")); set.delete(""); return [...set]; }

const brandNorm = (b) => String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const modelNorm = (m) => String(m || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
function sizeToken(s) { if (!s) return ""; const t = String(s).toUpperCase().replace(/\s+/g, ""); const m = t.match(/\b(LT|P|ST)?\d{3}\/\d{2}(Z?R|-)\d{2}\b/) || t.match(/\b\d{2}(\.\d)?X\d{1,2}(\.\d)?R\d{2}(\.\d)?\b/); if (!m) return ""; return m[0].replace(/^(LT|P|ST)/, "").replace(/^(\d{3}\/\d{2})-(\d{2})$/, "$1R$2"); }
const brandOk = (said, truth) => { const a = brandNorm(said), b = brandNorm(truth); return !!a && (a.includes(b) || b.includes(a)); };
const sizeOk = (said, truth) => { const a = sizeToken(said), b = sizeToken(truth); return !!a && a === b; };
const modelOk = (said, truthModel) => { const a = modelNorm(said), toks = modelNorm(truthModel).split(" ").filter((w) => w.length > 2); return toks.length ? toks.filter((t) => a.includes(t)).length >= Math.ceil(toks.length / 2) : false; };

const promptFor = (code, brand, vars) =>
  `Identify the EXACT tire product for this retail barcode. The GS1 company prefix indicates the brand ` +
  `is almost certainly "${brand}" - treat that as a strong hint, verify it, and focus on finding the ` +
  `exact MODEL and SIZE for that brand. The barcode may be indexed under any of these EQUIVALENT GTIN ` +
  `forms (leading zeros added or removed are the SAME code) - search EACH form until one hits: ` +
  `${vars.join(", ")}. Search tire retailers (Tire Rack, Discount Tire, SimpleTire, tiresandwheels, ` +
  `1010tires), the ${brand} manufacturer site, and barcode databases. Return JSON only: ` +
  `{"brand":"","model":"","size":"","loadIndex":"","speedRating":"","confidence":0.0,"exactCodeFound":false,"basis":""}. ` +
  `Use standard tire size format (265/70R17, LT265/70R17, 35X12.50R20). Set exactCodeFound true ONLY if ` +
  `a real page shows one of these exact code forms; then copy model + size exactly as stated. If not ` +
  `found, give a best guess only with concrete evidence (exactCodeFound false, confidence 0.4 or less) ` +
  `or leave model/size empty. Do not invent a size. Keep it brief.`;

const SCHEMA = { type: "object", additionalProperties: false, required: ["brand", "model", "size", "loadIndex", "speedRating", "confidence", "exactCodeFound", "basis"], properties: { brand: { type: "string" }, model: { type: "string" }, size: { type: "string" }, loadIndex: { type: "string" }, speedRating: { type: "string" }, confidence: { type: "number" }, exactCodeFound: { type: "boolean" }, basis: { type: "string" } } };
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

async function callModel(code, brand, vars) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50_000);
  const body = { model: "gpt-5.4-mini", input: promptFor(code, brand, vars), tools: [{ type: "web_search", search_context_size: "medium" }], reasoning: { effort: "low" }, max_output_tokens: 6000, max_tool_calls: 8, text: { format: { type: "json_schema", name: "tire_identity", strict: true, schema: SCHEMA } } };
  const t0 = Date.now(); let res;
  try { res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: controller.signal }); }
  catch (e) { clearTimeout(timer); return { error: e?.name === "AbortError" ? "aborted 50s" : String(e.message || e).slice(0, 70), ms: Date.now() - t0, usd: PRICE.worst, searches: 0 }; }
  clearTimeout(timer); const ms = Date.now() - t0;
  if (!res.ok) { const txt = await res.text(); return { error: `HTTP ${res.status}: ${txt.slice(0, 140)}`, ms, usd: (res.status >= 400 && res.status < 500 && res.status !== 429) ? 0 : PRICE.worst, searches: 0 }; }
  const data = await res.json();
  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok / 1e6) * PRICE.in + (outTok / 1e6) * PRICE.out + searches * USD_PER_SEARCH;
  const text = (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === "output_text").map((c) => c?.text ?? "").join("");
  let p; try { const m = text.match(/\{[\s\S]*\}/); p = JSON.parse(m ? m[0] : text); } catch { return { error: "non-JSON", ms, usd, searches }; }
  return { brand: str(p.brand).trim(), model: str(p.model).trim(), size: str(p.size).trim(), confidence: clamp01(p.confidence), exactCodeFound: p.exactCodeFound === true, basis: str(p.basis).slice(0, 180), ms, usd, searches };
}

(async () => {
  console.log(`RE-RUN ${targets.length} failing tire codes | brand-seed(prefix) + GTIN variants | effort low, 8 searches, cap $${CAP}\n`);
  const out = []; let spent = 0, improved = 0;
  for (const t of targets) {
    if (spent + PRICE.worst > CAP) { console.log(`  !! CAP reached ($${spent.toFixed(2)}).`); break; }
    const seed = brandFromPrefix(t.code); const vars = variants(t.code);
    const r = await callModel(t.code, seed || "unknown", vars);
    spent += r.usd || 0;
    if (r.error) { console.log(`  ${t.code}  ERROR ${r.error}`); out.push({ code: t.code, truth: t, seed, vars, error: r.error }); continue; }
    const bOk = brandOk(r.brand, t.brand), sOk = sizeOk(r.size, t.size), mOk = modelOk(r.model, t.model);
    const empty = !r.brand && !r.model && !r.size;
    const verdict = empty ? "no-guess" : (bOk && sOk && mOk) ? "MATCH" : (bOk && sOk) ? "PARTIAL(size-ok)" : bOk ? "PARTIAL(brand-only)" : "MISS";
    const was = t.verdict, nowBetter = (verdict === "MATCH" && was !== "MATCH") || (verdict.startsWith("PARTIAL(size") && was !== "MATCH" && !was.startsWith("PARTIAL(size"));
    if (nowBetter) improved++;
    console.log(`  ${t.code}  seed:${seed}  truth: ${t.brand} ${t.model} ${t.size}`);
    console.log(`     BEFORE: ${was.padEnd(20)} | NOW: ${verdict}  said "${(r.brand + " " + r.model + " " + r.size).trim().slice(0, 40)}" conf ${r.confidence.toFixed(2)} exact:${r.exactCodeFound ? "Y" : "-"} sr:${r.searches}`);
    out.push({ code: t.code, truth: t, seed, vars, before: was, after: verdict, model_ans: r, brandOk: bOk, sizeOk: sOk, modelOk: mOk });
  }
  const done = out.filter((o) => !o.error);
  const cnt = (f) => done.filter(f).length;
  console.log(`\n== RE-RUN SUMMARY (${done.length} codes) ==`);
  console.log(`  now clean MATCH:        ${cnt((o) => o.after === "MATCH")}`);
  console.log(`  now brand+size ok:      ${cnt((o) => o.after === "PARTIAL(size-ok)")}`);
  console.log(`  now brand-only:         ${cnt((o) => o.after === "PARTIAL(brand-only)")}`);
  console.log(`  now MISS:               ${cnt((o) => o.after === "MISS")}`);
  console.log(`  now no-guess:           ${cnt((o) => o.after === "no-guess")}`);
  console.log(`  IMPROVED vs first run:  ${improved}/${done.length}`);
  console.log(`  brand ${cnt((o) => o.brandOk)}/${done.length} · size ${cnt((o) => o.sizeOk)}/${done.length} · model ${cnt((o) => o.modelOk)}/${done.length}`);
  console.log(`  spend floor $${spent.toFixed(2)}`);
  fs.writeFileSync("scripts/tmp-tire-rerun-results.json", JSON.stringify({ ts: "2026-07-26", rows: out, improved, spentFloor: spent }, null, 2));
  console.log(`\nWrote scripts/tmp-tire-rerun-results.json`);
})();
