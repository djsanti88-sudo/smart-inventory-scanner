// Grader for the Option B ladder 150-code dry run (Task 9, controller adjudication rules
// 2026-07-04). Reads scripts/tmp-ladder-dryrun-results.json ({ spent, rows }) and scores every
// row against its pre-tagged expected outcome (e2e/fixtures/dryrun-codes.json is the source of
// the `expected`/`truth`/`group` fields already carried on each row).
//
// This grader implements the brief's starter grader (.superpowers/sdd/task-9-brief.md Step 1)
// EXTENDED by five controller adjudication rules that override the brief where they conflict:
//
//  1. Junk-title verifies (search/site pages echoing the code back, e.g. "Search For:<code>",
//     "CodeCheck - Suchergebnisse", "UPC Database | <code>") are WRONG regardless of `expected`,
//     and are counted separately as `junkTitleVerifies` (the headline defect: new intl sources
//     returning a search-results page that the pipeline treats as a verified product identity).
//  2. A `verified` outcome on an expected `suggest-only` row is NOT counted wrong if the found
//     identity actually matches truth (>=2 significant-word overlap, or brand+word) - it is a win,
//     counted separately as `strictExpectationOverrides`. Exception: fnsku/part/canary rows can
//     never be excused this way (their truth strings carry no exploitable identity, or a wrong
//     guess on a canary/part number is still a real miss).
//  3. FNSKU rows are outcome-keyed only (truth strings carry no identity) - skip identity
//     matching for them entirely; they can never contribute to wrongLoudSuggest.
//  4. 108/150 rows are `reconstructed:true` (recovered from a crashed run's cost log); their
//     stage detail is inferred from cost (`stageInferred`: "cheap" if cost < $0.02, else
//     "escalated"). The cheap-verify-rate metric uses stageInferred for those rows, and the
//     report discloses the split so no inference is silently laundered into a hard number.
//  5. Any `outcome === "error"` rows are excluded from rate gates but counted and listed.
//
// Manual corrections (Step 2 spot-check, documented in .superpowers/sdd/task-9-report.md):
//  - 00028400028141 (owner, expected verified-ok): naive overlap>=2 ("lay","chips") looks like a
//    match, but the returned product ("...Munchies Rold Gold Doritos Cheetos Sun Chips Cheese Fix
//    Snack Mix...") is actually the truth string of a DIFFERENT row in this same batch
//    (00028400160131, "Munchies Cheese Fix Snack Mix") - the two codes' identities were swapped by
//    the model. This is a genuine wrong verify masked by generic brand/category word overlap
//    ("lay", "chips" are too generic to prove identity here). Forced to wrongVerified.
import { readFileSync, writeFileSync } from "node:fs";

// Optional --input=<path> grades a different results file in the same {spent, rows} shape
// (e.g. the Fetch V2 web-only benchmark). Default stays the committed ladder run.
const inputArg = process.argv.find((a) => a.startsWith("--input="));
const { spent, rows } = JSON.parse(
  readFileSync(inputArg ? inputArg.slice("--input=".length) : new URL("./tmp-ladder-dryrun-results.json", import.meta.url), "utf8")
);

// Optional: dump a machine-readable summary for the PDF report builder, so the report never
// duplicates (and risks drifting from) this grader's logic. Pass --summary=<path> to enable.
const summaryArg = process.argv.find((a) => a.startsWith("--summary="));
const summaryPath = summaryArg ? summaryArg.slice("--summary=".length) : null;

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
const overlap = (a, b) => { const A = new Set(norm(a)); return norm(b).filter((w) => A.has(w)); };
// identity match: >=2 significant word overlap with truth OR truth contains the found brand+one word
const matches = (r) => (r.product ? overlap(r.truth, r.product).length >= 2 : false);

// Rule 1: junk-title detection. A "verified" product string that is a search/site page, not a
// product identity.
function junkTitleReason(product) {
  const p = product || "";
  if (/^Search For:/i.test(p)) return 'matches /^Search For:/i';
  if (/Suchergebnisse/i.test(p)) return 'matches /Suchergebnisse/i (German search-results page)';
  if (/^UPC Database/i.test(p)) return 'matches /^UPC Database/i';
  if (/^CodeCheck/i.test(p)) return 'matches /^CodeCheck/i';
  return null;
}

// Manual corrections identified during Step 2 spot-check (see header comment + task-9-report.md).
const MANUAL_WRONG_OVERRIDES = new Set(["00028400028141"]);

// Groups that can NEVER be excused by rule 2 (strict-expectation override), even with a plausible
// word-overlap "match" - their truth strings carry no exploitable identity (fnsku), or a wrong
// guess there is still a real miss (part, canary).
const NEVER_OVERRIDE_GROUPS = new Set(["fnsku", "part", "canary"]);

