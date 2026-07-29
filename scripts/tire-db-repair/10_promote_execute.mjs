#!/usr/bin/env node
// Task PROMOTE-BUILD: executable Turso promotion tooling for the repaired tire DB.
//
// Subcommands: backup | stage | verify | promote | rollback
// Every subcommand supports --dry-run (prints exact statements, executes nothing).
// Every LIVE (non-dry-run) subcommand refuses to run unless env PROMOTE_CONFIRM=YES is set,
// exiting with code 3 and a clear message otherwise. This script never runs anything against
// live Turso on its own initiative - it is fired by the orchestrator only after the council
// verdict, and only with PROMOTE_CONFIRM=YES explicitly set by that orchestrator.
//
// No git commands. This file only talks to: (a) a libsql/Turso-compatible client (live or a
// local file: URL for the proof harness), and (b) the local filesystem under
// backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/.
//
// FK-rename safety (Antigravity panel Critical #1, verified empirically against a local libsql DB,
// not assumed): ALTER TABLE ... RENAME TO in SQLite/libsql DOES rewrite the REFERENCES clause of
// any OTHER table that declares a FOREIGN KEY pointing at the renamed table (confirmed locally;
// neither PRAGMA foreign_keys=OFF nor PRAGMA legacy_alter_table=ON prevents it). This repo's entire
// schema-creation code was grepped exhaustively (scripts/build-knowledge-db.mjs,
// src/server/decodeCacheStore.ts, src/server/upc/storage.ts, src/server/learnedProducts.ts, every
// turso-staging/*.sql file) and declares ZERO foreign keys anywhere, so this promotion's
// tires/tire_part_numbers renames have nothing to hijack. See 09_rollback.sql for the full note;
// re-verify before ever adding a table with an FK referencing tires or tire_part_numbers.
//
// Usage:
//   node scripts/tire-db-repair/10_promote_execute.mjs backup  [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs stage   [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs verify  [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs promote [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs rollback [--dry-run]
//
// Env overrides (used by the proof harness to point at a local fake-live DB instead of real
// Turso; production run uses the real TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env.local):
//   PROMOTE_TURSO_URL, PROMOTE_TURSO_AUTH_TOKEN   override TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
//   PROMOTE_STAGING_DIR                            override the turso-staging/ SQL source dir
//   PROMOTE_BACKUP_DIR                             override the turso-backup/ output dir
//   PROMOTE_TS                                     override the timestamp used for _old_<ts> /
//                                                   backup dir naming (tests only; else Date.now())

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");
const DEFAULT_STAGING_DIR = join(OUTPUT_DIR, "turso-staging");
const DEFAULT_BACKUP_ROOT = join(OUTPUT_DIR, "turso-backup");

const STAGING_DIR = process.env.PROMOTE_STAGING_DIR || DEFAULT_STAGING_DIR;
const BACKUP_ROOT = process.env.PROMOTE_BACKUP_DIR || DEFAULT_BACKUP_ROOT;

// Tables in scope for this promotion. Operational tables are NEVER referenced by any statement
// this script builds - this list exists only for documentation/report purposes.
const LIVE_TABLES = ["tires", "tire_part_numbers"];
const NEW_TABLES = [
  { staging: "staging_tire_product_part_number_aliases", live: "tire_product_part_number_aliases" },
  { staging: "staging_canonical_tire_products", live: "canonical_tire_products" },
  { staging: "staging_provenance", live: "provenance" },
];
const OPERATIONAL_TABLES = [
  "decode_cache", "decode_archive", "decode_outcomes", "goupc_miss_cache", "goupc_usage",
  "ladder_kv", "learned_products", "retail", "sqlite_sequence",
];

// -------------------------------------------------------------------------------------------
// Re-review OPEN-1 / Codex C1's "zero-unapproved-missing live-part-number diff" hard gate:
// APPROVED_PN_KEY_DROPS.csv is the ONLY authority for which live tire_part_numbers keys are
// allowed to go missing across the promotion (today: exactly the 17 owner-ordered conflict-key
// drops). Any other missing live key is an UNAPPROVED drop and fails verify (and the post-promote
// smoke check). PROMOTE_APPROVED_DROPS overrides the path for the proof harness only.
// -------------------------------------------------------------------------------------------
const DEFAULT_APPROVED_DROPS_PATH = join(OUTPUT_DIR, "APPROVED_PN_KEY_DROPS.csv");
const APPROVED_DROPS_PATH = process.env.PROMOTE_APPROVED_DROPS || DEFAULT_APPROVED_DROPS_PATH;

/** Load the approved-drops CSV. Returns { exists, keys:Set<string> }. Lines starting with `#` are
 *  comments; the first non-comment line is the header; the first CSV field of each subsequent line
 *  is the normalized part-number key. Fail-safe on parse weirdness: an unreadable file is treated
 *  as NOT existing (fail closed - a missing/broken approvals file means no drop is approved). */
