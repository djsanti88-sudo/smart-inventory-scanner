// Cheap, decisive test: does the FREE Gemini + Google-Search grounding land the tire SIZE if we stop
// starving it at 3s? Mirrors groundedSpecFinder.ts (same model + google_search tool + prompt) but runs
// ONE call per tire at a generous budget and records latency - so we read size-recovery at 3s / 8s / 12s
// from a single call each (no double spend). Grounding is free (<=1500/day); only Gemini tokens cost.
// Usage: node scripts/grounded-timeout-test.mjs [--budget=12000]
import fs from "node:fs";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const HARD_TIMEOUT = Number(arg("budget", "12000"));
const MODEL = arg("model", "gemini-2.0-flash-001"); // same model the live grounded spec finder uses
const PRICE = [0.10, 0.40]; // gemini flash $/1M [in,out] - estimate; grounding itself is free under 1500/day

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); }
const KEY = env.GEMINI_API_KEY;

const HARD = [
  "4981910567783", "4981910521921", "054137082408", "6959655455755", "6419440443508",
  "8994234021233", "029142908500", "051342174706", "990498649365", "990498664993",
];

function parseCSV(text) { const rows = []; let i = 0, f = "", row = [], q = false; while (i < text.length) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; } if (c === '"') { q = true; i++; continue; } if (c === ",") { row.push(f); f = ""; i++; continue; } if (c === "\r") { i++; continue; } if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; } f += c; i++; } if (f.length || row.length) { row.push(f); rows.push(row); } return rows; }
const sizeToken = (s) => { if (!s) return ""; const t = String(s).toUpperCase(); const m = t.match(/\b(LT|P|ST)?\d{3}\/\d{2}\s?(Z?R|-)\s?\d{2}\b/) || t.match(/\b\d{2}(\.\d)?(X\d{2}(\.\d)?)?R\d{2}(\.\d)?\b/); return m ? m[0].replace(/\s+/g, "").replace(/(\d{2})-(\d{2})$/, "$1R$2") : ""; };
const extractJson = (t) => { if (!t) return {}; const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i); const c = f ? f[1] : t; const s = c.indexOf("{"), e = c.lastIndexOf("}"); if (s < 0 || e <= s) return {}; try { return JSON.parse(c.slice(s, e + 1)); } catch { return {}; } };

const rows = parseCSV(fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8"));
const h = rows[0].map((x) => x.trim());
const bi = h.indexOf("brand"), si = h.indexOf("size_canonical"), ci = h.indexOf("barcode");
const truth = new Map();
for (const r of rows.slice(1)) { const code = (r[ci] || "").trim(); if (code && !truth.has(code)) truth.set(code, { brand: (r[bi] || "").trim(), size: (r[si] || "").trim() }); }

async function grounded(code, brand, type) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), HARD_TIMEOUT);
  const prompt = `${type === "ean_13" ? "EAN" : "UPC"} ${code} is a ${brand || "tire"} tire. Using web/grounding, return ONLY JSON {brand, model, size, loadIndex, speedRating, sourceUrl}. Use standard tire size format like 265/70R17. Do not guess the brand.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 }, tools: [{ google_search: {} }] }), signal: ctrl.signal });
    const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
    const cand = d?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p?.text ?? "").join("\n");
    const snippets = (cand?.groundingMetadata?.groundingSupports ?? []).map((s) => s?.segment?.text || "").filter(Boolean);
    const u = d.usageMetadata || {};
    return { ms: Date.now() - t0, json: extractJson(text), text, snippets, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0, grounded: !!cand?.groundingMetadata };
  } catch (e) { return { ms: Date.now() - t0, error: String(e.message || e) }; } finally { clearTimeout(to); }
}

(async () => {
  if (!KEY) { console.error("missing GEMINI_API_KEY in .env.local"); process.exit(1); }
  console.log(`Grounded size test: ${HARD.length} hard tires, ${MODEL} + Google Search grounding, budget ${HARD_TIMEOUT}ms\n`);
  const recs = [];
  for (const code of HARD) {
    const t = truth.get(code) || {}; const type = code.length === 13 ? "ean_13" : "upc_a";
    const trueSize = sizeToken(t.size);
    const res = await grounded(code, t.brand, type);
    if (res.error) { console.log(`  ${code} ${(t.brand || "").padEnd(12)} ERROR ${res.error.slice(0, 40)}`); recs.push({ code, ms: res.ms, gotSize: false, sizeOk: false, cost: 0 }); continue; }
    // Owner insight: the size is often in the DESCRIPTION/title, not a clean size field. Pull it from
    // the structured field first, else mine it out of the model text + grounding snippets.
    const fieldSize = sizeToken(res.json?.size) || sizeToken(res.json?.model) || sizeToken(res.json?.productName);
    const descSize = sizeToken(res.text) || sizeToken((res.snippets || []).join(" "));
    const mSize = fieldSize || descSize;
    const srcTag = fieldSize ? "field" : (descSize ? "desc " : "  -  ");
    const gotSize = !!mSize, sizeOk = gotSize && trueSize && mSize === trueSize;
    const cost = res.inTok / 1e6 * PRICE[0] + res.outTok / 1e6 * PRICE[1];
    recs.push({ code, ms: res.ms, gotSize, sizeOk, cost, fromDesc: !fieldSize && !!descSize });
    console.log(`  ${code} ${(t.brand || "").padEnd(12)} ${String(res.ms).padStart(6)}ms  [${srcTag}] size:${mSize || "-"} ${sizeOk ? "OK" : (gotSize ? "WRONG" : "none")}  true=${trueSize || "?"}  $${cost.toFixed(5)}`);
  }
  const n = recs.length;
  const within = (b) => recs.filter((r) => r.gotSize && r.ms <= b).length;
  const withinOk = (b) => recs.filter((r) => r.sizeOk && r.ms <= b).length;
  const cost = recs.reduce((s, r) => s + r.cost, 0);
  const lat = recs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n== Size recovery vs grounded budget (n=${n}) ==`);
  for (const b of [3000, 8000, 12000]) console.log(`  budget ${String(b / 1000).padStart(2)}s:  got-size ${within(b)}/${n}   size-CORRECT ${withinOk(b)}/${n}`);
  console.log(`  ${recs.filter((r) => r.fromDesc).length}/${n} sizes were mined from the DESCRIPTION, not a clean size field (owner's point)`);
  console.log(`\nlatency: p50 ${lat[Math.floor(n / 2)]}ms  max ${lat[n - 1]}ms`);
  console.log(`test cost: $${cost.toFixed(4)} for ${n} grounded calls (grounding free under 1500/day; this is just Gemini tokens)`);
  console.log(`=> per-barcode (grounded): $${(cost / n).toFixed(5)} tokens  |  per 1,000: $${(cost / n * 1000).toFixed(2)}  |  per 30,000: $${(cost / n * 30000).toFixed(2)} (over ~20 days within the free 1500/day grounding)`);
})();
