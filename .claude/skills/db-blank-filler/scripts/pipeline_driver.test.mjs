#!/usr/bin/env node
// Smoke test for pipeline_driver.mjs (node --test). Verifies flag parsing, paid-stage skipping,
// dry-run behavior, and the required --db guard. Does NOT run the real free stages end to end
// (those have their own suites); it uses --stages twin --dry-run to exercise the driver mechanics
// without touching a real corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./_make_fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(__dirname, "pipeline_driver.mjs");

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

test("pilot flag produces a 200-row MPN plan; --live marks codex plan-ready", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-pilot-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--pilot", "--live", "--stages", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const codex = report.stages.find((s) => s.stage === "codex");
  assert.equal(codex.rowsPlanned, 200);
  assert.equal(codex.status, "plan-ready-live");
  assert.match(codex.policy, /pilot/i);
  rmSync(dir, { recursive: true, force: true });
});

test("slice flag produces a capped slice plan (default 500)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pipe-slice-"));
  const db = path.join(dir, "f.db");
  makeFixture(db);
  const r = run(["--db", db, "--dry-run", "--slice", "--live", "--stages", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const codex = report.stages.find((s) => s.stage === "codex");
  assert.equal(codex.rowsPlanned, 500);
  rmSync(dir, { recursive: true, force: true });
});
