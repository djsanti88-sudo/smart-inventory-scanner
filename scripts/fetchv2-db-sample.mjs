// Deterministic sampler: 70 retail + 30 tire codes from the LOCAL corpora, used ONLY as the
// answer key for the Fetch V2 web benchmark (the engine itself never reads these files).
// Streams the 258MB retail JSON - never loads it fully. Output: scripts/fetchv2-db-sample-100.json
import { createReadStream, writeFileSync, readFileSync } from "node:fs";

const RETAIL = new URL("../src/server/retail-knowledge/retailKnowledge.generated.json", import.meta.url);
const TIRE = new URL("../src/server/tire-knowledge/tireKnowledge.generated.json", import.meta.url);

// --- retail: stream-scan entries like "0123456789012":["Name","Brand","Category"] --------------
const wanted = { any: 70 };
const STRIDE = 61; // take every 61st qualifying entry - deterministic spread across the file
const picked = [];
let seen = 0;

function consider(code, name, brand) {
  if (!name || name.length < 6 || !brand) return; // demand a real name AND brand as truth
  if (/[^\x20-\x7E]/.test(name + brand)) return;  // keep ASCII truths so grading is clean
  if (wanted.any <= 0) return;
  const bucket = "any";
  seen++;
  if (seen % STRIDE !== 0) return;
  wanted[bucket]--;
  picked.push({ code, codeType: code.length === 12 ? "upc" : "ean", truth: `${brand} ${name}`, expected: "verified-ok", group: "retail", source: "retailKnowledge.generated.json" });
}

await new Promise((resolve, reject) => {
  const stream = createReadStream(RETAIL, { encoding: "utf8", highWaterMark: 1 << 20 });
  let tail = "";
  const ENTRY = /"(\d{12,13})":\["([^"\\]{3,120})","([^"\\]{2,60})"/g;
  stream.on("data", (chunk) => {
    const text = tail + chunk;
    tail = text.slice(-300);
    for (const m of text.matchAll(ENTRY)) consider(m[1], m[2], m[3]);
    if (wanted.any <= 0) stream.destroy(), resolve();
  });
  stream.on("end", resolve);
  stream.on("error", reject);
});

// --- tires: 54MB is loadable; every Nth entry with brand+model+size ----------------------------
const tire = JSON.parse(readFileSync(TIRE, "utf8"));
const tireEntries = Object.entries(tire.barcodeIndex ?? {}).filter(
  ([code, v]) => /^\d{12,13}$/.test(code) && v.brand && v.model_normalized && v.size,
);
const tireStep = Math.floor(tireEntries.length / 30) || 1;
const tires = [];
for (let i = 0; i < tireEntries.length && tires.length < 30; i += tireStep) {
  const [code, v] = tireEntries[i];
  tires.push({ code, codeType: code.length === 12 ? "upc" : "ean", truth: `${v.brand} ${v.model_normalized} ${v.size}`, expected: "verified-ok", group: "tire", source: "tireKnowledge.generated.json" });
}

const codes = [...picked, ...tires];
writeFileSync(new URL("./fetchv2-db-sample-100.json", import.meta.url), JSON.stringify({ _comment: "100-code DB-sampled fixture (answer key only; engine never reads the corpora)", generatedAt: "2026-07-04", codes }, null, 1));
console.log(`sampled ${picked.length} retail + ${tires.length} tire = ${codes.length}; tire corpus entries with barcodes: ${tireEntries.length}`);
