// One-off: compact the full PrefixEntry derivedPrefixMap.json into a tiny array shape (no re-enrichment).
// Compact value: [confidence, ambiguity, productCount, [[name,count]...top2], [[cat,count]...top2]]
import fs from "node:fs";
const F = "src/services/catalog/derivedPrefixMap.json";
const full = JSON.parse(fs.readFileSync(F, "utf8"));
const out = {};
for (const [p, e] of Object.entries(full)) {
  if (Array.isArray(e)) { out[p] = e; continue; } // already compact
  const cands = (e.candidates || []).slice(0, 2).map((c) => [String(c.name || ""), Number(c.productCount) || 0]);
  const cats = Object.entries(e.categoryDist || {}).slice(0, 2).map(([k, n]) => [k, Number(n) || 0]);
  out[p] = [Number(e.confidence) || 0, Number(e.ambiguity) || 0, Number(e.productCount) || 0, cands, cats];
}
fs.writeFileSync(F, JSON.stringify(out));
console.log("compacted", Object.keys(out).length, "entries ->", (fs.statSync(F).size / 1048576).toFixed(2), "MB");
