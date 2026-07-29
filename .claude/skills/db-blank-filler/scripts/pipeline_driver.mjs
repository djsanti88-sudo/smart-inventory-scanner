#!/usr/bin/env node
// db-blank-filler pipeline driver.
//
// Runs the enrichment/cleaning stages IN ORDER against a specified working DB, honoring a hard
// deadline and the pilot/slice policy. It INVOKES the proven tonight scripts by path (it never
// re-implements their gate/enrichment/validator logic) and it NEVER runs a paid stage unless
// --live is passed. It NEVER writes to live Turso, never runs git, never deploys.
//
// Stages (deterministic-first, paid last), matching the owner-approved cascade:
//   1. b5      deterministic backfill (free)      scripts/tire-db-repair/bakeoff/b5_deterministic_backfill.mjs
//   2. twin    twin COLUMNS (lean, owner-approved) scripts/tire-db-repair/11_twin_columns.mjs
//   3. style   model styling pass (free)          scripts/tire-db-repair/06_model_styling.mjs
//   4. codex   GPT-5.5 batches (PAID, --live)      scripts/tire-db-repair/bakeoff/b6_driver.sh  [gated]
//   5. firecrawl capped fallback (PAID, --live)                                                [gated]
//   6. validate (free, gate)                      scripts/tire-db-repair/05_validate.mjs
//   7. promote (free, gate, MANDATORY pre-promote) scripts/tire-db-repair/09_promote_preflight.mjs
//
// Paid stages 4-5 are the ONLY web/enrichment lanes. Without --live they are SKIPPED and reported
// as skipped (the free stages + validator still run - a safe dry pipeline). The MPN backlog policy
// (200-row pilot, then capped 500-row slices) is surfaced here via --pilot / --slice but the
// actual paid dispatch stays owner-gated (see SKILL.md): the driver stops before paid dispatch and
// prints the batch plan unless --live AND (--pilot|--slice) are BOTH explicitly present.
//
// STANDING RULE (SUPERIORITY STAGE, owner order 2026-07-28): a Turso promote is BLOCKED unless the
// promote-preflight verdict is SUPERIOR - 0 regressions (no live non-blank field going blank), 0
// unexplained key losses (no live part-number key vanishing except the owner-ordered 17), and
// operational/retail tables PROVEN untouched by the staged SQL. This is enforced by the "promote"
// stage below: it runs 09_promote_preflight.mjs (READ-ONLY against live Turso; requires
// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN) and parses PROMOTE_PREFLIGHT_REPORT.md's verdict line. A
// non-SUPERIOR verdict, a missing report, or missing Turso credentials all report
// "blocked-not-superior" / "blocked-no-credentials" - never a silent skip that could be mistaken for
// clearance to promote. The actual `08_promote_atomic.sql` execution against live Turso remains a
// SEPARATE, explicitly owner-approved step; this stage never runs it.
//
// Flags:
//   --db <path>          working DB (REQUIRED - never defaults to the packaged deliverable)
//   --deadline <hours>   hard stop; default 4. Stages check the clock and stop cleanly.
//   --pilot              MPN backlog: plan a 200-row pilot only, then STOP with an economics note.
//   --slice <n>          MPN backlog: plan a capped n-row slice (default 500) - post-pilot runs.
//   --live               permit PAID stages (codex/firecrawl). Absent = free stages only.
//   --stages a,b,c       run only the named stages (default: all).
//   --dry-run            plan + free-stage no-op preview; write nothing.
//   --promote            include the promote-preflight superiority gate (stage "promote"). Off by
//                         default so a routine free-stage run never requires live Turso
//                         credentials; pass this flag (or --stages promote) when checking
//                         promote-readiness. Always read-only against live Turso.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  // Treat a flag-like next token (starts with "--") as "no value" so `--slice --live` uses the
  // fallback rather than swallowing the following flag.
  if (next && !next.startsWith("--")) return next;
  return fallback;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

const DB = argVal("--db", null);
const DEADLINE_H = Number(argVal("--deadline", "4"));
const PILOT = hasFlag("--pilot");
const SLICE = hasFlag("--slice") ? Number(argVal("--slice", "500")) : null;
const LIVE = hasFlag("--live");
const DRY_RUN = hasFlag("--dry-run");
const PROMOTE = hasFlag("--promote");
const ONLY_STAGES = hasFlag("--stages") ? argVal("--stages", "").split(",").map((s) => s.trim()) : null;

if (!DB) {
  console.error("pipeline_driver: --db <path> is REQUIRED (never defaults to the packaged deliverable).");
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`pipeline_driver: working DB not found at ${DB}`);
  process.exit(1);
}
if (!Number.isFinite(DEADLINE_H)) {
  console.error(`pipeline_driver: --deadline must be a finite number of hours, got "${argVal("--deadline", "4")}".`);
  process.exit(1);
}
if (SLICE !== null && (!Number.isInteger(SLICE) || SLICE <= 0)) {
  console.error(`pipeline_driver: --slice must be a positive integer row count, got "${argVal("--slice", "500")}".`);
  process.exit(1);
}

