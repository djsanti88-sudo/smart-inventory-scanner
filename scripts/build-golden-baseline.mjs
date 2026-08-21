// Generates benchmarks/golden/phase1-corpus-golden.json from the committed corpus.
// Run ONCE (owner-approved snapshot build); the OUTPUT is committed and never regenerated silently.
//
// SOURCE OF CODES: `benchmarks/phase1_100_codes.csv` is a DIFFERENT, unrelated 4-row retail-item
// benchmark (paint markers / lighter / oil - not tires, not the owner-loved run). The owner-loved
// "100/100 verified" baseline (commit 1782c11, preview inventory-5tk3c3vxf, 2026-07-10) was proven
// against the 100-code tire set recorded in `scripts/dt-harvest/state/owner-100-codes.json`, which is
// NOT committed to git (untracked scratch state). That code list is embedded below verbatim so this
// generator is self-contained and reproducible without depending on an untracked file.
//
// CORPUS ROW SHAPE (read from one entry of tireKnowledge.generated.json's barcodeIndex - see
// task-10-report.md): TireKnowledgeRow has flat fields `brand` and `size` (e.g. "245/70R16",
// "LT225/65R17"). There is NO specsShort/specsFull - those field names from the task brief's example
// do not exist in the real corpus row and were adjusted here to match reality.
import fs from "node:fs";

const OWNER_100_CODES = [
  "697662145202", "697662145332", "697662145554", "697662142942", "697662142980",
  "697662143017", "697662143062", "697662143116", "697662143123", "697662143369",
  "697662143420", "697662145561", "697662155102", "697662156734", "697662156772",
  "697662156826", "697662156925", "697662156994", "697662157250", "697662158622",
  "697662159773", "697662160281", "697662160298", "697662160311", "697662160328",
  "697662160373", "697662160397", "697662160403", "697662160427", "697662160441",
  "697662160458", "697662160465", "697662160496", "697662160502", "697662160519",
  "697662160526", "697662160540", "697662160557", "697662160595", "697662160601",
  "697662160625", "697662133469", "697662128489", "697662131007", "697662124627",
  "697662099659", "697662099673", "697662099734", "697662099789", "697662099796",
  "697662099802", "697662099819", "697662099826", "697662099895", "697662101550",
  "697662101611", "697662102885", "086699428301", "086699473608", "086699042132",
  "086699051462", "086699060099", "086699117120", "086699137685", "086699143921",
  "086699152176", "086699165459", "086699212016", "086699236098", "086699300546",
  "086699332844", "086699339157", "086699397317", "086699430304", "086699431998",
  "086699525222", "086699624710", "086699679611", "086699778642", "086699835338",
  "086699855275", "086699880628", "086699979674", "086699998538", "086699014313",
  "086699034588", "086699061348", "086699146441", "029142337508", "029142719939",
  "029142803089", "029142803430", "029142814887", "029142337386", "029142342045",
  "029142342489", "029142646808", "029142652144", "029142713142", "029142714729",
];

const idx = JSON.parse(fs.readFileSync("src/server/tire-knowledge/tireKnowledge.generated.json", "utf8"));

// Same variant scheme as src/services/upc/gtin.ts (lookupCandidates): raw code, leading-zero-stripped,
// and padded to 12/13/14 digits. Reimplemented inline (no imports) to keep this a plain, dependency-free
// build-time script; matches lookupByExactBarcode's real candidate set for GTIN-shaped codes.
const strip = (c) => c.replace(/^0+/, "") || "0";
const findRow = (code) => {
  const bases = new Set([code, strip(code)]);
  const cands = new Set();
  for (const base of bases) {
    cands.add(base);
    if (base.length <= 14) cands.add(base.padStart(14, "0"));
    if (base.length <= 13) cands.add(base.padStart(13, "0"));
    if (base.length <= 12) cands.add(base.padStart(12, "0"));
  }
  for (const c of cands) if (idx.barcodeIndex[c]) return idx.barcodeIndex[c];
  return null;
};

const golden = [];
const notFound = [];
for (const code of OWNER_100_CODES) {
  const row = findRow(code);
  if (!row) { notFound.push(code); console.error("NOT IN CORPUS:", code); continue; }
  golden.push({ code, brand: row.brand, sizeToken: row.size ?? "" });
}

fs.mkdirSync("benchmarks/golden", { recursive: true });
fs.writeFileSync("benchmarks/golden/phase1-corpus-golden.json", JSON.stringify(golden, null, 1) + "\n");
console.log(`golden: ${golden.length}/${OWNER_100_CODES.length} codes`);
if (notFound.length) {
  console.error(`\n${notFound.length} owner-100 codes are NOT resolvable by pure corpus lookup (they may have settled via GPT-5.4 mini in a live preview run rather than the local corpus):`);
  for (const c of notFound) console.error(`  - ${c}`);
}