let wrongVerified = 0, verifiedOk = 0, findable = 0, cheapVerify = 0, cheapTried = 0, wrongLoudSuggest = 0;
let junkTitleVerifies = 0, strictExpectationOverrides = 0, errorRows = 0;
const wrongVerifiedRows = [], junkTitleRows = [], overrideRows = [], wrongLoudRows = [], errorRowsList = [];
const byGroup = {};

for (const r of rows) {
  const g = (byGroup[r.group] ??= {
    n: 0, verified: 0, suggested: 0, refused: 0, error: 0,
    wrong: 0, junk: 0, override: 0, matched: 0,
  });
  g.n++;
  g[r.outcome] = (g[r.outcome] ?? 0) + 1;

  if (r.outcome === "error") {
    errorRows++;
    errorRowsList.push(r);
    continue; // Rule 5: excluded from all rate gates.
  }

  if (r.outcome === "verified") {
    const junk = junkTitleReason(r.product);
    const manualOverride = MANUAL_WRONG_OVERRIDES.has(r.code);
    const isMatch = r.group === "fnsku" ? false : matches(r); // Rule 3: fnsku never identity-matched

    if (junk) {
      // Rule 1: junk-title verifies are wrong REGARDLESS of expected value.
      wrongVerified++; g.wrong++;
      junkTitleVerifies++; g.junk++;
      junkTitleRows.push({ r, reason: junk });
      wrongVerifiedRows.push({ r, reason: `junk-title (${junk})` });
    } else if (manualOverride) {
      wrongVerified++; g.wrong++;
      wrongVerifiedRows.push({ r, reason: "manual spot-check override (identity swap with another row - see script header)" });
    } else if (r.expected === "must-refuse") {
      wrongVerified++; g.wrong++;
      wrongVerifiedRows.push({ r, reason: "expected must-refuse, got verified" });
    } else if (r.expected === "suggest-only") {
      if (!NEVER_OVERRIDE_GROUPS.has(r.group) && isMatch) {
        // Rule 2: correct identity on a conservative suggest-only expectation is a win.
        strictExpectationOverrides++; g.override++;
        overrideRows.push(r);
      } else {
        wrongVerified++; g.wrong++;
        wrongVerifiedRows.push({ r, reason: NEVER_OVERRIDE_GROUPS.has(r.group) ? `expected suggest-only, group "${r.group}" is never excused` : "expected suggest-only, no identity match" });
      }
    } else {
      // expected === "verified-ok"
      if (isMatch) { verifiedOk++; }
      else { wrongVerified++; g.wrong++; wrongVerifiedRows.push({ r, reason: "expected verified-ok, identity does not match truth" }); }
    }

    if (isMatch) g.matched++;

    // Rule 4: cheap-verify rate. Every row attempts the cheap tier (Gemini + fetch) first;
    // "cheap" = resolved without GPT-5 escalation. Reconstructed rows use the cost-inferred
    // stageInferred; live-stage rows use the real stage object (gpt55 absent = cheap).
    const isCheap = r.reconstructed ? r.stageInferred === "cheap" : !(r.stage && r.stage.gpt55);
    if (isCheap) cheapVerify++;
  } else {
    // outcome === "suggested" (or any other non-verified, non-error outcome, e.g. "refused")
    const isMatch = r.group === "fnsku" ? false : matches(r); // Rule 3
    if (isMatch) g.matched++;
    if (r.group !== "fnsku" && r.product && !isMatch && (r.guessConfidence ?? 0) > 0.4) {
      wrongLoudSuggest++;
      wrongLoudRows.push(r);
    }
  }

  if (r.expected === "verified-ok") findable++;
  cheapTried++; // every row goes through the cheap tier first, per the sequential ladder design
}

const gates = {
  "wrong auto-counts (HARD FAIL if >0)": wrongVerified,
  "auto-count rate on findable (target >=70%)": `${((verifiedOk / Math.max(1, findable)) * 100).toFixed(1)}% (${verifiedOk}/${findable})`,
  "cheap-verify success (build if >=50%)": `${((cheapVerify / Math.max(1, cheapTried)) * 100).toFixed(1)}% (${cheapVerify}/${cheapTried})`,
  "wrong suggestions above 0.4 (must be 0)": wrongLoudSuggest,
  "avg cost/code": `$${(spent / Math.max(1, rows.length)).toFixed(3)}`,
  "total spend": `$${spent.toFixed(2)} (cap $15.00)`,
};

console.log("== GATES ==");
for (const [k, v] of Object.entries(gates)) console.log(`  ${k}: ${v}`);

