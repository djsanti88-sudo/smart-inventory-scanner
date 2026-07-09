#!/usr/bin/env node
// Task 13 — Prefix-DB evaluation (OFFLINE report; adoption owner-gated).
//
// Standalone tooling. NO src changes, NO behavior change. This script only MEASURES
// what a brand-prefix firewall on Go-UPC hits would have caught on a real 200-code run.
//
// Owner decision 2026-07-08 evening: Go-UPC exact hits auto-count after the brand-prefix
// firewall ONLY (a prefix-owner conflict routes to Needs Review). That decision is ALREADY
// APPROVED. This report quantifies the expected trigger rate and coverage, and flags the
// one confirmed live error (092971135485 Westlake-vs-Bridgestone).
//
// Inputs (offline, checked-in):
//   scripts/tmp-goupc-200-tires-results.json   (rows with code, corpus{brand}, goupc{brand}, hit)
//   src/services/catalog/brandPrefixMap.json    (distilled single-brand map the LIVE firewall consumes)
//   src/services/catalog/derivedPrefixMap.json  (raw derived per-prefix stats the distilled map is built from)
//
// Keying scheme (matches the live firewall in brandPrefixGeneral.ts): 7-digit GS1 company
// prefix = digits-only code, sliced [0,7). Both maps are 7-digit keyed.
//
// Usage:
//   node scripts/eval-prefix-db.mjs            # OFFLINE (default) — report only
//   node scripts/eval-prefix-db.mjs --fetch-meros   # (do NOT run casually) additionally fetches up
//                                                    # to 20 meros.io prefix pages at 1 req/s for
//                                                    # prefixes MISSING from the map, to estimate the
//                                                    # coverage delta a free prefix source would add.
//
// Output: scripts/prefix-db-eval-report.md

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const RESULTS_PATH = join(ROOT, "scripts", "tmp-goupc-200-tires-results.json");
const DISTILLED_MAP_PATH = join(ROOT, "src", "services", "catalog", "brandPrefixMap.json");
const DERIVED_MAP_PATH = join(ROOT, "src", "services", "catalog", "derivedPrefixMap.json");
const REPORT_PATH = join(ROOT, "scripts", "prefix-db-eval-report.md");

const FETCH_MEROS = process.argv.includes("--fetch-meros");
const MEROS_MAX = 20; // hard cap on unknown-prefix fetches
const MEROS_GAP_MS = 1000; // 1 req/s pacing

const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
const distilledMap = JSON.parse(readFileSync(DISTILLED_MAP_PATH, "utf8"));
const derivedMap = JSON.parse(readFileSync(DERIVED_MAP_PATH, "utf8"));

// ---- brand comparison: EXACT copy of the live firewall's logic (brandPrefixGeneral.ts) ----
function normalizeBrand(b) {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// prefixBrandConflict, verbatim behavior from src/services/catalog/brandPrefixGeneral.ts.
// True ONLY when the code's 7-digit prefix is a KNOWN single-brand prefix in the DISTILLED map
// AND the decoded brand is clearly not that brand.
function prefixBrandConflict(code, brand) {
  const digits = (code || "").replace(/\D/g, "");
  if (digits.length < 8) return false;
  const expected = distilledMap[digits.slice(0, 7)];
  if (!expected) return false;
  const got = normalizeBrand(brand);
  if (!got) return false;
  if (got === expected) return false;
  const e0 = expected.split(" ")[0];
  const g0 = got.split(" ")[0];
  if (e0 && got.includes(e0)) return false;
  if (g0 && expected.includes(g0)) return false;
  return true;
}

// Generic "do these two brand strings agree?" used to compare corpus truth vs Go-UPC.
// Same tolerant shared-leading-token rule as the firewall. Returns true / false / null(unknown).
function brandsAgree(a, b) {
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb) return null;
  if (na === nb) return true;
  const a0 = na.split(" ")[0];
  const b0 = nb.split(" ")[0];
  if (a0 && nb.includes(a0)) return true;
  if (b0 && na.includes(b0)) return true;
  return false;
}