const START = Date.now();
const deadlineMs = START + DEADLINE_H * 3600 * 1000;
const report = { db: DB, deadlineHours: DEADLINE_H, live: LIVE, dryRun: DRY_RUN, stages: [] };

function deadlinePassed() {
  return Date.now() >= deadlineMs;
}
function run(label, cmd, args, { paid = false } = {}) {
  if (ONLY_STAGES && !ONLY_STAGES.includes(label)) {
    report.stages.push({ stage: label, status: "not-selected" });
    return;
  }
  if (deadlinePassed()) {
    report.stages.push({ stage: label, status: "skipped-deadline" });
    return;
  }
  if (paid && !LIVE) {
    report.stages.push({ stage: label, status: "skipped-not-live", note: "PAID stage; pass --live to enable" });
    return;
  }
  if (DRY_RUN) {
    report.stages.push({ stage: label, status: "dry-run", wouldRun: `${cmd} ${args.join(" ")}` });
    return;
  }
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: Math.max(1, deadlineMs - Date.now()) });
  const ok = r.status === 0;
  report.stages.push({
    stage: label,
    status: ok ? "ok" : "failed",
    exit: r.status,
    stdoutTail: (r.stdout || "").trim().split("\n").slice(-3).join(" | "),
    stderrTail: (r.stderr || "").trim().split("\n").slice(-3).join(" | "),
  });
  // Never weaken a gate: a failed validator or gate stage aborts the pipeline.
  if (!ok && (label === "validate" || label === "twin")) {
    report.aborted = `stage ${label} failed - pipeline stopped (gates are never weakened to pass)`;
    finish();
  }
}

function finish() {
  report.elapsedMin = ((Date.now() - START) / 60000).toFixed(1);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.aborted ? 1 : 0);
}

// --- Stage 1: deterministic backfill (free) --------------------------------------------------
run("b5", process.execPath, ["scripts/tire-db-repair/bakeoff/b5_deterministic_backfill.mjs", DB]);

// --- Stage 2: twin COLUMNS, lean model (free, owner-approved 2026-07-28) ----------------------
// Adds barcode_upc + barcode_ean13 COLUMNS to the existing tires row (+0 rows). This REPLACES the
// deprecated row-materialization approach (twin_complete.mjs), which the owner rejected because it
// doubled the tires table (82,673 -> 131,440 rows). Never call twin_complete.mjs from here again.
run("twin", process.execPath, ["scripts/tire-db-repair/11_twin_columns.mjs", DB, ...(DRY_RUN ? ["--dry-run"] : [])]);

// --- Stage 3: model styling (free) -----------------------------------------------------------
run("style", process.execPath, ["scripts/tire-db-repair/06_model_styling.mjs", DB]);

// --- Stage 4: Codex GPT-5.5 batches (PAID) ---------------------------------------------------
// The MPN backlog policy is enforced HERE as a plan, not an auto-dispatch. Even with --live, the
// driver only prints the batch plan; the actual b6_driver.sh dispatch is launched by the operator
// after reading the plan and (for the first ever run) the pilot economics report. This keeps the
// owner-approval stop intact.
if (!ONLY_STAGES || ONLY_STAGES.includes("codex")) {
  const requestedRows = PILOT ? 200 : (SLICE ?? 500);
  // Ground the plan in the WORKING DB's actual eligible-row count instead of always printing the
  // requested number verbatim - an operator reading "plan-ready-live" for a 200-row pilot must be
  // able to trust that 200 real rows exist to work, not a static number disconnected from the
  // DB (found under adversarial testing 2026-07-28: an empty/near-empty working copy still
  // reported "plan-ready-live" for a full 200-row pilot).
  let eligibleRows = null;
  try {
    const require = createRequire(path.join(REPO_ROOT, "package.json"));
    const Database = require("better-sqlite3");
    const db = new Database(DB, { readonly: true });
    const hasTires = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tires'").get();
    if (hasTires) {
      eligibleRows = db
        .prepare(
          `SELECT COUNT(*) c FROM tires
           WHERE (manufacturer_part_number IS NULL OR TRIM(manufacturer_part_number) = '')
             AND length(replace(ltrim(barcode, '0'), '', '')) > 6`
        )
        .get().c;
    }
    db.close();
  } catch {
    eligibleRows = null; // DB unreadable/no tires table - fall back to the requested number, unverified.
  }
  const rows = eligibleRows === null ? requestedRows : Math.min(requestedRows, eligibleRows);
  const queueEmpty = eligibleRows === 0;
  const plan = {
    stage: "codex",
    status: LIVE && !queueEmpty ? "plan-ready-live" : LIVE ? "empty-queue-nothing-to-dispatch" : "skipped-not-live",
    policy: PILOT ? "MPN pilot (200 rows) then STOP for economics review" : `capped slice of ${requestedRows} rows`,
    priorityOrder: ["boss brands (nexen/arisun/blackhawk/fortune/falken)", "inventory-used rows", "valid-barcode rows"],
    requestedRows,
    eligibleRowsInWorkingDb: eligibleRows,
    rowsPlanned: rows,
    dispatchCommand: "scripts/tire-db-repair/bakeoff/b6_driver.sh <firstBatch> <lastBatch>  (operator-launched, subscription Codex)",
    note: queueEmpty
      ? "Working DB has 0 eligible blank-MPN rows - nothing to dispatch. Do not launch b6_driver.sh."
      : PILOT
      ? "FIRST invocation: run the 200-row pilot, then STOP and produce the economics report before any multi-night run."
      : "Post-pilot: consume one capped slice per run.",
  };
  report.stages.push(plan);
}

