// Extends the 100-code DB sample to 200 (+10 canaries): +30 retail (different stride, no overlap)
// +70 tire (offset slices). Corpora are the ANSWER KEY only - the engine never reads them.
import { createReadStream, writeFileSync, readFileSync } from "node:fs";

const RETAIL = new URL("../src/server/retail-knowledge/retailKnowledge.generated.json", import.meta.url);
const TIRE = new URL("../src/server/tire-knowledge/tireKnowledge.generated.json", import.meta.url);
const base = JSON.parse(readFileSync(new URL("./fetchv2-db-sample-100.json", import.meta.url), "utf8")).codes;
const have = new Set(base.map((c) => c.code));

const picked = [];
let seen = 0;
const wanted = { any: 30 };
function consider(code, name, brand) {
  if (wanted.any <= 0 || have.has(code)) return;
  if (!name || name.length < 6 || !brand) return;
  if (/[^\x20-\x7E]/.test(name + brand)) return;
  seen++;
  if (seen % 73 !== 0) return; // different stride than sample-100 = different codes
  wanted.any--;
  picked.push({ code, codeType: code.length === 12 ? "upc" : "ean", truth: `${brand} ${name}`, expected: "verified-ok", group: "retail", source: "retailKnowledge.generated.json" });
}
await new Promise((resolve, reject) => {
  const stream = createReadStream(RETAIL, { encoding: "utf8", highWaterMark: 1 << 20 });
  let tail = "";
  const ENTRY = /"(\d{8,14})":\["([^"\\]{3,120})","([^"\\]{2,60})"/g;
  stream.on("data", (chunk) => {
    const text = tail + chunk;
    tail = text.slice(-300);
    for (const m of text.matchAll(ENTRY)) consider(m[1], m[2], m[3]);
    if (wanted.any <= 0) stream.destroy(), resolve();
  });
  stream.on("end", resolve);
  stream.on("error", reject);
});

const tire = JSON.parse(readFileSync(TIRE, "utf8"));
const entries = Object.entries(tire.barcodeIndex ?? {}).filter(
  ([code, v]) => /^\d{12,13}$/.test(code) && v.brand && v.model_normalized && v.size && !have.has(code),
);
const step = Math.floor(entries.length / 70) || 1;
const tires = [];
for (let i = Math.floor(step / 2); i < entries.length && tires.length < 70; i += step) {
  const [code, v] = entries[i];
  tires.push({ code, codeType: code.length === 12 ? "upc" : "ean", truth: `${v.brand} ${v.model_normalized} ${v.size}`, expected: "verified-ok", group: "tire", source: "tireKnowledge.generated.json" });
}

const dry = JSON.parse(readFileSync(new URL("../e2e/fixtures/dryrun-codes.json", import.meta.url), "utf8")).codes;
const canaries = dry.filter((c) => c.group === "canary").map((c) => ({ code: c.code, codeType: c.codeType, truth: c.truth, expected: "must-refuse", group: "canary", source: "dryrun-codes.json" }));

const codes = [...base, ...picked, ...tires, ...canaries];
writeFileSync(new URL("./fetchv2-db-sample-200.json", import.meta.url), JSON.stringify({ _comment: "200 DB codes + 10 canaries; answer key only", generatedAt: "2026-07-04", codes }, null, 1));
const g = {}; for (const c of codes) g[c.group] = (g[c.group] ?? 0) + 1;
console.log("total", codes.length, JSON.stringify(g));
