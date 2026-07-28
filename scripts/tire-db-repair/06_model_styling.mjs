#!/usr/bin/env node
// Task C1 - Model display styling cleaner for the tire-DB repair/enrichment bakeoff.
//
// Adds a new blank-safe column `tires.model_display` holding a manufacturer-official display
// styling of the existing `tires.model` slug (e.g. "wildpeak_a_t3w" -> "Wildpeak A/T3W").
// `model_normalized` is NEVER touched - it stays the deterministic matching key. Styling only
// reformats an EXISTING value; it never invents information that is not already present in the
// slug (no guessed apostrophes, no guessed word splits beyond the slug's own underscores).
//
// Two-tier resolution, in priority order:
//   1. Curated rule lookup by (brand, model slug) from model_styling_rules.json - manufacturer-
//      official styling for the top ~100 models by row count plus the boss brands and majors
//      (Michelin, Goodyear, Bridgestone, Continental, Toyo, Falken, Nexen, Kumho, Hankook).
//      Every rule carries a rule_id + source. Audit rows for these fills get trust_color='green'.
//   2. Deterministic fallback for everything else: tokenize the slug on `_`, title-case each
//      token, but uppercase any token that looks like a short alphanumeric designation code
//      (2-4 letters optionally followed by digits, e.g. "gtx" -> "GTX", "su1" -> "SU1"). The
//      fallback never inserts a "/" between tokens (that reformatting only happens for
//      rule-listed, manufacturer-confirmed designations) and never invents letters the slug does
//      not contain. Fallback rows get trust_color='yellow' in the audit (lower certainty; not
///     confirmed against a manufacturer source).
//
// Audit: one remaining_blank_fill_audit row per (barcode) change, action='model_display_styling',
// recording the rule_id used (or 'fallback_tokenizer' when no curated rule matched).
//
// Concurrency safety: PRAGMA busy_timeout=30000 (other scripts may write to this DB tonight);
// the single UPDATE pass runs inside one short db.transaction batch, not one long-lived
// transaction for the whole script. No WAL is enabled.
//
// No git commands. No web calls. No live Turso write.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// ---- pure styling function (no DB / no I/O) --------------------------------------------------

// A token "looks like" a short designation code when it is 2-4 letters optionally followed by
// digits (e.g. "gtx", "su1", "fk510" is 2 letters + 3 digits = still matches the letter-prefix
// rule since the regex only constrains the leading letter run to 2-4 chars, digits are unbounded).
const SHORT_CODE_RE = /^[a-z]{2,4}[0-9]*$/;

function titleCaseWord(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function styleToken(token) {
  if (!token) return token;
  if (/^[0-9]+$/.test(token)) return token; // pure number: leave as-is
  if (SHORT_CODE_RE.test(token)) return token.toUpperCase();
  return titleCaseWord(token);
}

// Deterministic fallback: tokenize on "_", style each token, join with a single space. Never
// inserts "/" - that reformatting is reserved for curated, manufacturer-confirmed rules only.
function fallbackStyle(slug) {
  const tokens = slug.split("_").filter((t) => t.length > 0);
  return tokens.map(styleToken).join(" ");
}

// Build a lookup index from the rules array: key = "<brand lowercase>::<slug lowercase>".
function buildRuleIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    const key = `${rule.brand.toLowerCase()}::${rule.slug.toLowerCase()}`;
    index.set(key, rule);
  }
  return index;
}

// styleModel(brand, slug, ruleIndex) -> { display, ruleId, trustColor, source }
//   - blank slug (null/empty/whitespace-only) -> display: null, ruleId: null, trustColor: null
//     (nothing to style; caller must not write a row for this).
//   - curated rule match (case-insensitive brand + exact-case-insensitive slug) -> green.
//   - otherwise -> deterministic fallback -> yellow.
function styleModel(brand, slug, ruleIndex) {
  if (slug === null || slug === undefined || String(slug).trim() === "") {
    return { display: null, ruleId: null, trustColor: null, source: null };
  }
  const trimmedSlug = String(slug).trim();
  const brandKey = brand === null || brand === undefined ? "" : String(brand).trim().toLowerCase();
  const key = `${brandKey}::${trimmedSlug.toLowerCase()}`;
  const rule = ruleIndex.get(key);
  if (rule) {
    return { display: rule.display, ruleId: rule.rule_id, trustColor: "green", source: rule.source };
  }
  return {
    display: fallbackStyle(trimmedSlug),
    ruleId: null,
    trustColor: "yellow",
    source: "deterministic fallback tokenizer (no curated rule)",
  };
}

export { styleModel, buildRuleIndex, fallbackStyle, styleToken };

// ---- DB-writing script (only runs when invoked directly, not on import for tests) -------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}

