#!/usr/bin/env node
// Task B6 - Codex scaled enrichment: trust gate + applier.
//
// Consumes a batch of enrichment results in the same blind result contract
// shape used by the B1-B3 bakeoff lanes:
//   { id, lane, fills: { <field>: <value>, ... }, source_url, source_host, evidence_quote,
//     confidence, ... }
// joined back to the batch's own INPUT file (batch_N_input.json), which carries the row shape:
//   { id, barcode, known_fields, missing_fields }
// so the applier can recover the exact barcode a given result id refers to (results never repeat
// the barcode themselves, exactly like the bakeoff format).
//
// Trust gate (every field-level fill must pass ALL of these before it is written):
//   1. Non-placeholder barcode (placeholder = numeric core, leading zeros stripped, <= 6 digits;
//      same rule as B5's remaining_blanks.json builder - these barcodes are excluded from batch
//      inputs in the first place, but re-checked here defensively).
//   2. source_url present and its host is on the TRUSTED_HOST allowlist (see below).
//   3. Exact barcode tie: evidence_quote (or source_url) must contain the literal input barcode,
//      OR a zero-padding/GTIN-length-normalized variant of it (leading zeros only - never a
//      substring/fuzzy match on a DIFFERENT digit sequence). This is the "exact barcode match"
//      global-constraint requirement, checked programmatically, not just trusted from Codex's
//      "confidence" self-report.
//   4. Blank-only: the target field is currently blank in the DB for that barcode (re-checked
//      live against the DB at apply time, never trusted from the batch input snapshot, since the
//      DB may have been filled by an earlier batch or B5 in the meantime).
//   5. Non-empty fill value.
//
// Anything that fails ANY of the above, or where fills is empty / field not in missing_fields,
// is appended to repair-2026-07-28/ENRICHMENT_REVIEW.csv with a `reason` column (never silently
// dropped).
//
// On pass: provenance upsert (source_name=<host>, source_ref=<url>,
// evidence_level='web_trusted_single_source') + audit row (remaining_blank_fill_audit,
// action='codex_enrichment_fill', trust_color='green') + the actual UPDATE, all inside one short
// db.transaction() per batch.
//
// Concurrency: PRAGMA busy_timeout=30000 set immediately after opening the DB. No long-lived
// transaction spans the whole script - one transaction per batch file.
//
// Modes:
//   --dry-run              : print what WOULD apply/review, write nothing to the DB or CSV.
//   --batch <path>          : path to a results_*.json enrichment file.
//   --input <path>          : path to the matching batch_*_input.json (for barcode lookup by id).
//   --source-label <name>   : optional override for the "lane" label recorded in review reasons.
//
// No git commands. No live Turso write, no push, no deploy.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const DB_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
);
const REVIEW_CSV_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/ENRICHMENT_REVIEW.csv"
);

const SOURCE_TAG = "codex_enrichment_fill";
const EVIDENCE_LEVEL = "web_trusted_single_source";
const FILLABLE_FIELDS = ["brand", "model", "size", "manufacturer_part_number"];

