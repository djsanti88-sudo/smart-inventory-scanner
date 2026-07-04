// TEMP grader for the Option B ladder dry run (plan 2026-07-04, Task 9).
// Reads scripts/tmp-ladder-dryrun-results.json ({ spent, rows }) and scores every code
// against its pre-tagged expected outcome. Faithful to the plan's grader with two
// documented adaptations:
//  1. Results key is `rows` (the probe's actual Task-6 contract), not `results`.
//  2. 108 of 150 rows were reconstructed from the crashed first run's log (reconstructed:true)
//     and carry stageInferred ("cheap"|"escalated") instead of a full stage object; the
//     cheap-verify stats use stage.fetch when present and stageInferred otherwise, and the
//     output discloses the split so no inference is silently laundered into a hard number.
// Carry-forward from Task 5: FNSKU rows are outcome-keyed only (truth has no product identity);
// "refused" where "suggested" was expected on fnsku is acceptable, not a failure.
import { readFileSync } from "node:fs";
const { spent, rows } = JSON.parse(readFileSync(new URL("./tmp-ladder-dryrun-results.json", import.meta.url), "utf8"));

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
const overlap = (a, b) => { const A = new Set(norm(a)); return norm(b).filter((w) => A.has(w)).length; };
// identity match: >=2 significant word overlap with truth
const matches = (r) => r.product ? overlap(r.truth, r.product) >= 2 : false;

let wrongVerified = 0, verifiedOk = 0, findable = 0, cheapVerify = 0, cheapTried = 0, wrongLoudSuggest = 0;
let cheapVerifyInferred = 0, cheapTriedInferred = 0, verifiedViaCheap = 0;
const wrongVerifiedRows = [], wrongLoudRows = [];
const byGroup = {};
for (const r of rows) {
  const g = (byGroup[r.group] ??= { n: 0, verified: 0, suggested: 0, refused: 0, wrong: 0, matched: 0 });
  g.n++; g[r.outcome] = (g[r.outcome] ?? 0) + 1;
  if (r.outcome === "verified") {
    if (r.expected === "must-refuse" || r.expected === "suggest-only" || !matches(r)) { wrongVerified++; g.wrong++; wrongVerifiedRows.push(r); }
    else { verifiedOk++; }
    const cheap = r.stage?.fetch?.verified === true || (r.reconstructed && r.stageInferred === "cheap");
    if (cheap) verifiedViaCheap++;
    if (r.stage?.fetch?.verified) cheapVerify++;
    if (r.reconstructed && r.stageInferred === "cheap") cheapVerifyInferred++;
  }
  if (r.expected === "verified-ok") findable++;
  if (r.stage?.fetch) cheapTried++;
  if (r.reconstructed && r.group !== "asin") cheapTriedInferred++; // ladder always runs stage 2 for non-ASIN
  // wrong loud suggest: only assessable on live-stage rows (reconstruction forces guessConfidence=0.4, never >0.4)
  if (r.outcome === "suggested" && r.product && !matches(r) && (r.guessConfidence ?? 0) > 0.4) { wrongLoudSuggest++; wrongLoudRows.push(r); }
  if (matches(r)) g.matched++;
}
const cheapAll = cheapVerify + cheapVerifyInferred;
const triedAll = cheapTried + cheapTriedInferred;
const gates = {
  "wrong auto-counts (HARD FAIL if >0)": wrongVerified,
  "auto-count rate on findable (target >=70%)": `${((verifiedOk / Math.max(1, findable)) * 100).toFixed(1)}%  (${verifiedOk}/${findable})`,
  "cheap-verify success (build if >=50%)": `${((cheapAll / Math.max(1, triedAll)) * 100).toFixed(1)}%  (${cheapAll}/${triedAll}; live-stage ${cheapVerify}/${cheapTried}, inferred ${cheapVerifyInferred}/${cheapTriedInferred})`,
  "verified via cheap stage (share of all verified)": `${((verifiedViaCheap / Math.max(1, verifiedOk + wrongVerified)) * 100).toFixed(1)}%  (${verifiedViaCheap}/${verifiedOk + wrongVerified})`,
  "wrong suggestions above 0.4 (must be 0)": `${wrongLoudSuggest} (assessable on ${rows.filter((r) => !r.reconstructed).length} live-stage rows only)`,
  "avg cost/code": `$${(spent / Math.max(1, rows.length)).toFixed(3)}`,
  "total spend": `$${spent.toFixed(2)} (cap $15.00)`,
};
console.log("== GATES ==");
for (const [k, v] of Object.entries(gates)) console.log(`  ${k}: ${v}`);
console.log("== GROUPS ==");
for (const [g, s] of Object.entries(byGroup)) console.log(`  ${g}: ${JSON.stringify(s)}`);
if (wrongVerifiedRows.length) {
  console.log("== WRONG-VERIFIED ROWS (eyeball each; grader word-overlap is a heuristic) ==");
  for (const r of wrongVerifiedRows) console.log(`  ${r.code} [${r.group}] expected=${r.expected} product="${r.product}" truth="${r.truth}"${r.reconstructed ? " (reconstructed)" : ""}`);
}
if (wrongLoudRows.length) {
  console.log("== WRONG-LOUD-SUGGEST ROWS ==");
  for (const r of wrongLoudRows) console.log(`  ${r.code} [${r.group}] conf=${r.guessConfidence} product="${r.product}" truth="${r.truth}"`);
}
console.log(`VERDICT: ${wrongVerified === 0 && cheapAll / Math.max(1, triedAll) >= 0.5 ? "BUILD Option B" : wrongVerified > 0 ? "HARD FAIL - redesign gate" : "cheap-verify weak - consider Option C or owner call"}`);