console.log(`\n== ADJUDICATION COUNTS ==`);
console.log(`  junkTitleVerifies: ${junkTitleVerifies}`);
console.log(`  strictExpectationOverrides: ${strictExpectationOverrides}`);
console.log(`  errorRows: ${errorRows}`);
console.log(`  reconstructed rows (cost-inferred stage): ${rows.filter((r) => r.reconstructed).length} / ${rows.length}`);

console.log("\n== GROUPS ==");
for (const [g, s] of Object.entries(byGroup)) console.log(`  ${g}: ${JSON.stringify(s)}`);

if (wrongVerifiedRows.length) {
  console.log("\n== WRONG-VERIFIED ROWS (eyeball each; word-overlap matcher is a heuristic) ==");
  for (const { r, reason } of wrongVerifiedRows) {
    console.log(`  ${r.code} [${r.group}] expected=${r.expected} reason="${reason}"${r.reconstructed ? " (reconstructed)" : ""}`);
    console.log(`      product="${r.product}"`);
    console.log(`      truth="${r.truth}"`);
  }
}

if (overrideRows.length) {
  console.log("\n== STRICT-EXPECTATION-OVERRIDE ROWS (correct identity on a conservative suggest-only fixture row) ==");
  for (const r of overrideRows) {
    console.log(`  ${r.code} [${r.group}] product="${r.product}" truth="${r.truth}"`);
  }
}

if (wrongLoudRows.length) {
  console.log("\n== WRONG-LOUD-SUGGEST ROWS (suggested, no match, guessConfidence > 0.4) ==");
  for (const r of wrongLoudRows) console.log(`  ${r.code} [${r.group}] conf=${r.guessConfidence} product="${r.product}" truth="${r.truth}"`);
}

if (errorRowsList.length) {
  console.log("\n== ERROR-OUTCOME ROWS (excluded from rates) ==");
  for (const r of errorRowsList) console.log(`  ${r.code} [${r.group}]`);
}

const canaryRows = rows.filter((r) => r.group === "canary");
console.log("\n== CANARY OUTCOMES (expected must-refuse; pass = not verified) ==");
for (const r of canaryRows) console.log(`  ${r.code} outcome=${r.outcome}${r.outcome === "verified" ? " <-- FAIL" : " (pass)"}`);
const canaryFails = canaryRows.filter((r) => r.outcome === "verified").length;
console.log(`  canary fails: ${canaryFails}/${canaryRows.length}`);

console.log("\n== DEFECT SUMMARY: junk-title verifies (fix-list for search-page-rejection work) ==");
if (junkTitleRows.length) {
  for (const { r, reason } of junkTitleRows) {
    console.log(`  ${r.code} [${r.group}] expected=${r.expected} product="${r.product}" -- ${reason}`);
  }
} else {
  console.log("  (none)");
}

const verdict = wrongVerified === 0 && cheapVerify / Math.max(1, cheapTried) >= 0.5
  ? "BUILD Option B"
  : wrongVerified > 0
    ? "HARD FAIL - redesign gate"
    : "cheap-verify weak - consider Option C or owner call";
console.log(`\nVERDICT: ${verdict}`);

if (summaryPath) {
  const summary = {
    spent, totalRows: rows.length,
    gates: {
      wrongVerified,
      autoCountRate: verifiedOk / Math.max(1, findable),
      verifiedOk, findable,
      cheapVerifyRate: cheapVerify / Math.max(1, cheapTried),
      cheapVerify, cheapTried,
      wrongLoudSuggest,
      avgCostPerCode: spent / Math.max(1, rows.length),
      totalSpend: spent,
    },
    junkTitleVerifies, strictExpectationOverrides, errorRows,
    reconstructedCount: rows.filter((r) => r.reconstructed).length,
    byGroup,
    wrongVerifiedRows: wrongVerifiedRows.map(({ r, reason }) => ({ code: r.code, group: r.group, expected: r.expected, product: r.product, truth: r.truth, reconstructed: !!r.reconstructed, reason })),
    junkTitleRows: junkTitleRows.map(({ r, reason }) => ({ code: r.code, group: r.group, expected: r.expected, product: r.product, truth: r.truth, reason })),
    overrideRows: overrideRows.map((r) => ({ code: r.code, group: r.group, product: r.product, truth: r.truth })),
    wrongLoudRows: wrongLoudRows.map((r) => ({ code: r.code, group: r.group, product: r.product, truth: r.truth, guessConfidence: r.guessConfidence })),
    canaryRows: canaryRows.map((r) => ({ code: r.code, outcome: r.outcome })),
    canaryFails,
    verdict,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.error(`\n(summary written to ${summaryPath})`);
}