// ---- Trusted-host allowlist -----------------------------------------------------------------
// Documented per the brief: manufacturer domains, major tire retailers named explicitly
// (discounttire, tirerack, tirebuyer, simpletire, prioritytire, walmart, ebay item pages that
// print the exact UPC), plus "obvious tire retailers" observed as legitimate sources during the
// B1-B3 bakeoff (americastire is Discount Tire's sister brand; continental-tires.com is the
// manufacturer's own domain; barcodesdatabase.org is a barcode-lookup reference site the bakeoff
// treated as trusted when it produced an exact structural barcode-to-spec tie).
//
// Registrable-domain match only (host === domain, or host ends with "." + domain) - never a
// substring - mirrors src/services/ai/trustedProductHosts.ts's matching rule, extended with the
// additional retailers/manufacturers this brief names.
const TRUSTED_HOSTS = [
  // Major tire retailers (brief-named)
  "discounttire.com",
  "americastire.com", // Discount Tire's sister brand, same corporate family
  "tirerack.com",
  "tirebuyer.com",
  "simpletire.com",
  "prioritytire.com",
  "walmart.com",
  "ebay.com", // item pages only; exact-UPC-in-quote check below still applies
  "ebay.ca", // same marketplace/trust level as ebay.com (added after batch 1: legit eBay Canada item pages were review-queued)
  // General/obvious tire retailers seen in bakeoff evidence
  "target.com",
  "amazon.com",
  "shopcwo.com",
  "barcodesdatabase.org",
  // Major tire/auto distributors added after batch 6 review triage (2026-07-28, documented in
  // B6_ENRICHMENT_REPORT.md): each is a large, well-known tire or auto-parts retailer or
  // distributor, not a small tuning shop. Small/unknown shops (blackopsautoworks, goturbo,
  // speedzone-web, koleso.ru, etc.) intentionally stay OUT and remain review-queued.
  "ntwonline.com", // NTW - National Tire Wholesale (TBC Corp / Michelin joint venture)
  "reifendirekt.de", // Delticom AG, Europe's largest online tire retailer
  "tirendo.de", // Delticom brand
  "tirendo.fr", // Delticom brand
  "tirendo.es", // Delticom brand
  "tirendo.co.uk", // Delticom brand
  "tirendo.ro", // Delticom brand
  "neumaticos-online.es", // Delticom brand
  "autodoc.de", // Autodoc SE, major EU auto-parts retailer
  "autodoc.es", // Autodoc SE
  "autodoc.co.uk", // Autodoc SE
  "allopneus.com", // major French tire retailer (Michelin-invested)
  "summitracing.com", // major US performance/auto retailer
  "tireagent.com", // US online tire retailer
  "carrefour.es", // Carrefour (major EU retail chain)
  "ebay.de", // same marketplace family as ebay.com/ebay.ca
  // Major agricultural/industrial tire wholesalers added after batch 12 triage (queue tail is
  // specialty/agri tires; these are large established B2B distributors, not small shops):
  "bohnenkamp.de", // Bohnenkamp AG, major EU agri-tire wholesaler (Osnabrueck)
  "bohnenkamp.at", // Bohnenkamp country shop
  "bohnenkamp.sk", // Bohnenkamp country shop
  "bohnenkamp.kz", // Bohnenkamp country shop
  "bohnenkamp.uz", // Bohnenkamp country shop
  "bohnenkamp-suisse.ch", // Bohnenkamp country shop
  "bohnenkamp-benelux.com", // Bohnenkamp country shop
  "heuver.de", // Heuver, major Dutch tire wholesaler
  "heuver.com", // Heuver
  "123pneus.fr", // Delticom brand (France)
  "motorradreifendirekt.de", // Delticom brand (motorcycle tires)
  "reifen.de", // major German tire retailer
  // Owner-approved additions (2026-07-28): large, well-known US tire/auto-parts retailers seen
  // producing exact-barcode-tied evidence in the MPN pilot review queue. Note: MPN web research
  // is CANCELLED per standing owner order, so these primarily benefit any future brand/model/size
  // enrichment the owner re-authorizes; the exact-barcode + evidence gate still applies to each.
  "carid.com", // CARiD - major US online auto-parts/tire retailer
  "tiresandwheels.com", // major US online tire & wheel retailer
  // Manufacturer domains (brief: "manufacturer domains")
  "michelin.com",
  "goodyear.com",
  "bridgestonetire.com",
  "continentaltire.com",
  "continental-tires.com",
  "pirelli.com",
  "yokohamatire.com",
  "falkentire.com",
  "toyotires.com",
  "coopertire.com",
  "bfgoodrichtires.com",
  "hankooktire.com",
  "nexentireusa.com",
  "kumhotire.com",
  "generaltire.com",
  "firestonetire.com",
  "westlaketires.com",
];