async function main() {
  const { default: Database } = await import("better-sqlite3");

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(__dirname, "..", "..");

  // Optional DB path override (e.g. a working copy driven by pipeline_driver.mjs). Defaults to
  // the packaged repair working copy exactly as before when no argument is given.
  const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const DB_PATH = dbPathArg
    ? path.resolve(dbPathArg)
    : path.join(
        REPO_ROOT,
        "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
      );
  const RULES_PATH = path.join(REPO_ROOT, "scripts/tire-db-repair/model_styling_rules.json");
  const REPORT_DIR = dbPathArg ? path.dirname(DB_PATH) : path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28");
  const REPORT_PATH = path.join(REPORT_DIR, "C1_MODEL_STYLING_REPORT.md");

  const rulesData = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  const ruleIndex = buildRuleIndex(rulesData.rules);

  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 30000");

  // Ensure the column exists (blank-safe ALTER TABLE ADD COLUMN; no-op if already present from a
  // prior run - re-running this script must be idempotent).
  const columns = db.prepare("PRAGMA table_info(tires)").all();
  const hasColumn = columns.some((c) => c.name === "model_display");
  if (!hasColumn) {
    db.exec("ALTER TABLE tires ADD COLUMN model_display TEXT");
    console.log("Added column tires.model_display");
  } else {
    console.log("Column tires.model_display already exists; continuing (idempotent re-run).");
  }

  const modelNormalizedBefore = db
    .prepare(
      `SELECT COUNT(*) c FROM (SELECT barcode, model_normalized FROM tires)`
    )
    .get().c;

  // Snapshot model_normalized values before the run so we can gate on "zero rows changed" after.
  const beforeSnapshot = new Map(
    db.prepare(`SELECT barcode, model_normalized FROM tires`).all().map((r) => [r.barcode, r.model_normalized])
  );

  const candidates = db
    .prepare(
      `SELECT barcode, canonical_product_uid, brand, model
       FROM tires
       WHERE model IS NOT NULL AND TRIM(model) != ''
         AND (model_display IS NULL OR TRIM(model_display) = '')`
    )
    .all();

  const updateStmt = db.prepare(
    `UPDATE tires SET model_display = ? WHERE barcode = ? AND (model_display IS NULL OR TRIM(model_display) = '')`
  );
  const auditStmt = db.prepare(`
    INSERT INTO remaining_blank_fill_audit
      (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value, new_value, candidate_count, candidate_values, reason)
    VALUES
      (@action, @trust_color, @confidence_score, @canonical_product_uid, @barcode, @previous_value, @new_value, @candidate_count, @candidate_values, @reason)
  `);

  let curatedFilled = 0;
  let fallbackFilled = 0;

  const run = db.transaction((rows) => {
    for (const row of rows) {
      const result = styleModel(row.brand, row.model, ruleIndex);
      if (result.display === null) continue;
      const info = updateStmt.run(result.display, row.barcode);
      if (info.changes === 0) continue;
      if (result.trustColor === "green") curatedFilled++;
      else fallbackFilled++;
      auditStmt.run({
        action: "model_display_styling",
        trust_color: result.trustColor,
        confidence_score: result.trustColor === "green" ? 100 : 60,
        canonical_product_uid: row.canonical_product_uid,
        barcode: row.barcode,
        previous_value: "",
        new_value: result.display,
        candidate_count: 1,
        candidate_values: JSON.stringify([result.display]),
        reason:
          result.ruleId !== null
            ? `Curated rule ${result.ruleId}: ${result.source}`
            : `Deterministic fallback tokenizer (no curated rule for brand="${row.brand}", slug="${row.model}"): ${result.source}`,
      });
    }
  });

  run(candidates);

  // Gate: model_normalized must be byte-identical to its pre-run snapshot for every row.
  const afterRows = db.prepare(`SELECT barcode, model_normalized FROM tires`).all();
  let changedModelNormalized = 0;
  for (const row of afterRows) {
    const before = beforeSnapshot.get(row.barcode);
    if (before !== row.model_normalized) changedModelNormalized++;
  }

  db.close();

  console.log(`Candidates considered: ${candidates.length}`);
  console.log(`Curated (green) fills: ${curatedFilled}`);
  console.log(`Fallback (yellow) fills: ${fallbackFilled}`);
  console.log(`model_normalized rows changed (must be 0): ${changedModelNormalized}`);

  if (changedModelNormalized !== 0) {
    throw new Error(
      `Gate failure: ${changedModelNormalized} tires.model_normalized rows changed. model_normalized must never change.`
    );
  }

  const report = [
    "# Task C1 model styling run report",
    "",
    `Candidates considered (non-blank model, blank model_display): ${candidates.length}`,
    `Curated rule fills (trust_color=green): ${curatedFilled}`,
    `Deterministic fallback fills (trust_color=yellow): ${fallbackFilled}`,
    `model_normalized rows changed: ${changedModelNormalized} (gate: must be 0)`,
    "",
    `Rules file: scripts/tire-db-repair/model_styling_rules.json (${rulesData.rules.length} curated entries)`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, "utf8");
  console.log(`Report written to ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}