// --- Stage 5: Firecrawl capped fallback (PAID) -----------------------------------------------
if (!ONLY_STAGES || ONLY_STAGES.includes("firecrawl")) {
  report.stages.push({
    stage: "firecrawl",
    status: LIVE ? "plan-ready-live" : "skipped-not-live",
    note: "Capped fallback only for rows the Codex lane left blank AND above the Firecrawl threshold; below-gate rows go to ENRICHMENT_REVIEW.csv. Operator-launched, credit-capped.",
  });
}

// --- Stage 6: validator (free, gate) ---------------------------------------------------------
run("validate", process.execPath, ["scripts/tire-db-repair/05_validate.mjs", DB]);

// --- Stage 7: promote-preflight superiority gate (free, gate, MANDATORY pre-promote) ----------
// Off by default (only runs when explicitly requested via --promote or --stages promote), since it
// requires live Turso read credentials and always evaluates the PACKAGED deliverable (the promote
// decision is inherently "is the packaged repaired DB, as staged, superior to what is live today" -
// not a property of an arbitrary <WORK> copy). It NEVER writes to live Turso and NEVER runs the
// actual promote SQL; it only computes and reports the SUPERIOR / NOT-SUPERIOR verdict that gates
// the separate, explicitly owner-approved promotion step.
const promoteSelected = ONLY_STAGES ? ONLY_STAGES.includes("promote") : PROMOTE;
if (promoteSelected) {
  if (ONLY_STAGES && !ONLY_STAGES.includes("promote")) {
    report.stages.push({ stage: "promote", status: "not-selected" });
  } else if (deadlinePassed()) {
    report.stages.push({ stage: "promote", status: "skipped-deadline" });
  } else if (DRY_RUN) {
    report.stages.push({
      stage: "promote",
      status: "dry-run",
      wouldRun: `${process.execPath} scripts/tire-db-repair/09_promote_preflight.mjs`,
    });
  } else {
    const r = spawnSync(process.execPath, ["scripts/tire-db-repair/09_promote_preflight.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: Math.max(1, deadlineMs - Date.now()),
    });
    const stdoutTail = (r.stdout || "").trim().split("\n").slice(-3).join(" | ");
    const stderrTail = (r.stderr || "").trim().split("\n").slice(-3).join(" | ");
    if (r.status !== 0) {
      // Missing Turso credentials (exit 1, FATAL message) or another hard failure: block promotion,
      // never treat a failed preflight as clearance.
      const noCreds = /TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN.*not available/i.test(r.stderr || "");
      report.stages.push({
        stage: "promote",
        status: noCreds ? "blocked-no-credentials" : "blocked-preflight-failed",
        exit: r.status,
        verdict: "NOT-SUPERIOR",
        note: "PROMOTE BLOCKS: preflight could not run to completion, so superiority is unproven. Promotion stays blocked until this stage reports SUPERIOR.",
        stdoutTail,
        stderrTail,
      });
    } else {
      const reportPath = path.join(
        REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28", "PROMOTE_PREFLIGHT_REPORT.md"
      );
      let verdict = "UNKNOWN";
      if (existsSync(reportPath)) {
        const text = readFileSync(reportPath, "utf8");
        const m = text.match(/Superiority verdict:\s*\*\*(SUPERIOR|NOT-SUPERIOR)\*\*/);
        if (m) verdict = m[1];
      }
      const superior = verdict === "SUPERIOR";
      report.stages.push({
        stage: "promote",
        status: superior ? "superior-promote-allowed" : "blocked-not-superior",
        verdict,
        note: superior
          ? "Preflight verdict SUPERIOR: 0 regressions, 0 unexplained key losses, operational tables proven untouched. Promotion may proceed to the SEPARATE, explicitly owner-approved live step."
          : "PROMOTE BLOCKS: preflight verdict is not SUPERIOR (or could not be parsed). Never promote until this stage reports superior-promote-allowed.",
        reportPath: existsSync(reportPath) ? path.relative(REPO_ROOT, reportPath).replace(/\\/g, "/") : null,
        stdoutTail,
        stderrTail,
      });
    }
  }
}

finish();
