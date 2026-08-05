#!/usr/bin/env node
// Pre-import gate for the corrected boss workbook (CSV export). Classifies rows; NEVER touches a DB.
// Usage: node scripts/boss-workbook-reconcile-dryrun.mjs path/to/workbook.csv
import { readFileSync } from "node:fs";

export function gs1CheckDigitValid(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function classifyRows(rows) {
  const accepted = [], needsReview = [], blanks = [];
  for (const row of rows) {
    const barcode = String(row.barcode ?? "").trim();
    if (!barcode) blanks.push(row);
    else if (gs1CheckDigitValid(barcode)) accepted.push(row);
    else needsReview.push(row);
  }
  return { accepted, needsReview, blanks };
}

function parseCsv(text) {
  const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = header.split(",").map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
  });
}

const csvPath = process.argv[2];
if (csvPath) {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const out = classifyRows(rows);
  console.log(JSON.stringify({ counts: { accepted: out.accepted.length, needsReview: out.needsReview.length, blanks: out.blanks.length }, ...out }, null, 2));
}
