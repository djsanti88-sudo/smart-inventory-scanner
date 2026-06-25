// MEASUREMENT ONLY (no decode-code change). Simulates the prefix-corroborated relaxation against a
// held-out corpus sample: how many "suggested" tires WOULD flip to verified, and what is the
// wrong-VARIANT rate (right brand from prefix, but the auto-decoded size != the corpus ground truth).
// Usage: node scripts/measure-relaxed-verify.ts --count=25 [--base=http://localhost:3200]
import fs from "node:fs";
import { TIRE_PREFIX_HINTS } from "../src/services/tire/tirePrefixHints.ts"; // pure data, no @/ alias
import { hasCountableTireIdentity, tireSizeToken, KNOWN_TIRE_BRANDS } from "../src/services/ai/tireSpecs.ts";

// Inlined VERBATIM from src/services/tire/tirePrefixLookup.ts (which uses an @/ alias that a standalone
// node script can't resolve). Copied exactly so the simulation matches the live decoder's family logic.
function normalizeToGtin13(code: string): string | null {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length === 12) return "0" + d;
  if (d.length === 13) return d;
  if (d.length === 14) return d.slice(1);
  return null;
}
function lookupTirePrefix(code: string, table: any = TIRE_PREFIX_HINTS): { prefix: string; brands: any[] } | null {
  const g = normalizeToGtin13(code);
  if (!g) return null;
  let best: { prefix: string; direct: boolean } | null = null;
  for (const prefix of Object.keys(table)) {
    const direct = g.startsWith(prefix);
    const shifted = !direct && g.startsWith("0" + prefix);
    if (!direct && !shifted) continue;
    if (!best || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && direct && !best.direct)) best = { prefix, direct };
  }
  return best ? { prefix: best.prefix, brands: table[best.prefix] } : null;
}
const brandNorm = (brand: string) => (brand ?? "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]/g, "");
function isBrandInPrefixFamily(code: string, brand: string, opts: { strongOnly?: boolean } = {}): boolean {
  const nb = brandNorm(brand);
  if (!nb) return false;
  const m = lookupTirePrefix(code);
  if (!m) return false;
  const family = opts.strongOnly ? m.brands.filter((h: any) => h.weight === "strong") : m.brands;
  return family.some((h: any) => { const hn = brandNorm(h.brand); return !!hn && (hn === nb || hn.includes(nb) || nb.includes(hn)); });
}

const arg = (n: string, d: string) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const BASE = arg("base", "http://localhost:3200");
const COUNT = Number(arg("count", "25"));

const lines = fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8").split(/\r?\n/).slice(1).filter(Boolean);
const step = Math.max(1, Math.floor(lines.length / COUNT));
const sample: { brand: string; model: string; size: string; code: string }[] = [];
for (let i = 0; i < lines.length && sample.length < COUNT; i += step) {
  const c = lines[i].split(",");
  const code = (c[9] || "").trim();
  if (code && /^\d{12,13}$/.test(code)) sample.push({ brand: (c[1] || "").trim(), model: (c[2] || "").trim(), size: (c[3] || "").trim(), code });
}

const CODE_CITED = new Set(["url_only", "snippet", "grounding_chunk", "fetched_source"]); // != "none" => code is in some source

(async () => {
  try { const s = await (await fetch(BASE + "/api/ai-lookup")).json(); if (s.e2e) { console.error("server is e2e mock-only"); process.exit(1); } }
  catch { console.error(`cannot reach ${BASE}`); process.exit(1); }

  console.log(`Simulating the prefix-corroborated relaxation on ${sample.length} corpus tires (decode-code UNCHANGED)\n`);
  let alreadyVerified = 0, wouldFlip = 0, flipSizeCorrect = 0, flipSizeWrong = 0;
  for (const t of sample) {
    const codeType = t.code.length === 13 ? "ean_13" : "upc_a";
    const body = JSON.stringify({ mode: "decode-deep", scanContext: "tire", rawCode: t.code, cleanCode: t.code, codeType, confidenceThreshold: 0.85, allowImageSuggestions: true });
    try {
      const r = await fetch(BASE + "/api/ai-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data: any = await r.json();
      const status = String(data?.decision?.status || "").toLowerCase();
      const ev = String(data?.decision?.evidenceStrength || "none");
      const prod = data?.results?.[0]?.productName || "";
      const aiBrand = data?.results?.[0]?.brand || "";
      // Mirror the decoder: if the structured brand is empty, infer it from the product name (same list).
      const inferred = aiBrand || (KNOWN_TIRE_BRANDS.find((b) => prod.toLowerCase().includes(b)) || "");
      const identity = { productName: prod, brand: aiBrand } as any;

      const prefixMatch = inferred ? isBrandInPrefixFamily(t.code, inferred, { strongOnly: true }) : false;
      const countable = hasCountableTireIdentity(identity);
      const codeCited = CODE_CITED.has(ev);
      const tag = `(prefix:${prefixMatch ? "Y" : "-"} cited:${codeCited ? "Y" : "-"} specs:${countable ? "Y" : "-"}) "${prod.slice(0, 38)}"`;

      if (status === "verified") { alreadyVerified++; continue; }
      const flips = status === "suggested" && codeCited && prefixMatch && countable;
      if (!flips) { console.log(`  ${t.code} ${t.brand.padEnd(12)} ${status.padEnd(11)} ev=${ev.padEnd(14)} flip:- ${tag}`); continue; }

      wouldFlip++;
      const aiSize = tireSizeToken(identity);
      const trueSize = tireSizeToken({ productName: t.size } as any);
      const sizeOk = !!aiSize && !!trueSize && aiSize === trueSize;
      if (sizeOk) flipSizeCorrect++; else flipSizeWrong++;
      console.log(`  ${t.code} ${t.brand.padEnd(12)} ${status.padEnd(11)} ev=${ev.padEnd(14)} FLIP -> verified  size ai=${aiSize || "-"} true=${trueSize || "-"} ${sizeOk ? "OK" : "MISMATCH"}`);
    } catch (e) { console.error(`  ${t.code} ERROR ${e}`); }
  }

  const n = sample.length;
  const projVerified = alreadyVerified + wouldFlip;
  console.log(`\n== Relaxation simulation (sample ${n}) ==`);
  console.log(`already verified:        ${alreadyVerified}  (${Math.round((100 * alreadyVerified) / n)}%)`);
  console.log(`would flip to verified:  ${wouldFlip}`);
  console.log(`PROJECTED verify rate:   ${Math.round((100 * projVerified) / n)}%  (from ${Math.round((100 * alreadyVerified) / n)}%)`);
  console.log(`among flips - size correct vs corpus truth: ${flipSizeCorrect}/${wouldFlip}`);
  console.log(`WRONG-VARIANT rate (size mismatch among flips): ${wouldFlip ? Math.round((100 * flipSizeWrong) / wouldFlip) : 0}%`);
})();
