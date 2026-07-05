// Offline eval harness for the deterministic product structurer (Build 2 / Task 2). Scores
// `structureProduct`/`tireSizeTag` (src/services/polish/structurer.ts) against the owner's own
// ground truth: the 76,173-row tire-knowledge barcode index and the 210-row fetchV2 DB sample
// fixture. ZERO network calls, ZERO AI calls - pure deterministic scoring.
//
// Usage: npx tsx scripts/polish-eval.mts
// Output: scripts/polish-eval-results.json (per-field accuracy + up to 300 verbose failures)
//
// Design notes:
// - The tire "expected sizeTag" is computed by an INDEPENDENTLY reimplemented glue function
//   (glueDigits), not by calling tireSizeTag() on the ground-truth size field. Using the function
//   under test as its own oracle would hide bugs in tireSizeTag's own regex. glueDigits() only
//   needs to handle the ALREADY-CLEAN `size`/`raw_size_text` ground-truth field (service prefix,
//   ZR, XL, and separators are all plain letters that a "digits + dots only" filter removes), so
//   it is a legitimate independent check even though it does not re-derive the tire-size grammar.
// - Every listing TEMPLATE (the noisy, realistic text) is what actually exercises structureProduct
//   end to end - brand lexicon matching, marketplace-noise stripping, size detection inside a full
//   sentence, and model-token extraction all happen there.
import { readFileSync, writeFileSync } from "node:fs";
import { structureProduct, type StructuredProduct } from "../src/services/polish/structurer";

// ---------------------------------------------------------------------------------------------
// Ground-truth data
// ---------------------------------------------------------------------------------------------
interface TireRow {
  brand: string;
  brand_normalized: string;
  model: string;
  model_normalized: string;
  size: string;
  raw_size_text: string;
  load_index: string;
  speed_rating: string;
}

interface TireKnowledge {
  barcodeIndex: Record<string, TireRow>;
}

interface FixtureRow {
  code: string;
  codeType: string;
  truth: string;
  expected: string;
  group: "retail" | "tire" | "canary";
  source: string;
}

interface Fixture {
  codes: FixtureRow[];
}

const tireKnowledgePath = new URL(
  "../src/server/tire-knowledge/tireKnowledge.generated.json",
  import.meta.url,
);
const fixturePath = new URL("./fetchv2-db-sample-200.json", import.meta.url);
const outPath = new URL("./polish-eval-results.json", import.meta.url);

const tireKnowledge = JSON.parse(readFileSync(tireKnowledgePath, "utf8")) as TireKnowledge;
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const barcodeIndex = tireKnowledge.barcodeIndex;
const allKeys = Object.keys(barcodeIndex); // insertion order as-is (12-digit keys, not array-index
// eligible, so JS preserves file order - deterministic without any explicit sort).

// ---------------------------------------------------------------------------------------------
// Independent scoring oracles (deliberately NOT calling structurer internals)
// ---------------------------------------------------------------------------------------------

/** Glue spec applied to the ALREADY-CLEAN ground-truth size field: strip service prefixes
 *  (ST/LT/P), ZR/XL suffixes, and separators (all plain letters/slashes) by keeping only digits
 *  and decimal points, then drop the decimal points. Independent of tireSizeTag's own regex. */
function glueDigits(sizeText: string): string {
  return sizeText.replace(/[^0-9.]/g, "").replace(/\./g, "");
}

function normalizeForCompare(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function titleCaseWord(w: string): string {
  return w.length ? w[0].toUpperCase() + w.slice(1) : w;
}

/** Realistic-enough display form for template text; casing does not affect lexicon matching
 *  (lexiconBrandMatch is case-insensitive) but makes the synthetic listing text look real. */
function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean).map(titleCaseWord).join(" ");
}