function prefixOf(code) {
  return (code || "").replace(/\D/g, "").slice(0, 7);
}

// Documented same-company brand aliases (owner-verifiable). A firewall fire between two
// brands in the same set is a FALSE POSITIVE, not a real wrong-brand hit. Kept tiny and
// explicit on purpose — this is evidence for the report, not a shipped brand-alias table.
const SAME_COMPANY = [["carlstar", "carlisle"]];
function sameCompany(a, b) {
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb) return false;
  return SAME_COMPANY.some((grp) => {
    const inA = grp.some((x) => na.includes(x));
    const inB = grp.some((x) => nb.includes(x));
    return inA && inB;
  });
}

// Verdict for a firewall-flagged row: is the map owner actually the same company as the
// (correct) brand Go-UPC returned? If so the fire is a false positive.
function conflictVerdict(r) {
  if (sameCompany(r.owner, r.goupcBrand)) {
    return "FALSE POSITIVE (map owner is a same-company alias of Go-UPC's brand)";
  }
  const corpusAgreesGoupc = brandsAgree(r.corpusBrand, r.goupcBrand);
  if (corpusAgreesGoupc === true) return "FALSE POSITIVE (Go-UPC brand matches corpus truth)";
  if (corpusAgreesGoupc === false) return "TRUE conflict (Go-UPC brand disagrees with corpus truth)";
  return "unverified (no corpus truth)";
}

// Derived-map top brand for a prefix, if present (raw tuple: [purity, impurity, count, [[brand,ct]...], ...]).
function derivedTopBrand(prefix) {
  const v = derivedMap[prefix];
  if (!v || !Array.isArray(v[3]) || v[3].length === 0) return null;
  return { brand: v[3][0][0], count: v[3][0][1], purity: v[0], total: v[2] };
}

// ---- classify every HIT row ----
const hits = results.rows.filter((r) => r.hit);

const buckets = {
  knownAgree: [], // prefix in distilled map, firewall says NO conflict
  knownConflict: [], // prefix in distilled map, firewall FLAGS a conflict (prefixBrandConflict true)
  unknown: [], // prefix not in distilled map
};

// Independent signal: corpus ground-truth brand vs Go-UPC brand disagreements (the actual error class,
// regardless of whether the prefix is in the map yet). This is what a COMPLETE prefix DB would catch.
const corpusConflicts = [];

for (const r of hits) {
  const code = r.code;
  const prefix = prefixOf(code);
  const goupcBrand = (r.goupc && r.goupc.brand) || "";
  const corpusBrand = (r.corpus && r.corpus.brand) || "";
  const owner = distilledMap[prefix] || null;

  const row = { code, prefix, owner, goupcBrand, corpusBrand };

  if (owner) {
    if (prefixBrandConflict(code, goupcBrand)) buckets.knownConflict.push(row);
    else buckets.knownAgree.push(row);
  } else {
    buckets.unknown.push(row);
  }

  const agree = brandsAgree(corpusBrand, goupcBrand);
  if (agree === false) {
    corpusConflicts.push({ ...row, inMap: !!owner, derived: derivedTopBrand(prefix) });
  }
}

// Was the specific confirmed-error row flagged as a corpus conflict?
const WESTLAKE_CODE = "092971135485";
const westlakeRow = corpusConflicts.find((c) => c.code === WESTLAKE_CODE) || null;

// Unknown prefixes present in the derived (raw) map even though absent from the distilled map:
// these are prefixes the distilled generator SAW but did not promote (impure / <3 entries).
// A firewall that consulted the derived map directly could still gain coverage here.
const unknownButInDerived = buckets.unknown.filter((r) => derivedMap[r.prefix]);

