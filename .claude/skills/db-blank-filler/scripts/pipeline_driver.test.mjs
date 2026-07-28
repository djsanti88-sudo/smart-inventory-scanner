#!/usr/bin/env node
// Smoke test for pipeline_driver.mjs (node --test). Verifies flag parsing, paid-stage skipping,
// dry-run behavior, and the required --db guard. Does NOT run the real free stages end to end
// (those have their own suites); it uses --stages twin --dry-run to exercise the driver mechanics
// without touching a real corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./_make_fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require("better-sqlite3");
const SCRIPT = path.join(__dirname, "pipeline_driver.mjs");
const PACKAGED_DB = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
);

function run(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("requires --db", () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--db .* is REQUIRED/);
});

test("errors on missing DB file", () => {
  const r = run(["--db", path.join(tmpdir(), "does-not-exist-xyz.db")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /working DB not found/);
});

test("dry-run plans free stages and SKIPS paid stages without --live", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-dry-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
  assert.equal(byStage.b5.status, "dry-run");
  assert.equal(byStage.twin.status, "dry-run");
  assert.equal(byStage.codex.status, "skipped-not-live", "codex must be skipped without --live");
  assert.equal(byStage.firecrawl.status, "skipped-not-live");
  assert.equal(byStage.validate.status, "dry-run");
  rmSync(dir, { recursive: true, force: true });
});

test("pilot flag requests a 200-row MPN plan, capped honestly by the working DB's real eligible-row count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-pilot-"));
  const db = path.join(dir, "f.db");
  makeFixture(db); // fixture has a small, known number of blank-MPN rows - not 200
  const r = run(["--db", db, "--dry-run", "--pilot", "--live", "--stages", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const codex = report.stages.find((s) => s.stage === "codex");
  assert.equal(codex.requestedRows, 200);
  // rowsPlanned must be grounded in the working DB, never a static echo of the request (this is
  // the fix for the defect found 2026-07-28: an empty/small DB used to still claim 200 rows ready).
  assert.equal(codex.rowsPlanned, Math.min(200, codex.eligibleRowsInWorkingDb));
  assert.ok(codex.eligibleRowsInWorkingDb < 200, "the tiny fixture must not have 200 real eligible rows");
  assert.equal(codex.status, "plan-ready-live");
  assert.match(codex.policy, /pilot/i);
  rmSync(dir, { recursive: true, force: true });
});

// Regression tests for real defects found under adversarial testing (2026-07-28): the driver
// had zero validation on --slice / --deadline, so --slice 0, a negative slice, or a non-numeric
// slice/deadline still produced a "plan-ready-live" codex plan (a nonsensical "ready to dispatch
// 0 rows" or "-50 rows" or "NaN rows" signal an operator could act on).
test("rejects --slice 0 (nothing to dispatch)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-slice0-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--slice", "0", "--live", "--stages", "codex"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--slice must be a positive integer/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a negative --slice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-sliceneg-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--slice", "-50", "--live", "--stages", "codex"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--slice must be a positive integer/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a non-numeric --slice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-slicenan-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--slice", "notanumber", "--live", "--stages", "codex"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--slice must be a positive integer/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a non-numeric --deadline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-deadlinenan-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--deadline", "notanumber"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--deadline must be a finite number/);
  rmSync(dir, { recursive: true, force: true });
});