function tokenize(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

/** Fraction of expected (ground-truth) tokens that appear among the structured tokens. */
function tokenOverlapPct(expected: string, got: string): number {
  const expectedTokens = tokenize(expected);
  if (expectedTokens.length === 0) return 1;
  const gotTokens = new Set(tokenize(got));
  const matched = expectedTokens.filter((t) => gotTokens.has(t)).length;
  return matched / expectedTokens.length;
}

/** Realistic-ish "DiscountTire feed" spacing: space around the "/" and between the rim-diameter
 *  letter (R) and its digits, while preserving service-prefix/suffix letters. Falls back to the
 *  raw text unchanged if it does not match the expected tire-size shape (defensive; the dataset
 *  has 0 such rows per the diagnostic pass, but templates must never throw). */
const SPACED_SIZE_RE =
  /^(ST|LT|P)?\s?(\d{2,3}(?:\.\d+)?)[/xX](\d{1,3}(?:\.\d+)?)(Z?R|-)(\d{2}(?:\.\d)?)(XL|LT|ST)?$/i;
function spacedSize(rawSizeText: string): string {
  const m = SPACED_SIZE_RE.exec(rawSizeText.trim());
  if (!m) return rawSizeText;
  const [, prefix, w, ar, sep, rim, suffix] = m;
  const sepOut = /R/i.test(sep) ? sep : sep; // keep "-" as-is, keep "ZR"/"R" as-is
  return [
    prefix ? `${prefix} ` : "",
    w,
    " / ",
    ar,
    " ",
    sepOut,
    " ",
    rim,
    suffix ? ` ${suffix}` : "",
  ].join("");
}

// ---------------------------------------------------------------------------------------------
// Brand lexicon: unique Title-Cased brand list from the WHOLE index (not just the sample).
// ---------------------------------------------------------------------------------------------
const brandSet = new Set<string>();
for (const key of allKeys) {
  const b = barcodeIndex[key].brand?.trim();
  if (b) brandSet.add(titleCase(b));
}
const knownBrands = [...brandSet];

// ---------------------------------------------------------------------------------------------
// Deterministic 2,000-row tire sample: every Math.floor(76173/2000)th key, in Object.keys() order.
// ---------------------------------------------------------------------------------------------
const SAMPLE_SIZE = 2000;
const STEP = Math.floor(allKeys.length / SAMPLE_SIZE); // 38
const sampleKeys: string[] = [];
for (let i = 0; sampleKeys.length < SAMPLE_SIZE && i * STEP < allKeys.length; i++) {
  sampleKeys.push(allKeys[i * STEP]);
}

// ---------------------------------------------------------------------------------------------
// Listing templates. `idx` is the position within the sample (used only for deterministic
// order-shuffling of template 4).
// ---------------------------------------------------------------------------------------------
interface Template {
  id: string;
  build: (row: TireRow, idx: number) => string;
}

const templates: Template[] = [
  {
    // "${Brand} ${Model} ${raw_size_text} ${load_index}${speed_rating}"
    id: "brand_model_size_loadspeed",
    build: (row) => {
      const brandDisplay = titleCase(row.brand);
      const modelDisplay = titleCase(row.model_normalized);
      const loadSpeed = `${row.load_index ?? ""}${row.speed_rating ?? ""}`.trim();
      return [brandDisplay, modelDisplay, row.raw_size_text, loadSpeed].filter(Boolean).join(" ");
    },
  },
  {
    // eBay-style: "4 New ${size} ${Brand} ${Model} Tires"
    id: "ebay_4new_size_brand_model_tires",
    build: (row) => {
      const brandDisplay = titleCase(row.brand);
      const modelDisplay = titleCase(row.model_normalized);
      return `4 New ${row.size} ${brandDisplay} ${modelDisplay} Tires`;
    },
  },
  {
    // Spaced-size variant (DiscountTire-feed-style spacing around "/" and "R").
    id: "spaced_size_brand_model",
    build: (row) => {
      const brandDisplay = titleCase(row.brand);
      const modelDisplay = titleCase(row.model_normalized);
      return `${brandDisplay} ${modelDisplay} ${spacedSize(row.raw_size_text)} Tire`;
    },
  },
  {
    // "${Model} ${raw_size_text} ${Brand} tire" - order shuffled deterministically by index parity.
    id: "model_size_brand_tire_shuffled",
    build: (row, idx) => {
      const brandDisplay = titleCase(row.brand);
      const modelDisplay = titleCase(row.model_normalized);
      return idx % 2 === 0
        ? `${modelDisplay} ${row.raw_size_text} ${brandDisplay} tire`
        : `${brandDisplay} ${modelDisplay} ${row.raw_size_text} tire`;
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Tire eval
// ---------------------------------------------------------------------------------------------
interface FailureRow {
  template: string;
  name: string;
  expected: { sizeTag?: string; brand?: string; model?: string };
  got: { sizeTag?: string; brand?: string; model?: string };
  failed: string[];
}

interface TemplateStats {
  n: number;
  sizeTagOk: number;
  brandOk: number;
  modelOk: number;
}

const perTemplateStats: Record<string, TemplateStats> = {};
for (const t of templates) perTemplateStats[t.id] = { n: 0, sizeTagOk: 0, brandOk: 0, modelOk: 0 };

const failures: FailureRow[] = [];
const MAX_FAILURES = 300;

for (let i = 0; i < sampleKeys.length; i++) {
  const row = barcodeIndex[sampleKeys[i]];
  const expectedSizeTag = glueDigits(row.size);
  const expectedBrandNorm = normalizeForCompare(row.brand_normalized);

  for (const t of templates) {
    const name = t.build(row, i);
    const structured: StructuredProduct = structureProduct(name, undefined, {
      knownBrands,
      category: "tires",
    });

    const sizeTagOk = structured.sizeTag === expectedSizeTag;
    const brandOk = normalizeForCompare(structured.brand) === expectedBrandNorm;
    const modelOk = tokenOverlapPct(row.model_normalized, structured.model) >= 0.6;

    const stats = perTemplateStats[t.id];
    stats.n++;
    if (sizeTagOk) stats.sizeTagOk++;
    if (brandOk) stats.brandOk++;
    if (modelOk) stats.modelOk++;

    if ((!sizeTagOk || !brandOk || !modelOk) && failures.length < MAX_FAILURES) {
      const failed: string[] = [];
      if (!sizeTagOk) failed.push("sizeTag");
      if (!brandOk) failed.push("brand");
      if (!modelOk) failed.push("model");
      failures.push({
        template: t.id,
        name,
        expected: { sizeTag: expectedSizeTag, brand: row.brand_normalized, model: row.model_normalized },
        got: { sizeTag: structured.sizeTag, brand: structured.brand, model: structured.model },
        failed,
      });
    }
  }
}

function pct(n: number, d: number): number {
  return d === 0 ? 1 : Math.round((n / d) * 10000) / 100;
}

const perTemplateOut: Record<string, { n: number; sizeTagPct: number; brandPct: number; modelPct: number }> = {};
let aggN = 0;
let aggSizeTagOk = 0;
let aggBrandOk = 0;
let aggModelOk = 0;
for (const t of templates) {
  const s = perTemplateStats[t.id];
  perTemplateOut[t.id] = {
    n: s.n,
    sizeTagPct: pct(s.sizeTagOk, s.n),
    brandPct: pct(s.brandOk, s.n),
    modelPct: pct(s.modelOk, s.n),
  };
  aggN += s.n;
  aggSizeTagOk += s.sizeTagOk;
  aggBrandOk += s.brandOk;
  aggModelOk += s.modelOk;
}

const tireAggregate = {
  n: aggN,
  sizeTagPct: pct(aggSizeTagOk, aggN),
  brandPct: pct(aggBrandOk, aggN),
  modelPct: pct(aggModelOk, aggN),
};

// ---------------------------------------------------------------------------------------------
// Retail eval: the 200 non-canary fixture rows (retail + tire groups) -> structureProduct(truth)
// with the tire brand lexicon (no category hint - mirrors a name-only decode with no product-type
// signal). brandWrong = structured brand non-empty AND its normalized form is NOT a
// prefix/substring of the truth's normalized form (i.e. the guessed brand text does not even
// appear in the source text - unambiguously a hallucinated brand, not just an unresolved one).
// ---------------------------------------------------------------------------------------------
interface RetailFailureRow {
  code: string;
  group: string;
  truth: string;
  structuredBrand: string;
}

const nonCanaryRows = fixture.codes.filter((r) => r.group !== "canary");
const retailBrandWrongRows: RetailFailureRow[] = [];
let retailBrandFound = 0;
let tireGroupSizeTagPresent = 0;
let tireGroupCount = 0;

for (const row of nonCanaryRows) {
  const structured = structureProduct(row.truth, undefined, { knownBrands });
  const truthNorm = normalizeForCompare(row.truth);

  if (structured.brand) {
    retailBrandFound++;
    const brandNorm = normalizeForCompare(structured.brand);
    const isSubstring = brandNorm.length > 0 && truthNorm.includes(brandNorm);
    if (!isSubstring) {
      retailBrandWrongRows.push({
        code: row.code,
        group: row.group,
        truth: row.truth,
        structuredBrand: structured.brand,
      });
    }
  }

  if (row.group === "tire") {
    tireGroupCount++;
    if (structured.sizeTag) tireGroupSizeTagPresent++;
  }
}

const retailOut = {
  n: nonCanaryRows.length,
  brandWrong: retailBrandWrongRows.length,
  brandWrongRows: retailBrandWrongRows,
  brandFound: retailBrandFound,
  brandFoundPct: pct(retailBrandFound, nonCanaryRows.length),
  tireGroupSizeTagPresenceN: tireGroupCount,
  tireGroupSizeTagPresencePct: pct(tireGroupSizeTagPresent, tireGroupCount),
};

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
const results = {
  generatedAt: new Date().toISOString(),
  generatedFrom: {
    tireKnowledgeTotalRows: allKeys.length,
    tireSampleSize: sampleKeys.length,
    tireSampleStep: STEP,
    retailFixtureTotalRows: fixture.codes.length,
    retailFixtureNonCanaryRows: nonCanaryRows.length,
    knownBrandsCount: knownBrands.length,
    templates: templates.map((t) => t.id),
  },
  tire: {
    perTemplate: perTemplateOut,
    aggregate: tireAggregate,
  },
  retail: retailOut,
  failures,
};

writeFileSync(outPath, JSON.stringify(results, null, 2));

// ---------------------------------------------------------------------------------------------
// Console summary vs Global Constraints gates
// ---------------------------------------------------------------------------------------------
const GATE_SIZE_TAG = 99;
const GATE_BRAND = 97;
const sizeTagGatePass = tireAggregate.sizeTagPct >= GATE_SIZE_TAG;
const brandGatePass = tireAggregate.brandPct >= GATE_BRAND;
const retailGatePass = retailOut.brandWrong === 0;

console.log("=== Polish structurer offline eval ===");
console.log(
  `Tire sample: ${sampleKeys.length} rows x ${templates.length} templates = ${tireAggregate.n} eval points`,
);
for (const t of templates) {
  const s = perTemplateOut[t.id];
  console.log(
    `  [${t.id}] n=${s.n} sizeTag=${s.sizeTagPct}% brand=${s.brandPct}% model=${s.modelPct}%`,
  );
}
console.log(
  `  AGGREGATE sizeTag=${tireAggregate.sizeTagPct}% brand=${tireAggregate.brandPct}% model=${tireAggregate.modelPct}%`,
);
console.log("");
console.log(`Retail/mixed eval: ${retailOut.n} non-canary fixture rows`);
console.log(`  brandFound=${retailOut.brandFoundPct}% (${retailOut.brandFound}/${retailOut.n})`);
console.log(`  brandWrong=${retailOut.brandWrong} (gate: must be 0)`);
console.log(
  `  tire-group sizeTag presence=${retailOut.tireGroupSizeTagPresencePct}% (${tireGroupSizeTagPresent}/${tireGroupCount})`,
);
console.log("");
console.log(`Failures captured: ${failures.length} (cap ${MAX_FAILURES})`);
console.log("");
console.log("=== Global Constraints gates ===");
console.log(`  tire sizeTag >= ${GATE_SIZE_TAG}%: ${sizeTagGatePass ? "PASS" : "FAIL"} (${tireAggregate.sizeTagPct}%)`);
console.log(`  tire brand   >= ${GATE_BRAND}%: ${brandGatePass ? "PASS" : "FAIL"} (${tireAggregate.brandPct}%)`);
console.log(`  retail brandWrong === 0: ${retailGatePass ? "PASS" : "FAIL"} (${retailOut.brandWrong})`);
console.log("");
console.log(sizeTagGatePass && brandGatePass && retailGatePass ? "OVERALL: PASS" : "OVERALL: FAIL");
console.log(`\nResults written to ${outPath.pathname.replace(/^\//, "")}`);