function loadApprovedDrops() {
  if (!existsSync(APPROVED_DROPS_PATH)) return { exists: false, keys: new Set() };
  try {
    const lines = readFileSync(APPROVED_DROPS_PATH, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    const keys = new Set();
    for (const line of lines.slice(1)) { // slice(1): skip the header row
      const key = line.split(",")[0].trim();
      if (key) keys.add(key);
    }
    return { exists: true, keys };
  } catch {
    return { exists: false, keys: new Set() };
  }
}

/** Pure comparison core of the OPEN-1 gate, shared by verify and the post-promote smoke check.
 *  Given the set of live (pre-swap) part-number keys and the set of keys in the replacement table
 *  (staging before promote, the new live table after promote), classifies every missing live key
 *  as approved (listed in APPROVED_PN_KEY_DROPS.csv) or unapproved.
 *  PASS iff unapproved === 0 AND (missing === 0 OR the approvals file exists) - i.e. if ANY key is
 *  missing while the approvals file is absent/unreadable, the gate fails closed. */
function computePnKeyPreservation(liveKeys, replacementKeys, approvedDrops) {
  const missing = [...liveKeys].filter((k) => !replacementKeys.has(k));
  const approved = missing.filter((k) => approvedDrops.keys.has(k));
  const unapproved = missing.filter((k) => !approvedDrops.keys.has(k));
  const pass = unapproved.length === 0 && (missing.length === 0 || approvedDrops.exists);
  const detail =
    `missing=${missing.length}, approved=${approved.length}, unapproved=${unapproved.length}` +
    (missing.length > 0 && !approvedDrops.exists
      ? ` -- FAIL: keys are missing but the approved-drops file (${rel(APPROVED_DROPS_PATH)}) is absent/unreadable; no drop is approved without it`
      : "") +
    (unapproved.length > 0
      ? ` -- UNAPPROVED: ${unapproved.slice(0, 20).join(", ")}${unapproved.length > 20 ? ", ..." : ""}`
      : "");
  return { missing, approved, unapproved, pass, detail };
}

// -------------------------------------------------------------------------------------------
// Codex panel finding I3: operational-table isolation was previously true only of TODAY'S SQL
// TEXT, never enforced by the executable. PROMOTE_STAGING_DIR can be pointed at ANY directory
// (used deliberately by the test harness, but nothing stops a stale/tampered/wrong directory in a
// real run), and stage() executes every statement `splitSqlStatements` finds in the five expected
// filenames with NO table allowlist. This hard allowlist makes operational-table isolation an
// INVARIANT of the executable itself, not a property of the currently-reviewed SQL files: every
// statement about to be executed against the live/staging database is scanned for table names it
// references, and execution refuses if any name falls outside the explicit allowlist below.
// -------------------------------------------------------------------------------------------

const BASE_TABLE_NAMES = [
  "tires", "tire_part_numbers",
  "tire_product_part_number_aliases", "canonical_tire_products", "provenance",
];

/** Every table name any statement executed by this script may legally reference: the tire-scope
 *  base tables, their `staging_` prefix, and any `_old_<ts>` / `_failed_promotion_<ts>` suffixed
 *  variant (ts can be anything - matched structurally, not against a specific value, since ts is
 *  chosen at runtime). sqlite_master itself is allowed for READ (schema introspection / rename
 *  detection); it is never a target of INSERT/UPDATE/DELETE/DROP in any statement this script builds. */
function isAllowedTableName(name) {
  if (name === "sqlite_master") return true;
  if (BASE_TABLE_NAMES.includes(name)) return true;
  if (BASE_TABLE_NAMES.some((t) => name === `staging_${t}`)) return true;
  for (const t of BASE_TABLE_NAMES) {
    if (name.startsWith(`${t}_old_`) || name.startsWith(`${t}_failed_promotion_`)) return true;
  }
  return false;
}

/** Extract every table name a single SQL statement references, covering the statement shapes this
 *  script's own code and the staging SQL files actually use: CREATE TABLE [IF NOT EXISTS] <name>,
 *  DROP TABLE [IF EXISTS] <name>, INSERT [OR REPLACE] INTO <name>, REPLACE INTO <name>,
 *  ALTER TABLE <name> ..., SELECT ... FROM <name>, DELETE FROM <name>, UPDATE <name>, a JOIN <name>
 *  clause, DROP/CREATE INDEX ... ON <name>. This is deliberately conservative (a regex scan, not a
 *  full SQL parser) but is applied as a POSITIVE allowlist gate - any statement referencing a name
 *  this scan does not recognize as safe is rejected, so an unrecognized-but-dangerous construct
 *  fails closed rather than sneaking through. */
function extractTableNames(statement) {
  const names = new Set();
  const patterns = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+["'`]?(\w+)["'`]?/gi,
    /(?:^|\s)REPLACE\s+INTO\s+["'`]?(\w+)["'`]?/gi,
    /ALTER\s+TABLE\s+["'`]?(\w+)["'`]?/gi,
    /(?:^|\s)RENAME\s+TO\s+["'`]?(\w+)["'`]?/gi,
    /FROM\s+["'`]?(\w+)["'`]?/gi,
    /UPDATE\s+["'`]?(\w+)["'`]?\s+SET/gi,
    /(?:INNER\s+|LEFT\s+|RIGHT\s+|OUTER\s+)?JOIN\s+["'`]?(\w+)["'`]?/gi,
    /DELETE\s+FROM\s+["'`]?(\w+)["'`]?/gi,
    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] <index_name> ON <table_name> ...
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?\w+["'`]?\s+ON\s+["'`]?(\w+)["'`]?/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(statement)) !== null) {
      names.add(m[1]);
    }
  }
  return names;
}

// DROP INDEX [IF EXISTS] <index_name> does not itself name a table (SQLite resolves the index's
// owning table internally), so it cannot produce a table name via extractTableNames. It is
// deliberately treated as a "no-table" statement shape and allowlisted by name below, rather than
// rejected as fail-closed noise - this script's own postSwapIndexStatements()/rollback index
// recreation legitimately emit DROP INDEX IF EXISTS <name>; statements with no ON <table> clause.
const NO_TABLE_STATEMENT_PATTERNS = [
  /^PRAGMA\s+\w+/i,
  /^BEGIN\b/i,
  /^COMMIT\b/i,
  /^ROLLBACK\b/i,
  /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["'`]?\w+["'`]?\s*;?\s*$/i,
];

/** True iff `statement` (after trimming whitespace) is empty or pure comment - never a real
 *  operation, so it is always safe regardless of table content. */
function isBlankOrCommentOnly(statement) {
  const stripped = statement
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, "")) // conservative: strips from the first `--` on each line;
    // acceptable here because this is only used to decide "is there ANY real SQL left", and a
    // string literal containing `--` still leaves other non-comment characters on real statements.
    .join("\n")
    .trim();
  return stripped.length === 0;
}

/** True iff `statement` is one of the small set of statement shapes that legitimately reference NO
 *  table at all (schema-introspection-free control statements). This is an explicit, enumerated
 *  allowlist - NOT a catch-all - so a statement outside both this list and extractTableNames' output
 *  is rejected rather than silently passed (panel finding I3: fail CLOSED, not fail OPEN). */
function isAllowedNoTableStatement(statement) {
  const trimmed = statement.trim();
  if (isBlankOrCommentOnly(trimmed)) return true;
  return NO_TABLE_STATEMENT_PATTERNS.some((re) => re.test(trimmed));
}

/** Scan a batch of statements and throw a clear, actionable error the FIRST time any statement
 *  references a table name outside the allowlist, naming the offending table and statement. Called
 *  before any batch is executed (stage, promote, rollback) so a sabotaged/stale/wrong staging
 *  directory cannot silently touch an operational table.
 *
 *  FAIL-CLOSED (panel finding I3 fix): a statement that extractTableNames finds NO table name for is
 *  no longer silently accepted. It is allowed ONLY if isAllowedNoTableStatement recognizes it as one
 *  of the enumerated genuinely-table-free shapes (PRAGMA/BEGIN/COMMIT/ROLLBACK/DROP INDEX/blank or
 *  comment-only). Any other unrecognized statement (e.g. a REPLACE INTO/DROP INDEX/ALTER TABLE shape
 *  this scan's regexes fail to parse for some reason, or any future statement type) is REJECTED, not
 *  passed through - closing the fail-open gap where "no names extracted" previously meant "allowed". */
function assertAllowedTables(statements, label) {
  for (const stmt of statements) {
    const names = extractTableNames(stmt);
    if (names.size === 0) {
      if (isAllowedNoTableStatement(stmt)) continue;
      throw new Error(
        `${label}: REFUSING to execute - statement did not match any recognized table-bearing SQL shape ` +
          `AND is not one of the explicitly allowed no-table statements (PRAGMA, BEGIN/COMMIT/ROLLBACK, ` +
          `DROP INDEX, or blank/comment-only). This is a fail-CLOSED safety gate: an unrecognized statement ` +
          `shape is refused rather than silently permitted, so a construct this scanner does not understand ` +
          `can never bypass operational-table isolation. ` +
          `Offending statement: ${stmt.length > 300 ? stmt.slice(0, 300) + " ... [truncated]" : stmt}`
      );
    }
    for (const name of names) {
      if (!isAllowedTableName(name)) {
        throw new Error(
          `${label}: REFUSING to execute - statement references table "${name}", which is NOT in the ` +
            `operational-isolation allowlist (tire-scope tables + their staging_/_old_/_failed_promotion_ ` +
            `variants, plus sqlite_master for reads). This is a hard safety gate: it fires on ANY statement ` +
            `naming an out-of-scope table (e.g. retail, decode_cache, or any other operational table), ` +
            `whether from a tampered staging file, a wrong PROMOTE_STAGING_DIR, or a bug in this script. ` +
            `Offending statement: ${stmt.length > 300 ? stmt.slice(0, 300) + " ... [truncated]" : stmt}`
        );
      }
    }
  }
}

const STAGING_FILES_ORDER = [
  "01_staging_tires.sql",
  "02_staging_tire_part_numbers.sql",
  "03_staging_tire_product_part_number_aliases.sql",
  "04_staging_canonical_tire_products.sql",
  "05_staging_provenance.sql",
];

// Maps each staging file to the staging table it loads, so stage() can compute an EXACT expected
// row count (by counting INSERT value-tuples in the source file) and verify() can assert the live
// staged count matches EXACTLY - not merely count > 0 (panel finding I1). This catches a crash
// mid-stage (CHUNK-batched load, `:` see cmdStage) that leaves a staging table partially loaded:
// a truncated load still has count > 0 but will not match the file's own tuple count.
const STAGING_FILE_TO_TABLE = {
  "01_staging_tires.sql": "staging_tires",
  "02_staging_tire_part_numbers.sql": "staging_tire_part_numbers",
  "03_staging_tire_product_part_number_aliases.sql": "staging_tire_product_part_number_aliases",
  "04_staging_canonical_tire_products.sql": "staging_canonical_tire_products",
  "05_staging_provenance.sql": "staging_provenance",
};

const MANIFEST_FILE_NAME = "stage_expected_counts.json";

/** Count INSERT VALUES tuples in a staging SQL file. The generator (see turso-staging/*.sql
 *  headers) always emits one tuple per line, indented exactly two spaces, starting with `(` right
 *  after the indent (e.g. `  ('848983006257', ...),`). This mirrors splitSqlStatements' string-aware
 *  approach only to the extent needed: since tuples never span multiple lines in these generated
 *  files, a per-line prefix check is sufficient and avoids re-parsing full statements twice. */
function countValueTuples(sqlText) {
  let count = 0;
  for (const line of sqlText.split(/\r?\n/)) {
    if (/^\s{2}\(/.test(line)) count++;
  }
  return count;
}

function timestamp() {
  if (process.env.PROMOTE_TS) return process.env.PROMOTE_TS;
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

function rel(p) {
  return p.replace(REPO_ROOT + "\\", "").replace(REPO_ROOT + "/", "").replace(/\\/g, "/");
}

function loadEnvLocal() {
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/** Resolve the target client connection info. PROMOTE_TURSO_URL/PROMOTE_TURSO_AUTH_TOKEN (used by
 *  the proof harness to point at a local file: DB) take priority over the real
 *  TURSO_DATABASE_URL/TURSO_AUTH_TOKEN so tests never touch production credentials by accident. */
function resolveConnection() {
  loadEnvLocal();
  const url = process.env.PROMOTE_TURSO_URL || process.env.TURSO_DATABASE_URL;
  const authToken = process.env.PROMOTE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined;
  return { url, authToken };
}

async function makeClient() {
  const { url, authToken } = resolveConnection();
  if (!url) {
    throw new Error("No Turso/libsql URL available (TURSO_DATABASE_URL / PROMOTE_TURSO_URL not set).");
  }
  const { createClient } = await import("@libsql/client");
  return createClient(authToken ? { url, authToken } : { url });
}

/** The hard refusal gate. Every subcommand that would WRITE against the live database (all
 *  except backup's SELECTs are read-only too, but we gate uniformly across all live execution
 *  paths per the brief) must call this before issuing any statement, unless --dry-run. */
function requireConfirmOrExit(dryRun) {
  if (dryRun) return;
  if (process.env.PROMOTE_CONFIRM !== "YES") {
    console.error(
      "REFUSED: this is a LIVE run against the configured database, but env PROMOTE_CONFIRM=YES " +
        "is not set. Set PROMOTE_CONFIRM=YES (the orchestrator sets this at execution time, after " +
        "the council verdict) or pass --dry-run to preview without executing."
    );
    process.exit(3);
  }
}

function parseArgs(argv) {
  const subcommand = argv[2];
  const dryRun = argv.includes("--dry-run");
  return { subcommand, dryRun };
}

// -------------------------------------------------------------------------------------------
// Shared: batch executor. In dry-run mode, prints statements only. Live mode executes them via
// the libsql client, batching in a single transaction per file (or a single call to
// client.batch() for a group of statements) so partial application is never observed.
// -------------------------------------------------------------------------------------------

function splitSqlStatements(sqlText) {
  // Single quote-aware pass that strips `--` line-comments AND splits on statement-terminating
  // `;`, all in one scan, tracking single-quoted-string state throughout. This replaced an earlier
  // two-pass version that stripped `--` comments line-by-line BEFORE the quote-aware scanner ran
  // (checking only `line.trim().startsWith("--")`), which was safe for every line in today's actual
  // generated datasets (a provenance URL column contains `--` mid-string, e.g. '...11.00--r20...',
  // but never at the START of a line) but would have silently corrupted a future/hypothetical row
  // whose quoted text legitimately began a line with `--` inside a value that spans multiple lines
  // (external review finding, Antigravity panel Important #4). Doing comment-stripping and
  // statement-splitting in the SAME string-aware scan removes that class of bug entirely: `--`
  // is only ever treated as a comment marker when encountered OUTSIDE a single-quoted string.
  const statements = [];
  let current = "";
  let inString = false;
  let i = 0;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (!inString && ch === "-" && sqlText[i + 1] === "-") {
      // Line comment starting outside a string: skip to (but not past) the next newline.
      const nl = sqlText.indexOf("\n", i);
      i = nl === -1 ? sqlText.length : nl; // leave the newline itself to be appended normally
      continue;
    }
    current += ch;
    if (ch === "'") {
      if (inString && sqlText[i + 1] === "'") {
        // Escaped quote ('') - consume both characters as part of the string, stay inString.
        current += sqlText[i + 1];
        i += 2;
        continue;
      }
      inString = !inString;
    } else if (ch === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    }
    i++;
  }
  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing + ";");
  return statements;
}

async function execBatch(client, statements, { dryRun, label }) {
  if (dryRun) {
    console.log(`[dry-run] ${label}: would execute ${statements.length} statement(s):`);
    for (const s of statements) {
      console.log(`  ${s.length > 200 ? s.slice(0, 200) + " ... [truncated]" : s}`);
    }
    return;
  }
  console.log(`${label}: executing ${statements.length} statement(s) in one batch...`);
  await client.batch(statements, "write");
  console.log(`${label}: done.`);
}

// =============================================================================================
// backup: dump live tires + tire_part_numbers (full rows, batched SELECTs) to timestamped local
// files + a row-count manifest. READ-ONLY.
// =============================================================================================
/** Codex panel finding C3: no state previously bound backup -> stage -> verify -> promote across
 *  separate command invocations, so a live write landing between steps could be silently lost (a
 *  live INSERT after backup's count snapshot is invisible to every later gate, and is overwritten
 *  by the promote swap). This hashes the exact staging SQL file CONTENTS (not just their names) so
 *  the run-manifest also binds "which staging dataset" was verified, not only "what live looked
 *  like". A cheap, dependency-free FNV-1a-style hash is sufficient here: this is a tamper/drift
 *  DETECTOR for an operator-controlled multi-step CLI workflow, not a cryptographic integrity
 *  boundary against an adversarial actor with write access to the staging directory. */
function hashStagingContent() {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (const fname of STAGING_FILES_ORDER) {
    const fpath = join(STAGING_DIR, fname);
    const text = existsSync(fpath) ? readFileSync(fpath, "utf8") : `<<MISSING:${fname}>>`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Read live COUNT(*) for every LIVE_TABLES member. Used both to write the run-manifest (backup)
 *  and to re-check live state against it (stage/verify/promote), so the same shape is reused. */
async function readLiveCounts(client) {
  const counts = {};
  for (const table of LIVE_TABLES) {
    const res = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
    counts[table] = Number(res.rows[0].c);
  }
  return counts;
}

// -------------------------------------------------------------------------------------------
// Panel finding (Important #2): the drift gate above (readLiveCounts/assertLiveUnchangedSinceManifest)
// compares ONLY COUNT(*). An UPDATE to an existing row, or a DELETE+INSERT that nets to the same row
// count, is completely invisible to that check and would be silently overwritten by the promote
// swap. This content fingerprint closes that gap: for each LIVE_TABLES member it computes a single
// aggregate hash (a SQLite-side SUM of a per-row hash expression - an aggregate query, never a
// row-by-row loop in JS) over the primary key AND the mutable columns that matter to correctness,
// so an update to an existing row's data changes the fingerprint even though COUNT(*) does not move.
// -------------------------------------------------------------------------------------------
const FINGERPRINT_COLUMNS = {
  // Primary key first (barcode/normalized_part_number), then the columns whose mutation would
  // otherwise be invisible to promote: identity linkage (canonical_product_uid) and the
  // human-visible tire attributes a repair/enrichment pass could legitimately change in place.
  tires: [
    "barcode", "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized",
    "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season",
    "manufacturer_part_number", "confidence", "current_status",
  ],
  tire_part_numbers: ["normalized_part_number", "canonical_product_uid"],
};

/** Build the SQL fragment used by readLiveContentFingerprint to fingerprint one table's rows in a
 *  single aggregate query (no row-by-row JS work, no SQLite hash builtin required). Each row's
 *  fingerprinted columns are concatenated (NULL coalesced to a sentinel so NULL vs '' stays
 *  distinguishable) into one delimited text value, then two independent aggregates are computed over
 *  it: SUM(length(...)) and SUM(unicode(...) * (length(...)+1)). Combining both aggregates makes an
 *  in-place content mutation (an UPDATE, or a DELETE+INSERT that preserves row count) overwhelmingly
 *  likely to change at least one of them, even in the unlikely case a pure length-only sum happened
 *  to cancel out across rows. This is a drift DETECTOR for an operator-controlled CLI workflow
 *  (matching the non-cryptographic scope already stated for hashStagingContent()), not a
 *  cryptographic integrity boundary. */
function buildRowHashExpr(columns) {
  const concatExpr = columns
    .map((c) => `COALESCE(${c}, '__NULL__')`)
    .join(` || '|' || `);
  return (
    `SUM(length(${concatExpr})) || ':' || ` +
    `SUM(unicode(${concatExpr}) * (length(${concatExpr}) + 1))`
  );
}

/** Compute a content fingerprint for every LIVE_TABLES member: a single aggregate query per table
 *  (never row-by-row in JS) combining SUM(length(...)) and SUM(unicode(...) * (length+1)) over every
 *  fingerprinted column concatenated per row. Two aggregates are combined (not just one SUM) so that
 *  a row-content swap between two rows of equal total length is still very likely to change at least
 *  one of the two sums (the unicode()-weighted sum is sensitive to leading-character changes that a
 *  pure length sum would miss). Returns { table: "sumLen:sumUnicode" } strings, directly comparable. */
async function readLiveContentFingerprint(client) {
  const fingerprint = {};
  for (const table of LIVE_TABLES) {
    const columns = FINGERPRINT_COLUMNS[table];
    const hashExpr = buildRowHashExpr(columns);
    const res = await client.execute(`SELECT ${hashExpr} AS fp FROM ${table}`);
    const value = res.rows[0]?.fp;
    // An empty table's SUM() returns NULL in SQLite; normalize to an explicit sentinel so "empty"
    // has a stable, comparable fingerprint value rather than the string "null" leaking through.
    fingerprint[table] = value === null || value === undefined ? "EMPTY:0" : String(value);
  }
  return fingerprint;
}

/** Find the most recently created backup manifest.json under BACKUP_ROOT (by directory name sort,
 *  which is safe because timestamp() produces sortable YYYYMMDD_HHMMSS-shaped or test-supplied
 *  monotonic strings). Returns null if no backup has ever been run. */
function findLatestManifestPath() {
  if (!existsSync(BACKUP_ROOT)) return null;
  const dirs = readdirSync(BACKUP_ROOT).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const candidate = join(BACKUP_ROOT, dirs[i], "manifest.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve the manifest path a subcommand should bind to: explicit --manifest wins, else the
 *  latest backup's manifest.json, else null (caller decides whether that is fatal). */
function resolveManifestPath(manifestArg) {
  if (manifestArg) return isAbsolute(manifestArg) ? manifestArg : join(REPO_ROOT, manifestArg);
  return findLatestManifestPath();
}

/** Load and validate a run-manifest, throwing a clear error if the path is missing or unreadable.
 *  Used by stage/verify/promote to bind to the backup that must precede them. */
function loadRunManifest(manifestPath, subcommandLabel) {
  if (!manifestPath || !existsSync(manifestPath)) {
    throw new Error(
      `${subcommandLabel}: REFUSING to run - no run-manifest found (looked for ${manifestPath ? rel(manifestPath) : "any backup under " + rel(BACKUP_ROOT)}). ` +
        `Run "node scripts/tire-db-repair/10_promote_execute.mjs backup" first (it writes manifest.json), ` +
        `or pass --manifest <path> to bind explicitly to a specific backup. This binding exists so a live ` +
        `write that lands between backup and ${subcommandLabel} is caught, not silently lost (panel finding C3).`
    );
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`${subcommandLabel}: REFUSING to run - could not parse manifest at ${rel(manifestPath)}: ${e.message}`);
  }
}

/** Re-check current live counts (and, when present, the content fingerprint) against the
 *  manifest's snapshot; throws with a clear, actionable message (never silently proceeds) if live
 *  has moved since backup. This is the deterministic substitute for an owner-approved write freeze
 *  or quiescent window (panel finding C3/Antigravity #6): rather than trusting that no one wrote to
 *  live between steps, this PROVES it by comparing counts and aborting on any drift, telling the
 *  operator to re-run backup.
 *
 *  Panel finding (Important #2): COUNT(*) alone is blind to an UPDATE, or a DELETE+INSERT that nets
 *  to the same row count. When the manifest carries a `liveContentFingerprint` (written by every
 *  current backup), it is re-checked here too, so an in-place data mutation between backup and this
 *  subcommand is caught even though the row counts still match. An older/manual manifest without
 *  this field is not hard-failed for its absence (mirrors assertStagingContentUnchangedSinceManifest's
 *  own backward-compatible skip), but every manifest written by cmdBackup from this point forward
 *  always includes it, so in practice this check is always live for this repo's own workflow. */
async function assertLiveUnchangedSinceManifest(client, manifest, subcommandLabel) {
  if (!manifest.liveCounts) {
    throw new Error(`${subcommandLabel}: REFUSING to run - manifest at hand has no liveCounts snapshot (stale/incompatible manifest format).`);
  }
  const currentCounts = await readLiveCounts(client);
  const drifted = [];
  for (const table of LIVE_TABLES) {
    if (currentCounts[table] !== manifest.liveCounts[table]) {
      drifted.push(`${table}: backup saw ${manifest.liveCounts[table]}, now ${currentCounts[table]}`);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `${subcommandLabel}: REFUSING to run - live has changed since the bound backup (${drifted.join("; ")}). ` +
        `A write landed between backup and ${subcommandLabel}; proceeding could silently lose it. ` +
        `Re-run "node scripts/tire-db-repair/10_promote_execute.mjs backup" to take a fresh, current snapshot, ` +
        `then re-run stage/verify/promote against the new manifest.`
    );
  }

  if (manifest.liveContentFingerprint) {
    const currentFingerprint = await readLiveContentFingerprint(client);
    const contentDrifted = [];
    for (const table of LIVE_TABLES) {
      if (currentFingerprint[table] !== manifest.liveContentFingerprint[table]) {
        contentDrifted.push(table);
      }
    }
    if (contentDrifted.length > 0) {
      throw new Error(
        `${subcommandLabel}: REFUSING to run - live data CHANGED since the bound backup even though row counts ` +
          `match (content fingerprint mismatch on: ${contentDrifted.join(", ")}). This means an UPDATE, or a ` +
          `DELETE+INSERT that preserved the row count, landed between backup and ${subcommandLabel} - row-count ` +
          `comparison alone cannot see this. Re-run "node scripts/tire-db-repair/10_promote_execute.mjs backup" ` +
          `to take a fresh, current snapshot, then re-run stage/verify/promote against the new manifest.`
      );
    }
  }
}

/** Re-check the staging directory's CONTENT hash against the manifest's snapshot. Catches the case
 *  where stage/verify/promote runs against a DIFFERENT staging dataset than the one backup/earlier
 *  steps were bound to (files edited, regenerated, or a different PROMOTE_STAGING_DIR pointed at
 *  after backup ran). */
function assertStagingContentUnchangedSinceManifest(manifest, subcommandLabel) {
  if (!manifest.stagingContentHash) return; // older/manual manifest without this field: skip, don't hard-fail
  const currentHash = hashStagingContent();
  if (currentHash !== manifest.stagingContentHash) {
    throw new Error(
      `${subcommandLabel}: REFUSING to run - the staging SQL files' content hash (${currentHash}) does not match ` +
        `the hash bound at backup time (${manifest.stagingContentHash}). The staging dataset changed since backup ` +
        `ran. Re-run backup against the CURRENT intended staging dataset before continuing.`
    );
  }
}

async function cmdBackup({ dryRun }) {
  const ts = timestamp();
  const outDir = join(BACKUP_ROOT, ts);

  if (dryRun) {
    console.log(`[dry-run] backup: would create ${rel(outDir)}/`);
    console.log(`[dry-run] backup: would dump CREATE TABLE + CREATE INDEX DDL for each table to ${rel(join(outDir, "schema.sql"))}`);
    for (const table of LIVE_TABLES) {
      console.log(`[dry-run] backup: would run keyset-paginated "SELECT * FROM ${table} WHERE <pk> > ? ORDER BY <pk> LIMIT 1000",`);
      console.log(`[dry-run] backup:   writing to ${rel(join(outDir, `${table}.jsonl`))}`);
      console.log(`[dry-run] backup:   then re-COUNT(*) after the dump and compare to the pre-dump COUNT(*) (race detection)`);
    }
    console.log(`[dry-run] backup: would write manifest to ${rel(join(outDir, "manifest.json"))} including liveCounts + liveContentFingerprint + stagingContentHash (panel finding C3 run-manifest binding; content fingerprint per Important finding #2)`);
    return { outDir, manifest: null };
  }

  mkdirSync(outDir, { recursive: true });
  const client = await makeClient();
  // Run-manifest binding (panel finding C3): liveCounts is the live-state snapshot every later
  // step (stage/verify/promote) will re-check itself against before proceeding; stagingContentHash
  // binds the staging DATASET this backup was taken alongside, so a later step can detect either
  // "live moved" or "staging dataset changed" drift, not just one or the other. liveContentFingerprint
  // (Important finding #2) closes the gap COUNT(*) leaves open: an UPDATE, or a DELETE+INSERT that
  // preserves row count, is invisible to liveCounts alone but changes the fingerprint.
  const liveCounts = await readLiveCounts(client);
  const liveContentFingerprint = await readLiveContentFingerprint(client);
  const stagingContentHash = hashStagingContent();
  const manifest = { timestamp: ts, tables: {}, liveCounts, liveContentFingerprint, stagingContentHash };

  // Schema DDL dump (Antigravity panel Important #5): JSONL row-data alone cannot rebuild a table
  // with its indexes/constraints. Capture the CREATE TABLE + CREATE INDEX statements for exactly
  // the tables this backup covers (LIVE_TABLES: tires, tire_part_numbers) straight from
  // sqlite_master, so `schema.sql` + the `.jsonl` dumps together are a complete bare-restore kit for
  // THIS backup's scope. Deliberately scoped to LIVE_TABLES only (not every table in the database) -
  // this command's contract is "backup tires + tire_part_numbers", and dumping unrelated operational
  // tables' schema here would blur that scope without adding restore value (operational tables are
  // never touched by this promotion at all, per OPERATIONAL_TABLES).
  const schemaRes = await client.execute(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') AND tbl_name IN (${LIVE_TABLES.map((t) => `'${t}'`).join(",")}) ORDER BY type DESC, name`
  );
  const schemaStatements = schemaRes.rows
    .filter((r) => r.sql) // auto-indexes (PK-backed) have a NULL sql and need no separate statement
    .map((r) => `${r.sql};`);
  const schemaPath = join(outDir, "schema.sql");
  writeFileSync(
    schemaPath,
    `-- Schema DDL for LIVE_TABLES (${LIVE_TABLES.join(", ")}) captured at backup time (${ts}).\n` +
      `-- Restore order: CREATE TABLE statements first, then load each table's .jsonl, then CREATE\n` +
      `-- INDEX statements.\n\n` +
      schemaStatements.join("\n") + (schemaStatements.length ? "\n" : ""),
    "utf8"
  );
  manifest.schemaFile = "schema.sql";
  console.log(`backup: wrote schema DDL (${schemaStatements.length} statements) to ${rel(schemaPath)}`);

  const BATCH = 1000;
  for (const table of LIVE_TABLES) {
    console.log(`backup: dumping ${table}...`);
    const pk = table === "tires" ? "barcode" : "normalized_part_number";
    const preCountRes = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
    const preCount = Number(preCountRes.rows[0].c);
    const filePath = join(outDir, `${table}.jsonl`);
    let written = 0;
    let lines = [];
    // Keyset pagination (Antigravity panel Important #6), NOT OFFSET-based: OFFSET re-scans and
    // re-skips every prior row on each page, so a concurrent INSERT/DELETE ahead of the cursor
    // during the dump can shift row positions and cause a row to be skipped or duplicated across
    // pages. Keyset pagination (`WHERE pk > lastSeenPk ORDER BY pk LIMIT n`) anchors each page to
    // the actual last key seen, which is stable under concurrent writes elsewhere in the table
    // (new rows sort after the cursor and are simply picked up or missed consistently, never
    // reshuffling already-paginated rows). This is still a live table without a snapshot/transaction
    // boundary held open across pages, so true point-in-time consistency requires promote to run in
    // a quiescent window (documented below); the count-consistency check catches any drift.
    let lastKey = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = lastKey === null
        ? await client.execute(`SELECT * FROM ${table} ORDER BY ${pk} LIMIT ${BATCH}`)
        : await client.execute({ sql: `SELECT * FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ${BATCH}`, args: [lastKey] });
      if (res.rows.length === 0) break;
      for (const row of res.rows) {
        lines.push(JSON.stringify(row));
        written++;
      }
      lastKey = res.rows[res.rows.length - 1][pk];
      if (res.rows.length < BATCH) break;
    }
    writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

    // Race/drift detection: re-count after the dump. A mismatch means concurrent writes touched
    // this table DURING the dump - the operator must re-run backup in a quiescent window rather
    // than trust a dump taken while live traffic was still writing.
    const postCountRes = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
    const postCount = Number(postCountRes.rows[0].c);
    const countDrift = postCount !== preCount;
    const consistent = written === preCount && !countDrift;

    manifest.tables[table] = {
      rowCount: written,
      file: `${table}.jsonl`,
      preDumpCount: preCount,
      postDumpCount: postCount,
      consistent,
    };
    console.log(
      `backup: wrote ${written} rows to ${rel(filePath)} (pre-count ${preCount}, post-count ${postCount})` +
        (consistent ? "" : " -- WARNING: count drift detected, table was written to during the dump; re-run backup in a quiescent window before promoting")
    );
  }

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`backup: wrote manifest to ${rel(manifestPath)}`);
  return { outDir, manifest };
}

// =============================================================================================
// stage: create staging_* tables on live and load them from the turso-staging SQL files in
// batched transactions. Idempotent: DROP staging_* first. Writes ONLY staging_* tables.
// =============================================================================================
function stagingTableNamesInScope() {
  return [
    "staging_tires",
    "staging_tire_part_numbers",
    "staging_tire_product_part_number_aliases",
    "staging_canonical_tire_products",
    "staging_provenance",
  ];
}

async function cmdStage({ dryRun, manifestArg }) {
  requireConfirmOrExit(dryRun);

  const dropStatements = stagingTableNamesInScope().map((t) => `DROP TABLE IF EXISTS ${t};`);

  const fileStatements = [];
  const expectedCounts = {};
  for (const fname of STAGING_FILES_ORDER) {
    const fpath = join(STAGING_DIR, fname);
    if (!existsSync(fpath)) {
      throw new Error(`Missing staging SQL file: ${rel(fpath)}`);
    }
    const text = readFileSync(fpath, "utf8");
    const statements = splitSqlStatements(text);
    fileStatements.push({ file: fname, statements });
    // Expected row count is derived from the SOURCE FILE itself (the tuple count the generator
    // wrote), never from a hardcoded number, so this stays correct if the dataset is regenerated.
    expectedCounts[STAGING_FILE_TO_TABLE[fname]] = countValueTuples(text);
  }

  if (dryRun) {
    console.log(`[dry-run] stage: would DROP TABLE IF EXISTS on ${dropStatements.length} staging tables:`);
    for (const s of dropStatements) console.log(`  ${s}`);
    for (const { file, statements } of fileStatements) {
      console.log(`[dry-run] stage: would load ${rel(join(STAGING_DIR, file))} (${statements.length} statement(s))`);
    }
    console.log(`[dry-run] stage: would write expected-count manifest ${JSON.stringify(expectedCounts)}`);
    console.log(`[dry-run] stage: would re-check live counts + staging content hash against the bound run-manifest (panel finding C3) before proceeding`);
    return;
  }

  // Panel finding C3: bind this run to a specific backup's run-manifest, and refuse if live has
  // moved (or the staging dataset has changed) since that backup was taken. This makes the
  // multi-step backup->stage->verify->promote workflow's implicit ordering an ENFORCED invariant
  // instead of an assumption - a live write landing between steps is now DETECTED, not silently lost.
  const manifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(manifestPath, "stage");
  const client = await makeClient();
  await assertLiveUnchangedSinceManifest(client, runManifest, "stage");
  assertStagingContentUnchangedSinceManifest(runManifest, "stage");
  console.log(`stage: bound to run-manifest ${rel(manifestPath)} - live counts and staging content confirmed unchanged since backup.`);

  // Panel finding I3: hard-enforce operational-table isolation on every statement about to run,
  // regardless of where it came from (this script's own drop list, or the staging SQL files - which
  // could be a stale/tampered/wrong PROMOTE_STAGING_DIR in a real run).
  assertAllowedTables(dropStatements, "stage (drop)");
  for (const { file, statements } of fileStatements) {
    assertAllowedTables(statements, `stage (${file})`);
  }

  console.log("stage: dropping any pre-existing staging_* tables (idempotent)...");
  await client.batch(dropStatements, "write");

  for (const { file, statements } of fileStatements) {
    console.log(`stage: loading ${file} (${statements.length} statement(s))...`);
    // Batch per file in chunks to stay well under any single-batch size limit; each chunk is its
    // own transaction via client.batch(), which is fine because CREATE TABLE IF NOT EXISTS +
    // INSERT OR REPLACE are both idempotent and safe to interleave across chunk boundaries.
    const CHUNK = 50;
    for (let i = 0; i < statements.length; i += CHUNK) {
      await client.batch(statements.slice(i, i + CHUNK), "write");
    }
    console.log(`stage: ${file} loaded.`);
  }

  // Persist the expected-count manifest so verify() can assert EXACT counts (panel finding I1),
  // catching a mid-run crash that leaves a staging table truncated (count > 0 but short of the
  // source file's true tuple count). Written into STAGING_DIR so it travels with the dataset and
  // survives process restarts between `stage` and `verify`.
  mkdirSync(STAGING_DIR, { recursive: true });
  const expectedCountsManifestPath = join(STAGING_DIR, MANIFEST_FILE_NAME);
  writeFileSync(expectedCountsManifestPath, JSON.stringify({ generatedAt: new Date().toISOString(), expectedCounts }, null, 2), "utf8");
  console.log(`stage: wrote expected-count manifest to ${rel(expectedCountsManifestPath)}`);

  console.log("stage: complete. Only staging_* tables were written.");
}

// =============================================================================================
// verify: run the gate queries against the live staging_* tables (counts match manifest, joins
// healthy, all live keys present per preflight expectations, zero touches of operational tables).
// =============================================================================================
/** Load the expected-count manifest written by stage(). Returns null if missing (e.g. verify run
 *  without a prior stage in this STAGING_DIR) so callers can fail loudly instead of silently
 *  degrading to a count>0 check. */
function loadExpectedCountsManifest() {
  const manifestPath = join(STAGING_DIR, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return parsed.expectedCounts ?? null;
  } catch {
    return null;
  }
}

/** The actual gate battery, shared by cmdVerify (a standalone check) AND cmdPromote (Critical
 *  finding #1: promote must not trust a PRIOR, separate verify run - it must re-run the FULL gate
 *  set against the live staging_* tables in the SAME invocation, immediately before the atomic
 *  swap, and abort if anything fails). Runs every gate against `client` and returns { passed, gates }
 *  - never throws itself; a per-gate exception is captured as a failed gate so one bad query cannot
 *  abort the whole battery early and hide the other gates' results. */
async function runVerifyGates(client) {
  const gates = [];

  // Panel finding I1: verify must catch a PARTIAL/TRUNCATED staging load, not just count > 0. The
  // manifest written by stage() (counted from the staging SQL files themselves) is the source of
  // truth for the exact expected count of every staged table.
  const expectedCounts = loadExpectedCountsManifest();

  async function gate(name, fn) {
    try {
      const result = await fn();
      gates.push({ name, ...result });
      return result;
    } catch (e) {
      gates.push({ name, pass: false, detail: `ERROR: ${e.message}` });
      return { pass: false };
    }
  }

  await gate("A_integrity_check", async () => {
    const res = await client.execute("PRAGMA integrity_check");
    const value = String(res.rows[0]?.integrity_check ?? res.rows[0]?.[Object.keys(res.rows[0] || {})[0]] ?? "");
    return { pass: value.toLowerCase() === "ok", detail: value };
  });

  await gate("Z_expected_counts_manifest_present", async () => ({
    pass: expectedCounts !== null,
    detail: expectedCounts !== null
      ? `manifest loaded: ${JSON.stringify(expectedCounts)}`
      : `MISSING ${rel(join(STAGING_DIR, MANIFEST_FILE_NAME))} - run stage first; refusing to fall back to a weak count>0 check`,
  }));

  async function exactCountGate(name, table) {
    return gate(name, async () => {
      const res = await client.execute(`SELECT COUNT(*) c FROM ${table}`);
      const actual = Number(res.rows[0].c);
      const expected = expectedCounts ? expectedCounts[table] : undefined;
      if (expected === undefined) {
        return { pass: false, detail: `no expected count for ${table} in manifest (actual=${actual})` };
      }
      return {
        pass: actual === expected,
        detail: actual === expected
          ? `${actual} rows (matches expected ${expected})`
          : `MISMATCH: ${actual} rows, expected EXACTLY ${expected} (partial/truncated load?)`,
      };
    });
  }

  await exactCountGate("B_staging_tires_count", "staging_tires");
  await exactCountGate("C_staging_tire_part_numbers_count", "staging_tire_part_numbers");
  await exactCountGate("C2a_staging_aliases_count", "staging_tire_product_part_number_aliases");
  await exactCountGate("C2b_staging_canonical_products_count", "staging_canonical_tire_products");
  await exactCountGate("C2c_staging_provenance_count", "staging_provenance");

  await gate("D_orphan_part_numbers", async () => {
    const res = await client.execute(
      `SELECT COUNT(*) c FROM staging_tire_part_numbers p
       LEFT JOIN staging_tires t ON t.canonical_product_uid = p.canonical_product_uid
       WHERE t.barcode IS NULL`
    );
    const c = Number(res.rows[0].c);
    return { pass: c === 0, detail: `${c} orphans` };
  });

  await gate("E_duplicate_part_number_keys", async () => {
    const res = await client.execute(
      `SELECT normalized_part_number, COUNT(*) c FROM staging_tire_part_numbers
       GROUP BY normalized_part_number HAVING c > 1`
    );
    return { pass: res.rows.length === 0, detail: `${res.rows.length} duplicate group(s)` };
  });

  await gate("F_orphan_aliases", async () => {
    const res = await client.execute(
      `SELECT COUNT(*) c FROM staging_tire_product_part_number_aliases a
       LEFT JOIN staging_canonical_tire_products c ON c.canonical_product_id = a.canonical_product_id
       WHERE c.canonical_product_id IS NULL`
    );
    const c = Number(res.rows[0].c);
    return { pass: c === 0, detail: `${c} orphans` };
  });

  await gate("G_live_tire_keys_preserved", async () => {
    const liveRes = await client.execute("SELECT barcode FROM tires");
    const liveBarcodes = liveRes.rows.map((r) => String(r.barcode));
    const stagingRes = await client.execute("SELECT barcode FROM staging_tires");
    const stagingSet = new Set(stagingRes.rows.map((r) => String(r.barcode)));
    const missing = liveBarcodes.filter((b) => !stagingSet.has(b));
    return {
      pass: missing.length === 0,
      detail: missing.length === 0 ? `all ${liveBarcodes.length} live keys present` : `${missing.length} missing: ${missing.slice(0, 10).join(", ")}`,
    };
  });

  await gate("PN_live_part_number_keys_preserved", async () => {
    // Re-review OPEN-1 / Codex C1: hard executable diff of live tire_part_numbers keys vs the
    // staged replacement set. Gate G above covers only tires.barcode; without THIS gate a
    // promotion could silently drop any live part-number key (the 17 owner-approved ones, or any
    // new one) with no verify tripwire. Every missing live key must appear in
    // APPROVED_PN_KEY_DROPS.csv (explicit owner decision, referenced + dated) or the gate fails.
    const liveRes = await client.execute("SELECT normalized_part_number FROM tire_part_numbers");
    const liveKeys = new Set(liveRes.rows.map((r) => String(r.normalized_part_number)));
    const stagingRes = await client.execute("SELECT normalized_part_number FROM staging_tire_part_numbers");
    const stagingKeys = new Set(stagingRes.rows.map((r) => String(r.normalized_part_number)));
    const approvedDrops = loadApprovedDrops();
    const result = computePnKeyPreservation(liveKeys, stagingKeys, approvedDrops);
    return { pass: result.pass, detail: result.detail };
  });

  await gate("H_operational_tables_untouched", async () => {
    // Informational: confirm none of the staging load created/renamed any operational table.
    const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(res.rows.map((r) => String(r.name)));
    const touched = OPERATIONAL_TABLES.filter((t) => !names.has(t) && names.has(`staging_${t}`));
    return { pass: touched.length === 0, detail: touched.length === 0 ? "no operational tables staged" : `VIOLATION: ${touched.join(", ")}` };
  });

  const passed = gates.every((g) => g.pass);
  return { passed, gates };
}

async function cmdVerify({ dryRun, manifestArg }) {
  if (dryRun) {
    // Codex panel finding M1: dry-run previously returned { passed: true }, which reads as a real
    // PASS to any caller/script that checks `.passed` - but NOTHING was evaluated; dry-run only
    // prints the gate descriptions. Print an explicit "DRY-RUN: not evaluated" marker (never
    // PASS/FAIL wording) and return passed: null so a caller cannot mistake this for a real result.
    console.log("[dry-run] verify: DRY-RUN: not evaluated. Would run the following gates against staging_* tables:");
    console.log("  Gate A: PRAGMA integrity_check - DRY-RUN: not evaluated");
    console.log("  Gate B: staging_tires EXACT row count vs stage_expected_counts.json manifest - DRY-RUN: not evaluated");
    console.log("  Gate C: staging_tire_part_numbers EXACT row count vs manifest - DRY-RUN: not evaluated");
    console.log("  Gate C2: staging_tire_product_part_number_aliases / staging_canonical_tire_products / staging_provenance EXACT counts vs manifest - DRY-RUN: not evaluated");
    console.log("  Gate D: orphan staging_tire_part_numbers rows (LEFT JOIN staging_tires, expect 0) - DRY-RUN: not evaluated");
    console.log("  Gate E: duplicate normalized_part_number in staging_tire_part_numbers (expect 0 groups) - DRY-RUN: not evaluated");
    console.log("  Gate F: orphan staging_tire_product_part_number_aliases rows (expect 0) - DRY-RUN: not evaluated");
    console.log("  Gate G: every live tires.barcode present in staging_tires (expect 0 missing) - DRY-RUN: not evaluated");
    console.log("  Gate PN: every live tire_part_numbers key present in staging_tire_part_numbers, or explicitly listed in APPROVED_PN_KEY_DROPS.csv (unapproved missing = FAIL) - DRY-RUN: not evaluated");
    console.log("  Gate H: operational tables untouched (SELECT COUNT(*) unchanged vs backup manifest, informational) - DRY-RUN: not evaluated");
    console.log("[dry-run] verify: DRY-RUN COMPLETE - no gate was evaluated, no PASS/FAIL verdict was reached. Run without --dry-run to actually verify.");
    return { passed: null, gates: [], dryRun: true };
  }

  const client = await makeClient();

  // Panel finding C3: re-check this run is still bound to the same live/staging state the backup
  // captured, before spending time on the gates below.
  const runManifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(runManifestPath, "verify");
  await assertLiveUnchangedSinceManifest(client, runManifest, "verify");
  assertStagingContentUnchangedSinceManifest(runManifest, "verify");
  console.log(`verify: bound to run-manifest ${rel(runManifestPath)} - live counts and staging content confirmed unchanged since backup.`);

  const { passed, gates } = await runVerifyGates(client);
  console.log("verify results:");
  for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
  console.log(passed ? "verify: ALL GATES PASSED" : "verify: GATE FAILURE - do not promote");
  return { passed, gates };
}

// =============================================================================================
// Secondary indexes the promoted `tires` / `tire_part_numbers` / alias table need, mirroring the
// local better-sqlite3 builder (build-knowledge-db.mjs:167-169 creates idx_tire_barcode,
// idx_tire_part_number, idx_tire_uid) so every runtime lookup column used by
// src/server/tire-knowledge/tireKnowledgeIndex.ts's Turso paths is covered - not just the PK.
//
// Panel finding C1: the bare rename-swap ships tables with ONLY their PRIMARY KEY covered
// (barcode on tires, normalized_part_number on tire_part_numbers). Every UID-keyed lookup
// (lookupPartNumberTurso's second step, lookupAllPartNumberTurso's JOIN, lookupPartNumberAliasTurso's
// resolve-by-uid step) filters on tires.canonical_product_uid, which has NO index without this.
// tire_product_part_number_aliases is looked up by normalized_part_number, which the table's
// PRIMARY KEY (canonical_product_id, normalized_part_number) does NOT cover as a leading column
// (SQLite/libsql can only use a composite index/PK for a leading-column search; normalized_part_number
// is the second column here) - so it needs its own secondary index too.
//
// WHY THESE RUN AFTER THE RENAME (not indexed on the staging_* names before rename): libsql/SQLite
// keeps an index attached to a table across ALTER TABLE ... RENAME TO (the index's root page moves
// with the table, only sqlite_master's table-name pointer changes) - so indexing before or after
// the rename would both leave the FINAL table with the index attached. Indexing AFTER is chosen
// here because it lets a single ordered statement list read top-to-bottom as "rename, then index the
// thing that now has the live name" - directly matching the live schema that must exist afterward -
// and because it means a promote that only gets to the rename half (impossible in today's
// single-batch atomic design, but a defensive choice against any future refactor that splits the
// batch) still leaves indexes as a separate, easily-retried step rather than baked into a
// still-being-renamed table.
//
// SECOND-PROMOTE INDEX-NAME CARRYOVER (fix round 3, found while building the double-promote path):
// SQLite/libsql index names are GLOBAL per database, and a rename carries a table's indexes - WITH
// their names - to the renamed table. So on a second promote, `tires` (holding idx_tire_barcode et
// al from promote #1) is renamed to `tires_old_<ts2>` and TAKES the index names with it; a naive
// `CREATE INDEX IF NOT EXISTS idx_tire_barcode ...` is then a silent NO-OP (the NAME exists, on
// the old table) and the freshly promoted table would ship UNINDEXED - exactly the C1 regression,
// reintroduced silently on every promote after the first. The fix: every index statement is a
// `DROP INDEX IF EXISTS <name>` (frees the name from whichever generation holds it; the displaced
// _old_ generation is a rollback net, not a query target, so losing its secondary indexes is
// acceptable and rollback recreates them on restore) followed by a plain `CREATE INDEX` (no IF NOT
// EXISTS - after the drop, a name collision would be a real error and must fail loud).
const INDEX_DEFS = [
  { name: "idx_tire_barcode", table: "tires", column: "barcode" },
  { name: "idx_tire_part_number", table: "tires", column: "manufacturer_part_number" },
  { name: "idx_tire_uid", table: "tires", column: "canonical_product_uid" },
  { name: "idx_tire_part_numbers_uid", table: "tire_part_numbers", column: "canonical_product_uid" },
  { name: "idx_tire_pn_aliases_normalized", table: "tire_product_part_number_aliases", column: "normalized_part_number" },
];

/** Index statements for the live table set. `tables` filters which tables get their indexes
 *  (rollback needs this: on a FIRST-promote rollback the alias/canonical/provenance tables are
 *  DROPPED, so creating an index on them would error). Defaults to all. */
function postSwapIndexStatements(tables = null) {
  return INDEX_DEFS
    .filter((d) => tables === null || tables.includes(d.table))
    .flatMap((d) => [
      `DROP INDEX IF EXISTS ${d.name};`,
      `CREATE INDEX ${d.name} ON ${d.table}(${d.column});`,
    ]);
}

/** Automated post-swap smoke test (panel finding I3). Runs the runtime-shaped lookups the panel's
 *  Gate I/J called for by hand: a barcode hit, a part-number two-step hit, and an alias-fallback
 *  hit, each sampled from the JUST-PROMOTED live tables, PLUS (re-review OPEN-1) a full
 *  live-part-number key-preservation diff of `tire_part_numbers_old_<ts>` vs the new live
 *  `tire_part_numbers`, honoring APPROVED_PN_KEY_DROPS.csv, PLUS (Critical finding #1c) an exact
 *  row-count equality check between the pre-swap staged counts and the post-swap live counts for
 *  ALL FIVE promoted tables - not just a single sampled barcode/part-number/alias. `ts` identifies
 *  the _old_ generation this promotion just created. `preSwapStagedCounts` (optional, keyed by
 *  `staging_<table>` name) is the exact row count of each staging_* table captured immediately
 *  before the swap; when omitted the count-equality check is skipped (used by tests/callers that
 *  only care about the identity-lookup checks). Returns { pass, checks } and NEVER throws (a lookup
 *  error is recorded as a failed check, not an unhandled exception) so cmdPromote can always decide
 *  PASS/FAIL and report clearly. */
async function runPostSwapSmokeTest(client, ts, preSwapStagedCounts = null) {
  const checks = [];
  async function check(name, fn) {
    try {
      const result = await fn();
      checks.push({ name, ...result });
    } catch (e) {
      checks.push({ name, pass: false, detail: `ERROR: ${e.message}` });
    }
  }

  if (preSwapStagedCounts) {
    // Critical finding #1(c): every promoted table's LIVE row count after the swap must equal
    // EXACTLY what was staged before the swap. A partial rename batch, a driver-level truncation, or
    // any other swap anomaly that the single-sample lookups below could miss is caught here across
    // all 5 tables, not just the 2 originally sampled.
    const liveTableFor = {
      staging_tires: "tires",
      staging_tire_part_numbers: "tire_part_numbers",
      staging_tire_product_part_number_aliases: "tire_product_part_number_aliases",
      staging_canonical_tire_products: "canonical_tire_products",
      staging_provenance: "provenance",
    };
    await check("smoke_full_row_count_equality", async () => {
      const mismatches = [];
      for (const [stagingName, liveName] of Object.entries(liveTableFor)) {
        const expected = preSwapStagedCounts[stagingName];
        if (expected === undefined) continue; // caller did not capture this table; skip rather than false-fail
        const res = await client.execute(`SELECT COUNT(*) c FROM ${liveName}`);
        const actual = Number(res.rows[0].c);
        if (actual !== expected) {
          mismatches.push(`${liveName}: staged ${expected}, live ${actual}`);
        }
      }
      return {
        pass: mismatches.length === 0,
        detail: mismatches.length === 0
          ? `all 5 tables: live count exactly matches pre-swap staged count`
          : `MISMATCH: ${mismatches.join("; ")}`,
      };
    });
  }

  await check("smoke_barcode_lookup", async () => {
    const sampleRes = await client.execute("SELECT barcode FROM tires LIMIT 1");
    if (sampleRes.rows.length === 0) return { pass: false, detail: "tires table is empty after promote" };
    const barcode = sampleRes.rows[0].barcode;
    const hitRes = await client.execute({ sql: "SELECT * FROM tires WHERE barcode = ?", args: [barcode] });
    return {
      pass: hitRes.rows.length === 1,
      detail: hitRes.rows.length === 1 ? `barcode ${barcode} resolved` : `barcode ${barcode} did not resolve (${hitRes.rows.length} rows)`,
    };
  });

  await check("smoke_part_number_two_step", async () => {
    const sampleRes = await client.execute("SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers LIMIT 1");
    if (sampleRes.rows.length === 0) return { pass: false, detail: "tire_part_numbers table is empty after promote" };
    const { normalized_part_number: pn } = sampleRes.rows[0];
    // Mirror lookupPartNumberTurso's exact two-step shape.
    const step1 = await client.execute({
      sql: "SELECT canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number = ?",
      args: [pn],
    });
    if (step1.rows.length === 0) return { pass: false, detail: `part number ${pn} missing on re-select` };
    const uid = step1.rows[0].canonical_product_uid;
    const step2 = await client.execute({ sql: "SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1", args: [uid] });
    return {
      pass: step2.rows.length === 1,
      detail: step2.rows.length === 1 ? `part number ${pn} -> uid ${uid} resolved` : `part number ${pn} -> uid ${uid} did NOT resolve to a tires row`,
    };
  });

  await check("smoke_alias_fallback", async () => {
    const sampleRes = await client.execute("SELECT normalized_part_number, canonical_product_id FROM tire_product_part_number_aliases LIMIT 1");
    if (sampleRes.rows.length === 0) {
      // Alias table can legitimately be empty; this is informational, not a hard failure.
      return { pass: true, detail: "tire_product_part_number_aliases is empty (nothing to smoke-test)" };
    }
    const { normalized_part_number: pn } = sampleRes.rows[0];
    // Mirror lookupPartNumberAliasTurso's exact shape.
    const aliasRes = await client.execute({
      sql: "SELECT DISTINCT canonical_product_id FROM tire_product_part_number_aliases WHERE normalized_part_number = ?",
      args: [pn],
    });
    if (aliasRes.rows.length !== 1) return { pass: false, detail: `alias ${pn} resolved to ${aliasRes.rows.length} distinct products, expected 1` };
    const uid = aliasRes.rows[0].canonical_product_id;
    const tireRes = await client.execute({ sql: "SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1", args: [uid] });
    return {
      pass: tireRes.rows.length === 1,
      detail: tireRes.rows.length === 1 ? `alias ${pn} -> uid ${uid} resolved` : `alias ${pn} -> uid ${uid} did NOT resolve to a tires row`,
    };
  });

  await check("smoke_index_presence", async () => {
    // Checks ATTACHMENT (tbl_name), not just name existence: after a second promote, an index name
    // can exist while attached to the renamed _old_ generation (index-name carryover) - a
    // name-only check would silently pass while the live table is unindexed.
    const res = await client.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
    const indexByName = new Map(res.rows.map((r) => [String(r.name), String(r.tbl_name)]));
    const wrong = INDEX_DEFS
      .filter((d) => indexByName.get(d.name) !== d.table)
      .map((d) => `${d.name} (expected on ${d.table}, ${indexByName.has(d.name) ? `found on ${indexByName.get(d.name)}` : "MISSING"})`);
    return {
      pass: wrong.length === 0,
      detail: wrong.length === 0 ? "all 5 required indexes present and attached to the live tables" : `WRONG/MISSING: ${wrong.join("; ")}`,
    };
  });

  await check("smoke_pn_key_preservation", async () => {
    // Re-review OPEN-1: post-swap edition of the verify PN gate - the pre-promotion live keys now
    // live in tire_part_numbers_old_<ts>, and the promoted set IS the new live tire_part_numbers.
    // Every key of the old live table must exist in the new one, or be explicitly listed in
    // APPROVED_PN_KEY_DROPS.csv. This catches a wrong swap even if verify was skipped or a
    // different staging generation was promoted than the one verified.
    if (!ts) return { pass: false, detail: "no ts provided - cannot locate tire_part_numbers_old_<ts>" };
    const oldRes = await client.execute(`SELECT normalized_part_number FROM tire_part_numbers_old_${ts}`);
    const oldKeys = new Set(oldRes.rows.map((r) => String(r.normalized_part_number)));
    const newRes = await client.execute("SELECT normalized_part_number FROM tire_part_numbers");
    const newKeys = new Set(newRes.rows.map((r) => String(r.normalized_part_number)));
    const approvedDrops = loadApprovedDrops();
    const result = computePnKeyPreservation(oldKeys, newKeys, approvedDrops);
    return { pass: result.pass, detail: result.detail };
  });

  const pass = checks.every((c) => c.pass);
  return { pass, checks };
}

// =============================================================================================
// promote: ATOMIC swap in a single batch: rename tires->tires_old_<ts>, staging_tires->tires,
// same for tire_part_numbers; the three NEW_TABLES get the SAME rename-aside treatment when their
// live name already exists (second/subsequent promote - fix round 3, task-PROMOTE2-EXEC-report.md)
// and the original straight create-from-staging rename when it does not (first promote). THEN the
// secondary indexes are (re)created on the now-live table names (panel finding C1; DROP+CREATE, not
// IF NOT EXISTS - see the index-name carryover note at INDEX_DEFS). *_old_<ts>* tables are kept
// (never dropped) for rollback. After the swap, an automated post-swap smoke test runs (panel
// finding I3); on FAILURE the _old_ tables are left in place and the process exits nonzero telling
// the operator to run rollback - the swap itself is not reverted automatically (that would race a
// second live write against the just-promoted tables), but nothing forces the operator to accept a
// bad swap.
// =============================================================================================
async function cmdPromote({ dryRun, manifestArg }) {
  requireConfirmOrExit(dryRun);
  const ts = timestamp();

  const baseRenameStatements = [
    `ALTER TABLE tires RENAME TO tires_old_${ts};`,
    `ALTER TABLE staging_tires RENAME TO tires;`,
    `ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_old_${ts};`,
    `ALTER TABLE staging_tire_part_numbers RENAME TO tire_part_numbers;`,
  ];

  if (dryRun) {
    // NEW_TABLES handling is live-state-dependent (rename-aside only when the live name exists);
    // dry-run has no client, so it prints the base statements plus an explicit description of the
    // conditional branch rather than pretending to know live state.
    console.log(`[dry-run] promote: would execute the following in ONE atomic batch (ts=${ts}):`);
    for (const s of baseRenameStatements) console.log(`  ${s}`);
    for (const { staging, live } of NEW_TABLES) {
      console.log(`  [conditional] IF live table ${live} exists (a prior promote created it): ALTER TABLE ${live} RENAME TO ${live}_old_${ts}; then ALTER TABLE ${staging} RENAME TO ${live};`);
      console.log(`  [conditional] ELSE (first promote): ALTER TABLE ${staging} RENAME TO ${live};`);
    }
    for (const s of postSwapIndexStatements()) console.log(`  ${s}`);
    console.log(`[dry-run] promote: *_old_${ts} tables would be kept (not dropped) for rollback.`);
    console.log("[dry-run] promote: would first re-check live counts + staging content hash against the bound run-manifest (panel finding C3).");
    console.log("[dry-run] promote: would then run an automated post-swap smoke test (barcode / part-number / alias lookups + index presence + live-PN-key preservation vs APPROVED_PN_KEY_DROPS.csv).");
    return { ts, statements: baseRenameStatements };
  }

  const client = await makeClient();

  // Panel finding C3: re-check this run is still bound to the same live/staging state the backup
  // captured. This is the LAST gate before the irreversible-in-practice swap executes, so it is
  // checked here even though stage() and verify() already checked it earlier in the pipeline - a
  // write could still land in the window between verify and promote.
  const runManifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(runManifestPath, "promote");
  await assertLiveUnchangedSinceManifest(client, runManifest, "promote");
  assertStagingContentUnchangedSinceManifest(runManifest, "promote");
  console.log(`promote: bound to run-manifest ${rel(runManifestPath)} - live counts and staging content confirmed unchanged since backup.`);

  // Critical finding #1(a): promote must NEVER trust a prior, separate `verify` invocation - staging
  // could have been truncated, tampered, or re-staged since that run without anyone re-verifying.
  // Re-run the FULL gate battery (runVerifyGates - the exact same gates cmdVerify runs, including
  // content gates B/C/C2/D/E/F/G/PN, not just row counts) against the live staging_* tables in THIS
  // invocation, immediately before the atomic swap, and ABORT if any gate fails. This makes "promote"
  // a self-contained verify+swap operation rather than two commands whose ordering is only a
  // convention - a stale/skipped verify can no longer let corrupted staging reach production.
  console.log("promote: re-running the full verify gate battery against live staging_* tables before swapping (Critical finding #1)...");
  const preSwapVerify = await runVerifyGates(client);
  console.log("promote: pre-swap verify gate results:");
  for (const g of preSwapVerify.gates) console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
  if (!preSwapVerify.passed) {
    const failedNames = preSwapVerify.gates.filter((g) => !g.pass).map((g) => g.name);
    throw new Error(
      `promote: REFUSING to swap - the pre-swap verify gate battery FAILED (${failedNames.join(", ")}). ` +
        `Staging is not in a known-good state; promoting it would publish unverified or corrupted data. ` +
        `Fix the staged data (re-run "node scripts/tire-db-repair/10_promote_execute.mjs stage" against a ` +
        `correct dataset, or investigate the failing gate(s) above) and re-run promote. The swap did NOT run.`
    );
  }
  console.log("promote: pre-swap verify gate battery PASSED. Proceeding to the atomic swap.");

  const existingRes = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const existingNames = new Set(existingRes.rows.map((r) => String(r.name)));

  // Fix round 3 (live promote #2 gap, task-PROMOTE2-EXEC-report.md): the three NEW_TABLES now get
  // the SAME rename-aside treatment as tires/tire_part_numbers. On a second promote their live
  // names already exist (created by promote #1); renaming them to `<name>_old_<ts>` inside the
  // same atomic batch preserves the prior generation as a rollback net and frees the live name for
  // the staged replacement. On a FIRST promote (live name absent) the original straight
  // create-from-staging rename is used unchanged.
  const newTableStatements = [];
  const renamedAsideNewTables = [];
  for (const { staging, live } of NEW_TABLES) {
    if (existingNames.has(live)) {
      newTableStatements.push(`ALTER TABLE ${live} RENAME TO ${live}_old_${ts};`);
      renamedAsideNewTables.push(live);
    }
    newTableStatements.push(`ALTER TABLE ${staging} RENAME TO ${live};`);
  }

  // Re-promotion collision guard (Antigravity panel Minor #7, narrowed in fix round 3): with the
  // NEW_TABLES rename-aside path in place, an existing NEW_TABLES live name is no longer a refusal
  // (it is the normal second-promote input). The only remaining genuine collisions are the
  // `_old_<ts>` names this batch would CREATE already existing - i.e. PROMOTE_TS was reused, or
  // two promote runs landed in the same clock-second.
  const oldNamesThisRun = [
    `tires_old_${ts}`,
    `tire_part_numbers_old_${ts}`,
    ...renamedAsideNewTables.map((live) => `${live}_old_${ts}`),
  ];
  const collisions = oldNamesThisRun.filter((n) => existingNames.has(n));
  if (collisions.length > 0) {
    throw new Error(
      `promote: REFUSING to run - _old_ table name(s) this promotion would create already exist: ` +
        `${collisions.join(", ")}. This means a promotion already ran at this same timestamp "${ts}" ` +
        `(PROMOTE_TS reused, or two promote runs landed in the same clock-second). Pick a different ` +
        `PROMOTE_TS (or wait a second) and re-run; if the prior promotion at this ts should instead be ` +
        `superseded, roll it back first (node scripts/tire-db-repair/10_promote_execute.mjs rollback --ts ${ts}).`
    );
  }

  const statements = [...baseRenameStatements, ...newTableStatements, ...postSwapIndexStatements()];

  // Panel finding I3: hard-enforce operational-table isolation before the swap executes.
  assertAllowedTables(statements, "promote");

  // Critical finding #1(c): capture the EXACT pre-swap staged row counts for all 5 tables so the
  // post-swap smoke test can assert live now holds exactly what staging held - not just "a" sample
  // barcode/part-number/alias resolves, but every staged row actually made it across the swap.
  const preSwapStagedCounts = {};
  for (const t of stagingTableNamesInScope()) {
    const res = await client.execute(`SELECT COUNT(*) c FROM ${t}`);
    preSwapStagedCounts[t] = Number(res.rows[0].c);
  }

  console.log(
    `promote: executing atomic swap + index creation (ts=${ts}` +
      (renamedAsideNewTables.length > 0
        ? `; second-promote path: renaming aside ${renamedAsideNewTables.join(", ")}`
        : "; first-promote path: NEW_TABLES created from staging") +
      ")..."
  );
  await client.batch(statements, "write");
  console.log("promote: swap complete. Running post-swap smoke test...");

  const { pass, checks } = await runPostSwapSmokeTest(client, ts, preSwapStagedCounts);
  console.log("post-swap smoke test results:");
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);

  if (!pass) {
    console.error(
      `promote: SMOKE TEST FAILED after swap (ts=${ts}). *_old_${ts} tables were retained (not dropped). ` +
        `Do NOT treat this promotion as successful. Run: ` +
        `node scripts/tire-db-repair/10_promote_execute.mjs rollback --ts ${ts} (with PROMOTE_CONFIRM=YES) to restore the prior live tables.`
    );
    return { ts, statements, smokeTest: { pass, checks }, failed: true };
  }

  console.log("promote: SMOKE TEST PASSED. *_old_" + ts + " tables retained for rollback.");
  return { ts, statements, smokeTest: { pass, checks } };
}

// =============================================================================================
// rollback: swap back from *_old_<ts>.
// =============================================================================================
async function cmdRollback({ dryRun, ts: tsArg }) {
  requireConfirmOrExit(dryRun);

  // Panel finding I2: resolve the timestamp with explicit precedence so a caller who exported
  // PROMOTE_TS (expecting symmetry with the promote invocation) never silently falls through to
  // auto-discovery instead of the timestamp they intended. Precedence: --ts (explicit CLI flag)
  // wins over PROMOTE_TS (env var) wins over auto-discovery from live table names. Auto-discovery
  // itself now errors (rather than silently picking the latest) when MORE THAN ONE _old_
  // generation exists on the target database, since guessing which one to restore in that case is
  // exactly the silent-divergence hazard the panel flagged.
  let ts = tsArg || process.env.PROMOTE_TS;
  let client = null;
  if (!ts) {
    if (dryRun) {
      ts = "<ts>";
    } else {
      client = await makeClient();
      // Discover the most recent _old_ suffix by inspecting table names.
      const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
      const names = res.rows.map((r) => String(r.name));
      const matches = names
        .map((n) => n.match(/^tires_old_(.+)$/))
        .filter(Boolean)
        .map((m) => m[1])
        .sort();
      if (matches.length === 0) {
        throw new Error("rollback: no tires_old_<ts> table found; nothing to roll back to.");
      }
      if (matches.length > 1) {
        throw new Error(
          `rollback: ${matches.length} tires_old_<ts> generations found (${matches.join(", ")}) and neither ` +
            `--ts nor PROMOTE_TS was given. Refusing to guess which one to restore - pass --ts <timestamp> ` +
            `or set PROMOTE_TS explicitly to the generation you intend to roll back to.`
        );
      }
      ts = matches[0];
    }
  }

  const baseStatements = [
    `ALTER TABLE tires RENAME TO tires_failed_promotion_${ts};`,
    `ALTER TABLE tires_old_${ts} RENAME TO tires;`,
    `ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_failed_promotion_${ts};`,
    `ALTER TABLE tire_part_numbers_old_${ts} RENAME TO tire_part_numbers;`,
  ];

  if (dryRun) {
    console.log(`[dry-run] rollback: would execute the following in ONE atomic batch (ts=${ts}):`);
    for (const s of baseStatements) console.log(`  ${s}`);
    for (const { live } of NEW_TABLES) {
      console.log(`  [conditional] IF ${live}_old_${ts} exists (second-promote rollback): ALTER TABLE ${live} RENAME TO ${live}_failed_promotion_${ts}; then ALTER TABLE ${live}_old_${ts} RENAME TO ${live};`);
      console.log(`  [conditional] ELSE (first-promote rollback): DROP TABLE IF EXISTS ${live};`);
    }
    console.log("  [conditional] then DROP INDEX IF EXISTS + CREATE INDEX for every restored table's secondary indexes");
    return { ts, statements: baseStatements };
  }

  // Fix round 3: mirror the promote-side NEW_TABLES rename-aside path. If `<live>_old_<ts>` exists
  // for this ts (i.e. the promotion being rolled back was a SECOND promote that renamed a prior
  // generation aside), restore that generation exactly like tires/tire_part_numbers: current live
  // -> `_failed_promotion_<ts>`, `_old_<ts>` -> live. If it does not exist (first-promote
  // rollback), the original behavior stands: DROP the live table (there was no prior generation).
  if (!client) client = await makeClient();
  const existingRes = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const existingNames = new Set(existingRes.rows.map((r) => String(r.name)));

  const newTableStatements = [];
  const restoredNewTables = [];
  for (const { live } of NEW_TABLES) {
    if (existingNames.has(`${live}_old_${ts}`)) {
      newTableStatements.push(`ALTER TABLE ${live} RENAME TO ${live}_failed_promotion_${ts};`);
      newTableStatements.push(`ALTER TABLE ${live}_old_${ts} RENAME TO ${live};`);
      restoredNewTables.push(live);
    } else {
      newTableStatements.push(`DROP TABLE IF EXISTS ${live};`);
    }
  }

  // Recreate secondary indexes on the RESTORED tables (drop-by-name first: the index names travel
  // with whichever generation last had them created - after this rollback that is the
  // `_failed_promotion_<ts>` set - and index names are global, so the names must be freed before
  // re-creating on the restored live tables). tires/tire_part_numbers are always restored; the
  // alias table's index is only recreated when the alias table itself was restored (creating an
  // index on a dropped table would error the whole batch).
  const restoredTables = ["tires", "tire_part_numbers", ...restoredNewTables];
  const indexStatements = postSwapIndexStatements(restoredTables);

  const statements = [...baseStatements, ...newTableStatements, ...indexStatements];

  // Panel finding I3: hard-enforce operational-table isolation before the rollback executes.
  assertAllowedTables(statements, "rollback");

  console.log(`rollback: executing atomic rollback (ts=${ts})...`);
  await client.batch(statements, "write");
  console.log("rollback: complete. Original tables restored from *_old_" + ts + ".");
  return { ts, statements };
}

// =============================================================================================
// main
// =============================================================================================
async function main() {
  const { subcommand, dryRun } = parseArgs(process.argv);
  const tsFlagIdx = process.argv.indexOf("--ts");
  const ts = tsFlagIdx >= 0 ? process.argv[tsFlagIdx + 1] : undefined;
  const manifestFlagIdx = process.argv.indexOf("--manifest");
  const manifestArg = manifestFlagIdx >= 0 ? process.argv[manifestFlagIdx + 1] : undefined;

  switch (subcommand) {
    case "backup":
      await cmdBackup({ dryRun });
      break;
    case "stage":
      await cmdStage({ dryRun, manifestArg });
      break;
    case "verify": {
      const { passed } = await cmdVerify({ dryRun, manifestArg });
      if (!dryRun && !passed) process.exit(1);
      break;
    }
    case "promote": {
      const result = await cmdPromote({ dryRun, manifestArg });
      if (!dryRun && result?.failed) process.exit(1);
      break;
    }
    case "rollback":
      await cmdRollback({ dryRun, ts });
      break;
    default:
      console.error(
        "Usage: node scripts/tire-db-repair/10_promote_execute.mjs <backup|stage|verify|promote|rollback> [--dry-run] [--ts <timestamp>] [--manifest <path>]"
      );
      process.exit(2);
  }
}

// Only auto-run when executed directly (not when imported by tests). Tests import this module's
// named exports and call cmdX() functions themselves, so they set PROMOTE_SKIP_MAIN=1 first.
if (!process.env.PROMOTE_SKIP_MAIN) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}

export {
  cmdBackup, cmdStage, cmdVerify, cmdPromote, cmdRollback,
  requireConfirmOrExit, resolveConnection, splitSqlStatements, timestamp,
  LIVE_TABLES, NEW_TABLES, OPERATIONAL_TABLES, STAGING_FILES_ORDER,
  postSwapIndexStatements, runPostSwapSmokeTest, countValueTuples, loadExpectedCountsManifest,
  MANIFEST_FILE_NAME, isAllowedTableName, extractTableNames, assertAllowedTables,
  isAllowedNoTableStatement,
  hashStagingContent, readLiveCounts, findLatestManifestPath, resolveManifestPath,
  loadRunManifest, assertLiveUnchangedSinceManifest, assertStagingContentUnchangedSinceManifest,
  loadApprovedDrops, computePnKeyPreservation, APPROVED_DROPS_PATH,
  runVerifyGates, readLiveContentFingerprint, FINGERPRINT_COLUMNS,
};
