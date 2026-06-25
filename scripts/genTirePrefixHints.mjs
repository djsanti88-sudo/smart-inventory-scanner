// Generate src/services/tire/tirePrefixHints.ts from the validated, tiered CSV.
//   node scripts/genTirePrefixHints.mjs
// Ingest ONLY hint_strong + hint_weak rows. exclude_partnumber and review_before_use rows are NOT
// ingested as prefixes (held out). Exclusion is per-ROW: a prefix shared by an excluded brand still
// exists via its other (ingested) brands. Shared prefix -> brand FAMILY.
import fs from "node:fs";

const CSV = "tire_prefixes_FINAL.csv";
// Extra curated/mined files (same columns) merged on top of FINAL; strong-beats-weak dedupe handles overlaps.
const EXTRA = ["tire_prefixes_ADDITIONS.csv", "tire_prefixes_SIBLINGS.csv", "tire_prefixes_PROMOTED.csv"];
const OUT = "src/services/tire/tirePrefixHints.ts";

function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(fs.readFileSync(CSV, "utf8"));
const header = rows[0].map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, j) => [h, j]));
let data = rows.slice(1).filter((r) => r.length > 1 && (r[idx.brand] ?? "").trim());
for (const f of EXTRA) {
  if (!fs.existsSync(f)) continue;
  const xrows = parseCSV(fs.readFileSync(f, "utf8"));
  const xdata = xrows.slice(1).filter((r) => r.length > 1 && (r[idx.brand] ?? "").trim());
  data = data.concat(xdata);
  console.log(`merged ${xdata.length} rows from ${f}`);
}

const counts = { hint_strong: 0, hint_weak: 0, exclude_partnumber: 0, review_before_use: 0 };
const map = {}; // prefix -> { brand -> { weight, source } }
for (const r of data) {
  const tier = (r[idx.ingest_tier] ?? "").trim();
  if (tier in counts) counts[tier]++;
  if (tier !== "hint_strong" && tier !== "hint_weak") continue;
  const prefix = (r[idx.prefix] ?? "").trim();
  if (!/^\d+$/.test(prefix)) continue; // N/A or empty -> never a prefix
  const brand = (r[idx.brand] ?? "").trim();
  const weight = tier === "hint_strong" ? "strong" : "weak";
  const source = (r[idx.source_url] ?? "").trim();
  map[prefix] = map[prefix] || {};
  const existing = map[prefix][brand];
  // strong beats weak on duplicate brand+prefix; keep a source if we have one
  if (!existing || (existing.weight === "weak" && weight === "strong")) {
    map[prefix][brand] = { weight, source: source || existing?.source || "" };
  } else if (existing && !existing.source && source) {
    existing.source = source;
  }
}

const prefixes = Object.keys(map).sort();
let out = "";
out += "// GENERATED FILE - do not edit by hand. Source: tire_prefixes_FINAL.csv (validated, tiered).\n";
out += "// Regenerate: node scripts/genTirePrefixHints.mjs\n";
out += `// Ingested as prefixes: hint_strong=${counts.hint_strong}, hint_weak=${counts.hint_weak} (${prefixes.length} distinct prefixes).\n`;
out += `// NOT ingested (held out): exclude_partnumber=${counts.exclude_partnumber}, review_before_use=${counts.review_before_use}.\n`;
out += "//\n";
out += "// A prefix may map to a brand FAMILY (corporate siblings sharing a GS1 company prefix). A hint may\n";
out += "// only SUGGEST/BOOST a brand - it NEVER marks a scan known/verified, auto-counts, or overrides the\n";
out += "// firewall. A real confirmed scan promotes a brand<-prefix link to trusted via deriveBrandPrefixHints.\n\n";
out += 'export type PrefixWeight = "strong" | "weak";\n';
out += "export interface PrefixHint { brand: string; weight: PrefixWeight; source?: string }\n\n";
out += "export const TIRE_PREFIX_HINTS: Record<string, PrefixHint[]> = {\n";
for (const p of prefixes) {
  const entries = Object.entries(map[p]).map(([brand, v]) => {
    const s = v.source ? `, source: ${JSON.stringify(v.source)}` : "";
    return `{ brand: ${JSON.stringify(brand)}, weight: ${JSON.stringify(v.weight)}${s} }`;
  });
  out += `  ${JSON.stringify(p)}: [${entries.join(", ")}],\n`;
}
out += "};\n";

fs.writeFileSync(OUT, out);
console.log("counts:", JSON.stringify(counts));
console.log("distinct prefixes:", prefixes.length);