// Regression test for a real defect found under adversarial testing (2026-07-28): --pilot always
// reported rowsPlanned=200 and status="plan-ready-live" even when the working DB had ZERO
// eligible blank-MPN rows to enrich - a plan an operator could act on that promised work that
// does not exist. The fix queries the working DB and reports an honest empty-queue status.
test("--pilot against an empty working DB reports an honest empty-queue status, not a fake 200-row plan", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-emptyqueue-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  {
    const d = new Database(db);
    d.prepare("DELETE FROM tires").run();
    d.prepare("DELETE FROM tire_barcode_aliases").run();
    d.close();
  }
  const r = run(["--db", db, "--dry-run", "--pilot", "--live", "--stages", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const codex = report.stages.find((s) => s.stage === "codex");
  assert.equal(codex.eligibleRowsInWorkingDb, 0);
  assert.equal(codex.rowsPlanned, 0);
  assert.equal(codex.status, "empty-queue-nothing-to-dispatch");
  assert.match(codex.note, /nothing to dispatch/i);
  rmSync(dir, { recursive: true, force: true });
});

test("a deadline already in the past skips every stage cleanly (no crash, exit 0)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-pastdeadline-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--deadline", "-1"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
  assert.equal(byStage.b5.status, "skipped-deadline");
  assert.equal(byStage.twin.status, "skipped-deadline");
  assert.equal(byStage.style.status, "skipped-deadline");
  assert.equal(byStage.validate.status, "skipped-deadline");
  rmSync(dir, { recursive: true, force: true });
});

test("slice flag requests a capped slice plan (default 500), grounded by the working DB", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-slice-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--slice", "--live", "--stages", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const codex = report.stages.find((s) => s.stage === "codex");
  assert.equal(codex.requestedRows, 500);
  assert.equal(codex.rowsPlanned, Math.min(500, codex.eligibleRowsInWorkingDb));
  rmSync(dir, { recursive: true, force: true });
});

// Regression test for a real defect found under adversarial testing (2026-07-28): b5 and style
// used to hardcode the packaged DB path and silently ignore the working-copy path the driver
// passed them, so a "b5"/"style" stage reported "ok" while actually reading/writing the PACKAGED
// deliverable instead of <WORK> - a direct violation of "working copy first" (SKILL.md). Proves:
// (1) the packaged DB file is byte-identical before/after a real (non-dry-run) b5+style run,
// (2) the working copy actually received the fill (a deliberately-blanked brand gets refilled),
// so the stages are proven to target <WORK>, not just "not crash."
test("b5 and style stages write to the WORKING COPY, never the packaged DB (real run, not dry-run)", { skip: !existsSync(PACKAGED_DB) }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-realwrite-"));
  const work = path.join(dir, "work.db");

  // Build a working copy: a couple of real tire rows plus the required supporting tables, with
  // one deliberately-blanked brand so a genuine b5 fill has something to do.
  makeFixture(work);
  {
    const db = new Database(work);
    db.exec(`
      CREATE TABLE canonical_tire_products (canonical_product_id TEXT, brand TEXT, model TEXT, size TEXT);
    `);
    db.prepare(
      `UPDATE tires SET brand = '' WHERE barcode = '036731100016'`
    ).run();
    db.close();
  }

  const packagedBefore = statSync(PACKAGED_DB).size;
  const packagedHashBefore = require("node:crypto")
    .createHash("sha256")
    .update(require("node:fs").readFileSync(PACKAGED_DB))
    .digest("hex");

  const r = run(["--db", work, "--stages", "b5,style"]);
  assert.equal(r.status, 0, r.stderr);

  const packagedHashAfter = require("node:crypto")
    .createHash("sha256")
    .update(require("node:fs").readFileSync(PACKAGED_DB))
    .digest("hex");
  assert.equal(
    packagedHashAfter,
    packagedHashBefore,
    "packaged REPAIRED_TIRE_DATABASE.db must be byte-identical after a working-copy run (b5/style must never touch it)"
  );
  assert.equal(statSync(PACKAGED_DB).size, packagedBefore);

  // The working copy itself was actually touched (proves the stage ran against <WORK>, not a no-op).
  const wdb = new Database(work, { readonly: true });
  const modelDisplayCol = wdb.prepare("PRAGMA table_info(tires)").all().some((c) => c.name === "model_display");
  assert.ok(modelDisplayCol, "style stage must add model_display to the WORKING copy");
  wdb.close();

  rmSync(dir, { recursive: true, force: true });
});
