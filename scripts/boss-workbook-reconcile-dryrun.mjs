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

// Single-pass RFC-4180 state machine over the WHOLE text (never pre-split into lines - a naive
// split-then-parse-per-line approach corrupts any quoted field that legitimately contains a comma
// AND a newline, since the pre-split cuts the record in half before quote-awareness ever sees it,
// and an unterminated quote silently absorbs the rest of the file as "one giant field" instead of
// failing loudly). Handles: commas and newlines inside quoted fields, the "" escaped-quote sequence,
// and both \n and \r\n line endings. An unterminated quote at EOF throws, naming the record number
// (1-based, counting the header row as record 1) so the caller can find the bad row in the source file.
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let recordNumber = 1;
  const len = text.length;

  const endField = () => {
    row.push(field.trim());
    field = "";
  };
  const endRecord = () => {
    endField();
    rows.push(row);
    row = [];
    recordNumber++;
  };

  let i = 0;
  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      endField();
      i++;
      continue;
    }
    if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
      i++;
      continue;
    }
    if (char === "\n") {
      endRecord();
      i++;
      continue;
    }
    field += char;
    i++;
  }

  if (inQuotes) {
    throw new Error(
      `Malformed CSV: unterminated quoted field starting in record ${recordNumber} (counting the header row as record 1). Check for a stray or missing closing quote.`
    );
  }

  // A trailing newline already closed the last record above and left field/row empty - only flush
  // a final record here when the file's last line has no trailing newline.
  if (field !== "" || row.length > 0) endRecord();

  // Drop genuinely blank lines (mirrors the previous behavior of filtering empty lines out of the
  // raw text before parsing), but never a row that has real column structure (e.g. ",,,,").
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseCsv(text) {
  const [header, ...lines] = parseCsvRows(text);
  if (!header) return [];
  return lines.map((cells) => Object.fromEntries(header.map((c, i) => [c, cells[i] ?? ""])));
}

const csvPath = process.argv[2];
if (csvPath) {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const out = classifyRows(rows);
  console.log(JSON.stringify({ counts: { accepted: out.accepted.length, needsReview: out.needsReview.length, blanks: out.blanks.length }, ...out }, null, 2));
}