function isPlaceholderBarcode(barcode) {
  const digits = String(barcode || "").replace(/\D/g, "");
  const stripped = digits.replace(/^0+/, "");
  return stripped.length <= 6;
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

// Barcode variants accepted as "the same code" for the exact-tie check: the literal string, and
// zero-padded/zero-stripped digit variants (GTIN-8/12/13/14 representations of the same item
// reference). NEVER a different digit sequence.
function barcodeVariants(barcode) {
  const digits = digitsOnly(barcode);
  const stripped = digits.replace(/^0+/, "") || "0";
  const variants = new Set([digits, stripped]);
  for (const len of [8, 12, 13, 14]) {
    if (stripped.length <= len) variants.add(stripped.padStart(len, "0"));
  }
  return [...variants];
}

function hasExactBarcodeTie(barcode, evidenceQuote, sourceUrl) {
  const variants = barcodeVariants(barcode);
  const haystackDigitsQuote = String(evidenceQuote || "");
  const haystackUrl = String(sourceUrl || "");
  // Search both raw text (for quotes like "GTIN 758823141201") and digit-only extraction of the
  // quote (handles separators like dashes/spaces inside a printed barcode).
  const quoteDigitRuns = haystackDigitsQuote.match(/\d[\d\s-]{5,}\d/g) || [];
  const quoteDigitOnly = quoteDigitRuns.map((r) => r.replace(/\D/g, ""));
  for (const v of variants) {
    if (haystackDigitsQuote.includes(v)) return true;
    if (haystackUrl.includes(v)) return true;
    if (quoteDigitOnly.some((d) => d === v || d.replace(/^0+/, "") === v.replace(/^0+/, ""))) {
      return true;
    }
  }
  return false;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTrustedHost(url) {
  const host = hostOf(url ?? "");
  if (!host) return false;
  return TRUSTED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}

function insertProvenance(db) {
  return db.prepare(`
    INSERT INTO provenance
      (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level, license_note, content_hash)
    VALUES
      (@product_id, @barcode, @source_name, @source_ref, NULL, NULL, @batch_id, @imported_at, @evidence_level, NULL, NULL)
    ON CONFLICT(product_id, barcode, source_name, source_ref, sheet, row) DO UPDATE SET
      batch_id = excluded.batch_id,
      imported_at = excluded.imported_at,
      evidence_level = excluded.evidence_level
  `);
}

function insertAudit(db) {
  return db.prepare(`
    INSERT INTO remaining_blank_fill_audit
      (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value, new_value, candidate_count, candidate_values, reason)
    VALUES
      (@action, @trust_color, @confidence_score, @canonical_product_uid, @barcode, @previous_value, @new_value, @candidate_count, @candidate_values, @reason)
  `);
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function appendReviewRows(rows, dryRun) {
  if (rows.length === 0) return;
  const header = "batch_id,id,barcode,field,attempted_value,source_url,source_host,confidence,reason\n";
  const exists = fs.existsSync(REVIEW_CSV_PATH);
  const lines = rows.map((r) =>
    [r.batch_id, r.id, r.barcode, r.field, r.attempted_value, r.source_url, r.source_host, r.confidence, r.reason]
      .map(csvEscape)
      .join(",")
  );
  const chunk = (exists ? "" : header) + lines.join("\n") + "\n";
  if (dryRun) {
    console.log(`[DRY RUN] would append ${rows.length} row(s) to ${path.relative(REPO_ROOT, REVIEW_CSV_PATH)}`);
    return;
  }
  fs.mkdirSync(path.dirname(REVIEW_CSV_PATH), { recursive: true });
  fs.appendFileSync(REVIEW_CSV_PATH, chunk, "utf8");
}

function loadJson(p) {
  // Strip a UTF-8 BOM if present (PowerShell-written result files often carry one).
  return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const batchPath = getArg("--batch");
  const inputPath = getArg("--input");
  const sourceLabelOverride = getArg("--source-label");
  const auditActionOverride = getArg("--audit-action");

  if (!batchPath || !inputPath) {
    console.error(
      "Usage: node b6_apply_enrichment.mjs --batch <results.json> --input <batch_input.json> [--dry-run] [--source-label <label>]"
    );
    process.exit(2);
  }

  const results = loadJson(path.resolve(batchPath));
  const inputRows = loadJson(path.resolve(inputPath));
  const inputById = new Map(inputRows.map((r) => [r.id, r]));
  const batchId = `b6_${sourceLabelOverride || "codex"}_${path.basename(batchPath)}_${new Date().toISOString()}`;
  const now = new Date().toISOString();

  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 30000");

  const provStmt = insertProvenance(db);
  const auditStmt = insertAudit(db);
  const selectRowStmt = db.prepare(
    `SELECT barcode, canonical_product_uid, brand, model, size, manufacturer_part_number FROM tires WHERE barcode = ?`
  );
  const updateStmts = Object.fromEntries(
    FILLABLE_FIELDS.map((f) => [
      f,
      db.prepare(`UPDATE tires SET ${f} = ? WHERE barcode = ? AND (${f} IS NULL OR TRIM(${f}) = '')`),
    ])
  );

  const reviewRows = [];
  const applied = [];
  const perFieldFillCount = Object.fromEntries(FILLABLE_FIELDS.map((f) => [f, 0]));
  const perFieldSourceCount = {};

  function reject(result, inputRow, field, value, reason) {
    reviewRows.push({
      batch_id: batchId,
      id: result.id,
      barcode: inputRow ? inputRow.barcode : "(unknown - id not in input file)",
      field,
      attempted_value: value ?? "",
      source_url: result.source_url || "",
      source_host: result.source_host || hostOf(result.source_url || ""),
      confidence: result.confidence || "",
      reason,
    });
  }

  const applyOne = db.transaction((result) => {
    const inputRow = inputById.get(result.id);
    if (!inputRow) {
      reject(result, null, "(all)", "", "result_id_not_in_batch_input");
      return;
    }
    const barcode = inputRow.barcode;

    if (isPlaceholderBarcode(barcode)) {
      for (const field of Object.keys(result.fills || {})) {
        reject(result, inputRow, field, result.fills[field], "placeholder_barcode");
      }
      return;
    }

    const fills = result.fills || {};
    const fieldNames = Object.keys(fills);
    if (fieldNames.length === 0) {
      // Conservative empty fill (no fabrication attempted) - not a review-queue item, just a
      // no-op. Not written to the review CSV since there is nothing wrong to review.
      return;
    }

    for (const field of fieldNames) {
      const value = fills[field];
      if (!FILLABLE_FIELDS.includes(field)) {
        reject(result, inputRow, field, value, "field_not_recognized");
        continue;
      }
      if (!Array.isArray(inputRow.missing_fields) || !inputRow.missing_fields.includes(field)) {
        reject(result, inputRow, field, value, "field_not_in_missing_fields_for_this_row");
        continue;
      }
      if (value === null || value === undefined || String(value).trim() === "") {
        reject(result, inputRow, field, value, "empty_fill_value");
        continue;
      }
      if (!result.source_url || String(result.source_url).trim() === "") {
        reject(result, inputRow, field, value, "no_source_url");
        continue;
      }
      if (!isTrustedHost(result.source_url)) {
        reject(result, inputRow, field, value, `untrusted_host:${hostOf(result.source_url)}`);
        continue;
      }
      if (!hasExactBarcodeTie(barcode, result.evidence_quote, result.source_url)) {
        reject(result, inputRow, field, value, "no_exact_barcode_tie_in_evidence");
        continue;
      }

      // Re-check blank-only against the LIVE DB (never trust the input snapshot - another batch
      // or B5 may have filled it since this batch's input was generated).
      const liveRow = selectRowStmt.get(barcode);
      if (!liveRow) {
        reject(result, inputRow, field, value, "barcode_not_found_in_db");
        continue;
      }
      const currentVal = liveRow[field];
      const isBlank = currentVal === null || currentVal === undefined || String(currentVal).trim() === "";
      if (!isBlank) {
        reject(result, inputRow, field, value, "already_filled_since_batch_dispatch");
        continue;
      }

      if (dryRun) {
        applied.push({ id: result.id, barcode, field, value, source_host: result.source_host || hostOf(result.source_url) });
        perFieldFillCount[field]++;
        continue;
      }

      const info = updateStmts[field].run(value, barcode);
      if (info.changes === 0) {
        // Guard fired (race between our re-check and the UPDATE's own WHERE) - route to review.
        reject(result, inputRow, field, value, "update_guard_blocked_concurrent_write");
        continue;
      }

      const sourceHost = result.source_host || hostOf(result.source_url);
      provStmt.run({
        product_id: liveRow.canonical_product_uid,
        barcode,
        source_name: sourceHost,
        source_ref: result.source_url,
        batch_id: batchId,
        imported_at: now,
        evidence_level: EVIDENCE_LEVEL,
      });
      auditStmt.run({
        action: auditActionOverride || SOURCE_TAG,
        trust_color: "green",
        confidence_score: result.confidence === "high" ? 90 : result.confidence === "medium" ? 70 : 50,
        canonical_product_uid: liveRow.canonical_product_uid,
        barcode,
        previous_value: "",
        new_value: value,
        candidate_count: 1,
        candidate_values: JSON.stringify([value]),
        reason: `Trusted-host web enrichment (${sourceHost}) with exact-barcode-tied evidence: ${String(
          result.evidence_quote || ""
        ).slice(0, 200)}`,
      });

      applied.push({ id: result.id, barcode, field, value, source_host: sourceHost });
      perFieldFillCount[field]++;
      perFieldSourceCount[sourceHost] = (perFieldSourceCount[sourceHost] || 0) + 1;
    }
  });

  for (const result of results) {
    applyOne(result);
  }

  db.close();

  appendReviewRows(reviewRows, dryRun);

  const summary = {
    batchId,
    batchPath,
    inputPath,
    dryRun,
    resultsCount: results.length,
    appliedCount: applied.length,
    perFieldFillCount,
    perFieldSourceCount,
    reviewCount: reviewRows.length,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) {
    console.log(`\n[DRY RUN] Sample of would-apply fills (first 10):`);
    for (const a of applied.slice(0, 10)) {
      console.log(`  ${a.barcode} ${a.field}=${JSON.stringify(a.value)} (source: ${a.source_host})`);
    }
  }

  return summary;
}

main();
