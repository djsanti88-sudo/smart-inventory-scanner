// scripts/pilot-backfill-worklist.mjs (Task B1)
//
// Offline harness: reads the shop's ON-HAND tire list, maps it to reconcile
// ExpectedInventoryRow shape, and runs it through the REAL (tested) reconcile
// matcher via POST /api/reconcile/match. Nothing here reimplements matching -
// this file is transport + column mapping + worklist formatting only.
//
// Output is a review-gated CANDIDATE worklist, never an attachment: every row
// requires human confirmation before any barcode is linked to a part number.
// The weakest evidence tier (affix-core-only part-number hits) is tagged
// explicitly so a reviewer knows to double-check those first.
//
// Untrusted input: the on-hand CSV is external/uploaded data - every cell is
// parsed as plain text (semantic firewall), never interpreted as instructions.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "csv-parse/sync";

// Positional arg is the CSV path; flags (e.g. --dry) must never be mistaken for it.
const cliArgs = process.argv.slice(2);
const csvArg = cliArgs.find((a) => !a.startsWith("--"));
const CSV = csvArg ?? "C:/Users/djsan/Downloads/tires_inventory_379.csv";
const ENDPOINT = process.env.RECONCILE_URL ?? "http://localhost:3100/api/reconcile/match";
const OUT = "docs/pilot/point-s-backfill-worklist.csv";
const DRY = cliArgs.includes("--dry") || process.env.DRY === "1";

// Columns (on-hand file): PART NAME,PART TYPE,P/N,TAGS
// - PART NAME: brand + model + size + specs, descriptive text.
// - PART TYPE: always "Tire" (ignored).
// - P/N: shop part number - the row's stable external id.
// - TAGS: a size slug (e.g. "2456018"); kept as-is, never parsed for size here.
const records = parse(readFileSync(CSV, "utf8"), {
  columns: (headers) => headers.map((c) => c.trim().toLowerCase()),
  skip_empty_lines: true,
  relax_column_count: true,
  relax_quotes: true,
  trim: true,
  bom: true,
});

const rows = [];
for (const r of records) {
  const pn = (r["p/n"] ?? "").trim();
  if (!pn) continue; // no part number to key off of - nothing to reconcile
  const partName = (r["part name"] ?? "").trim();
  const tags = (r["tags"] ?? "").trim();
  rows.push({
    externalId: pn,
    partNumbers: [pn],
    brand: partName.split(/\s+/)[0] || undefined,
    model: partName || undefined,
    specs: `${partName} ${tags}`.trim() || undefined,
    sizeText: tags || undefined,
    qty: 0, // catalog backfill has no physical counts; the matcher ignores qty
    raw: {},
  });
}

if (DRY) {
  console.log(`mapped rows: ${rows.length}`);
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ rows }),
});
if (!res.ok) {
  console.error(`Matcher returned ${res.status}. Is \`npm run dev\` running on 3100?`);
  process.exit(1);
}
const { matches } = await res.json();

const tally = { matched: 0, ambiguous: 0, unmatched: 0, non_tire: 0 };
// Evidence tier per match. Every "matched" row is still a CANDIDATE requiring
// human confirmation before it becomes an attachment - never auto-applied here.
const tierOf = (m) =>
  m.status !== "matched"
    ? m.status
    : m.viaAffixCore
      ? "candidate_affix_core (confirm)"
      : "candidate_pn_brand_size (confirm)";
const q = (f) => `"${String(f).replace(/"/g, '""')}"`;
const out = [
  [
    "externalId",
    "partNumber",
    "evidenceTier",
    "candidateBarcode_CONFIRM_REQUIRED",
    "corpusBrand",
    "corpusModel",
    "reason",
  ],
];
for (const m of matches) {
  tally[m.status] = (tally[m.status] ?? 0) + 1;
  out.push([
    m.row.externalId,
    m.row.partNumbers[0],
    tierOf(m),
    m.linkageSuggestion?.barcode ?? "",
    m.candidate?.brand ?? "",
    m.candidate?.name ?? "",
    (m.reason ?? "").replace(/[\r\n,]+/g, " "),
  ]);
}
mkdirSync("docs/pilot", { recursive: true });
writeFileSync(OUT, out.map((row) => row.map(q).join(",")).join("\n"), "utf8");

console.log(`On-hand rows with a part number: ${matches.length}`);
console.log(`  matched (candidate barcode to confirm): ${tally.matched}`);
console.log(`  ambiguous (human picks):                ${tally.ambiguous}`);
console.log(`  unmatched (sourcing needed):            ${tally.unmatched}`);
console.log(`  non_tire:                               ${tally.non_tire}`);
console.log(`Worklist written to ${OUT}`);