// ---- OPTIONAL: meros.io fetch for prefixes MISSING from BOTH maps (off by default) ----
let merosFindings = [];
if (FETCH_MEROS) {
  const missingPrefixes = [
    ...new Set(buckets.unknown.filter((r) => !derivedMap[r.prefix]).map((r) => r.prefix)),
  ].slice(0, MEROS_MAX);
  console.log(`[--fetch-meros] fetching ${missingPrefixes.length} prefix page(s) at 1 req/s...`);
  for (const prefix of missingPrefixes) {
    try {
      const url = `https://meros.io/${encodeURIComponent(prefix)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const text = res.ok ? await res.text() : "";
      // Heuristic-only extraction; this path is not owner-approved to run yet, so it is
      // deliberately conservative — it records raw availability, not a parsed owner.
      merosFindings.push({ prefix, status: res.status, bytes: text.length });
    } catch (err) {
      merosFindings.push({ prefix, status: "error", detail: String(err && err.message) });
    }
    await new Promise((r) => setTimeout(r, MEROS_GAP_MS));
  }
}

// ---- coverage delta estimate ----
const coverageNow = buckets.knownAgree.length + buckets.knownConflict.length;
const coverageWithDerived = coverageNow + unknownButInDerived.length;

// ---- write report ----
function fmtRow(cols) {
  return `| ${cols.join(" | ")} |`;
}

const lines = [];
lines.push("# Prefix-DB Value Report for Go-UPC Hits (OFFLINE, no behavior change)");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()} by \`scripts/eval-prefix-db.mjs\` (offline mode${FETCH_MEROS ? " + --fetch-meros" : ""}).`);
lines.push("");
lines.push("## What this measures");
lines.push("");
lines.push(
  "The brand-prefix firewall (`src/services/catalog/brandPrefixGeneral.ts` -> `prefixBrandConflict`) routes a Go-UPC exact hit to Needs Review instead of auto-counting when the code's 7-digit GS1 company prefix is a KNOWN single-brand prefix and Go-UPC's brand clearly disagrees. Auto-count after the firewall is ALREADY owner-approved (decision 2026-07-08 evening). This report only quantifies the expected trigger rate and coverage over the 200-code Go-UPC tire run; it changes NO behavior."
);
lines.push("");
lines.push("- Keying scheme: `code.replace(/\\D/g,'').slice(0,7)` (7-digit prefix), matching the live firewall.");
lines.push("- Distilled map (`brandPrefixMap.json`, the firewall's actual input): " + Object.keys(distilledMap).length + " single-brand prefixes.");
lines.push("- Raw derived map (`derivedPrefixMap.json`, source stats): " + Object.keys(derivedMap).length + " prefixes.");
lines.push("");
lines.push("## Counts (Go-UPC HIT rows only)");
lines.push("");
lines.push(`Total rows in run: ${results.rows.length}. Go-UPC hits: ${hits.length}.`);
lines.push("");
lines.push(fmtRow(["Classification", "Count", "Meaning"]));
lines.push(fmtRow(["---", "---", "---"]));
lines.push(fmtRow([
  "Prefix known + brands agree",
  String(buckets.knownAgree.length),
  "Prefix in distilled map, firewall does NOT flag -> auto-count proceeds",
]));
lines.push(fmtRow([
  "Prefix known + CONFLICT (firewall fires)",
  String(buckets.knownConflict.length),
  "Prefix in distilled map, `prefixBrandConflict` = true -> routed to Needs Review",
]));
lines.push(fmtRow([
  "Prefix unknown",
  String(buckets.unknown.length),
  "Prefix not in distilled map -> firewall is a no-op (auto-count proceeds unchecked)",
]));
lines.push("");
lines.push(
  `Firewall trigger rate on this set: **${buckets.knownConflict.length} / ${hits.length} hits (${((buckets.knownConflict.length / hits.length) * 100).toFixed(1)}%)** would be diverted to Needs Review by the current distilled map.`
);
lines.push("");
lines.push("## Conflict list (with evidence)");
lines.push("");
lines.push("### A. Firewall-flagged conflicts (current distilled map, `prefixBrandConflict` = true)");
lines.push("");
if (buckets.knownConflict.length === 0) {
  lines.push("_None._");
} else {
  lines.push(fmtRow(["Code", "Prefix", "Map owner", "Go-UPC brand", "Corpus (truth)", "Verdict"]));
  lines.push(fmtRow(["---", "---", "---", "---", "---", "---"]));
  for (const r of buckets.knownConflict) {
    lines.push(fmtRow([r.code, r.prefix, r.owner, r.goupcBrand || "(none)", r.corpusBrand || "(none)", conflictVerdict(r)]));
  }
}
lines.push("");
lines.push("### B. Corpus-truth vs Go-UPC brand disagreements (the real error class, prefix-map-independent)");
lines.push("");
lines.push(
  "These are hits where the tire corpus ground-truth brand and Go-UPC's brand disagree. This is exactly the class the firewall exists to catch. A row here that is NOT in list A is a COVERAGE GAP: the prefix is not yet in the map, so the current firewall misses it."
);
lines.push("");
if (corpusConflicts.length === 0) {
  lines.push("_None._");
} else {
  lines.push(fmtRow(["Code", "Prefix", "Corpus (truth)", "Go-UPC brand", "In distilled map?", "Caught by firewall now?"]));
  lines.push(fmtRow(["---", "---", "---", "---", "---", "---"]));
  for (const c of corpusConflicts) {
    const caught = c.inMap && prefixBrandConflict(c.code, c.goupcBrand);
    lines.push(fmtRow([
      c.code,
      c.prefix,
      c.corpusBrand || "(none)",
      c.goupcBrand || "(none)",
      c.inMap ? "yes" : "NO",
      caught ? "yes" : "NO",
    ]));
  }
}
lines.push("");
lines.push(`Confirmed live error (Westlake vs Bridgestone) flagged: **${westlakeRow ? "YES" : "NO"}**`);
if (westlakeRow) {
  const caughtByFirewall = westlakeRow.inMap && prefixBrandConflict(westlakeRow.code, westlakeRow.goupcBrand);
  lines.push("");
  lines.push(
    `- \`${westlakeRow.code}\`: corpus truth = **${westlakeRow.corpusBrand}**, Go-UPC = **${westlakeRow.goupcBrand}**. Prefix \`${westlakeRow.prefix}\` in distilled map: **${westlakeRow.inMap ? "yes" : "NO"}**. Caught by the CURRENT firewall: **${caughtByFirewall ? "yes" : "NO"}**.`
  );
  if (!caughtByFirewall) {
    lines.push(
      `- IMPORTANT: this true error is a COVERAGE GAP. The prefix \`${westlakeRow.prefix}\` is absent from the distilled map, so \`prefixBrandConflict\` returns false and the current firewall would NOT divert it. It is only visible here because the offline corpus provides an independent ground-truth brand. The firewall's value on this error depends on adding the prefix to the map (see coverage delta + meros door below).`
    );
  }
}
lines.push("");
lines.push("## Coverage delta estimate");
lines.push("");
lines.push(fmtRow(["Prefix source", "Hits with a known prefix", "Coverage of hits"]));
lines.push(fmtRow(["---", "---", "---"]));
lines.push(fmtRow(["Distilled map (current firewall)", String(coverageNow), `${((coverageNow / hits.length) * 100).toFixed(1)}%`]));
lines.push(fmtRow([
  "+ raw derived map (prefixes seen but not promoted)",
  String(coverageWithDerived),
  `${((coverageWithDerived / hits.length) * 100).toFixed(1)}%`,
]));
lines.push("");
lines.push(
  `- ${unknownButInDerived.length} hit prefix(es) are present in the raw derived map but were NOT promoted to the distilled single-brand map (impure or < 3 entries). Consulting the derived map directly (with a purity gate) is a possible free coverage gain, but risks the false-positive class already seen in list A.`
);
lines.push(
  `- ${buckets.unknown.filter((r) => !derivedMap[r.prefix]).length} hit prefix(es) are absent from BOTH maps (including the Westlake prefix \`0929711\`). Only an external prefix source (e.g. meros.io) could add these.`
);
lines.push("");
lines.push("### meros.io free prefix door (coverage for prefixes missing from both maps)");
lines.push("");
if (FETCH_MEROS) {
  lines.push(`Fetched ${merosFindings.length} prefix page(s) at 1 req/s (cap ${MEROS_MAX}).`);
  lines.push("");
  lines.push(fmtRow(["Prefix", "HTTP status", "Bytes / detail"]));
  lines.push(fmtRow(["---", "---", "---"]));
  for (const m of merosFindings) {
    lines.push(fmtRow([m.prefix, String(m.status), String(m.bytes ?? m.detail ?? "")]));
  }
} else {
  lines.push(
    "Not fetched (offline mode). Re-run with `--fetch-meros` to fetch up to " +
      MEROS_MAX +
      " meros.io prefix pages at 1 req/s for prefixes missing from both maps and estimate the added coverage. This path is implemented but left OFF pending an owner decision — running it is a network call, not a behavior change."
  );
}
lines.push("");
lines.push("## False-positive finding (load-bearing)");
lines.push("");
lines.push(
  "On this set the firewall's only two fires (list A) are BOTH false positives: prefix owner `carlstar` vs Go-UPC `Carlisle` / `Carlisle Tire`. Carlstar Wheel & Tire owns the Carlisle brand, so these are the same company; the firewall's shared-leading-token matcher does not recognize `carlstar` and `carlisle` as related and flags a conflict. Net: with the current distilled map, the firewall would send 2 correct auto-counts to Needs Review and would still MISS the one true error. This does not change the owner-approved decision (firewall on, auto-count after) but is the accuracy cost the map quality drives."
);
lines.push("");
lines.push("## GO / NO-GO recommendation");
lines.push("");
lines.push(fmtRow(["Item", "Recommendation", "Rationale / evidence"]));
lines.push(fmtRow(["---", "---", "---"]));
lines.push(fmtRow([
  "Prefix firewall on Go-UPC hits",
  "GO (already owner-approved)",
  `Owner decision 2026-07-08 evening. Expected trigger rate on this 200-code run: ${buckets.knownConflict.length}/${hits.length} hits (${((buckets.knownConflict.length / hits.length) * 100).toFixed(1)}%). Low blast radius; no behavior change from this report.`,
]));
lines.push(fmtRow([
  "Improve map brand-alias handling (carlstar/carlisle)",
  "RECOMMEND (owner-gated, separate task)",
  `Both current fires are false positives (same-company brand aliases). Add a brand-alias table before the firewall's blast radius grows.`,
]));
lines.push(fmtRow([
  "Add missing prefixes (e.g. 0929711 Bridgestone) to the map",
  "RECOMMEND (owner-gated, separate task)",
  `The one confirmed live error (Westlake vs Bridgestone) is a coverage gap: prefix absent from both maps, so the firewall misses it today. Adding it (via corpus regeneration or a free source like meros.io) is what makes the firewall catch this error class.`,
]));
lines.push("");
lines.push("_No behavior change without a new owner decision recorded in the spec._");
lines.push("");

writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");

// ---- console summary ----
console.log("Prefix-DB eval complete.");
console.log(`  hits:            ${hits.length}`);
console.log(`  prefix known+agree:    ${buckets.knownAgree.length}`);
console.log(`  prefix known+CONFLICT: ${buckets.knownConflict.length} (firewall fires)`);
console.log(`  prefix unknown:        ${buckets.unknown.length}`);
console.log(`  corpus-vs-goupc brand conflicts: ${corpusConflicts.length}`);
console.log(`  Westlake (092971135485) flagged: ${westlakeRow ? "YES" : "NO"}`);
console.log(`  report written: ${REPORT_PATH}`);
