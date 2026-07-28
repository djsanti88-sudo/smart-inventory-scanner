#!/usr/bin/env node
// db-blank-filler pipeline driver.
//
// Runs the enrichment/cleaning stages IN ORDER against a specified working DB, honoring a hard
// deadline and the pilot/slice policy. It INVOKES the proven tonight scripts by path (it never
// re-implements their gate/enrichment/validator logic) and it NEVER runs a paid stage unless
// --live is passed. It NEVER writes to live Turso, never runs git, never deploys.
//
// Stages (deterministic-first, paid last), matching the owner-approved cascade:
//   1. b5   deterministic backfill (free)      scripts/tire-db-repair/bakeoff/b5_deterministic_backfill.mjs
//   2. twin twin completion both directions    .claude/skills/db-blank-filler/scripts/twin_complete.mjs
//   3. style model styling pass (free)         scripts/tire-db-repair/06_model_styling.mjs
//   4. codex GPT-5.5 batches (PAID, --live)    scripts/tire-db-repair/bakeoff/b6_driver.sh  [gated]
//   5. firecrawl capped fallback (PAID, --live)                                             [gated]
//   6. validate (free, gate)                   scripts/tire-db-repair/05_validate.mjs
//
// Paid stages 4-5 are the ONLY web/enrichment lanes. Without --live they are SKIPPED and reported
// as skipped (the free stages + validator still run - a safe dry pipeline). The MPN backlog policy
// (200-row pilot, then capped 500-row slices) is surfaced here via --pilot / --slice but the
// actual paid dispatch stays owner-gated (see SKILL.md): the driver stops before paid dispatch and
// prints the batch plan unless --live AND (--pilot|--slice) are BOTH explicitly present.
//
// Flags:
//   --db <path>          working DB (REQUIRED - never defaults to the packaged deliverable)
//   --deadline <hours>   hard stop; default 4. Stages check the clock and stop cleanly.
//   --pilot              MPN backlog: plan a 200-row pilot only, then STOP with an economics note.
//   --slice <n>          MPN backlog: plan a capped n-row slice (default 500) - post-pilot runs.
//   --live               permit PAID stages (codex/firecrawl). Absent = free stages only.
//   --stages a,b,c       run only the named stages (default: all).
//   --dry-run            plan + free-stage no-op preview; write nothing.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
const ONLY_STAGES = hasFlag("--stages") ? argVal("--stages", "").split(",").map((s) => s.trim()) : null;

if (!DB) {
  console.error("pipeline_driver: --db <path> is REQUIRED (never defaults to the packaged deliverable).");
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`pipeline_driver: working DB not found at ${DB}`);
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

// --- Stage 2: twin completion both directions (free, gated by its own idempotency check) -----
run("twin", process.execPath, [".claude/skills/db-blank-filler/scripts/twin_complete.mjs", DB, ...(DRY_RUN ? ["--dry-run"] : [])]);

// --- Stage 3: model styling (free) -----------------------------------------------------------
run("style", process.execPath, ["scripts/tire-db-repair/06_model_styling.mjs", DB]);

// --- Stage 4: Codex GPT-5.5 batches (PAID) ---------------------------------------------------
// The MPN backlog policy is enforced HERE as a plan, not an auto-dispatch. Even with --live, the
// driver only prints the batch plan; the actual b6_driver.sh dispatch is launched by the operator
// after reading the plan and (for the first ever run) the pilot economics report. This keeps the
// owner-approval stop intact.
if (!ONLY_STAGES || ONLY_STAGES.includes("codex")) {
  const rows = PILOT ? 200 : (SLICE ?? 500);
  const plan = {
    stage: "codex",
    status: LIVE ? "plan-ready-live" : "skipped-not-live",
    policy: PILOT ? "MPN pilot (200 rows) then STOP for economics review" : `capped slice of ${rows} rows`,
    priorityOrder: ["boss brands (nexen/arisun/blackhawk/fortune/falken)", "inventory-used rows", "valid-barcode rows"],
    rowsPlanned: rows,
    dispatchCommand: "scripts/tire-db-repair/bakeoff/b6_driver.sh <firstBatch> <lastBatch>  (operator-launched, subscription Codex)",
    note: PILOT
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

finish();
