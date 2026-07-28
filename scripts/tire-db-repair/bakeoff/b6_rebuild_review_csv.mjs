#!/usr/bin/env node
// Task B6 - final review-CSV rebuild. During the overnight run the applier appended a review row
// for every below-gate result at the moment it was seen; allowlist widening + re-apply passes
// later APPLIED some of those fills, and re-apply passes also logged noise rows
// ("already_filled_since_batch_dispatch") for fills that had already landed. This script rebuilds
// ENRICHMENT_REVIEW.csv to its honest final state:
//   - drop rows whose reason is 'already_filled_since_batch_dispatch' (re-apply noise, not a
//     genuine review item),
//   - drop rows whose (barcode, field) is NO LONGER blank in the DB (the fill was subsequently
//     applied through the gate, so there is nothing left to review),
//   - dedupe identical (barcode, field, attempted_value, source_url, reason) rows (zero-pad
//     sibling barcodes stay as separate rows on purpose - they are separate DB rows),
//   - keep everything else verbatim.
// The pre-rebuild file is preserved alongside as ENRICHMENT_REVIEW.raw.csv for audit.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPAIR_DIR = path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28");
const CSV = path.join(REPAIR_DIR, "ENRICHMENT_REVIEW.csv");
const RAW = path.join(REPAIR_DIR, "ENRICHMENT_REVIEW.raw.csv");
const DB_PATH = path.join(REPAIR_DIR, "REPAIRED_TIRE_DATABASE.db");

// Minimal CSV line parser handling quoted fields (the applier quotes fields containing , " \n).
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const raw = fs.readFileSync(CSV, "utf8");
fs.writeFileSync(RAW, raw, "utf8"); // preserve pre-rebuild state

const lines = raw.trim().split("\n");
const header = lines[0];
const db = new Database(DB_PATH, { readonly: true });
db.pragma("busy_timeout = 30000");
const rowStmt = db.prepare("SELECT brand, model, size, manufacturer_part_number FROM tires WHERE barcode = ?");

const seen = new Set();
const kept = [];
let droppedNoise = 0;
let droppedApplied = 0;
let droppedDupe = 0;

for (const line of lines.slice(1)) {
  const cols = parseCsvLine(line);
  // header: batch_id,id,barcode,field,attempted_value,source_url,source_host,confidence,reason
  const [batchId, id, barcode, field, attemptedValue, sourceUrl, , , reason] = cols;
  if (reason === "already_filled_since_batch_dispatch" || reason === "update_guard_blocked_concurrent_write") {
    droppedNoise++;
    continue;
  }
  if (["brand", "model", "size", "manufacturer_part_number"].includes(field)) {
    const live = rowStmt.get(barcode);
    if (live) {
      const v = live[field];
      const blank = v === null || v === undefined || String(v).trim() === "";
      if (!blank) {
        droppedApplied++;
        continue;
      }
    }
  }
  const key = [barcode, field, attemptedValue, sourceUrl, reason].join("");
  if (seen.has(key)) {
    droppedDupe++;
    continue;
  }
  seen.add(key);
  kept.push(line);
}
db.close();

fs.writeFileSync(CSV, header + "\n" + kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
console.log(
  JSON.stringify(
    { keptRows: kept.length, droppedReapplyNoise: droppedNoise, droppedSubsequentlyApplied: droppedApplied, droppedDuplicates: droppedDupe },
    null,
    2
  )
);
