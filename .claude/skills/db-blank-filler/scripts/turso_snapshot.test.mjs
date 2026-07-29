#!/usr/bin/env node
// Smoke test for turso_snapshot.mjs (node --test). We CANNOT and MUST NOT hit live Turso in a
// test, so this proves the safe contract: with no credentials present, the script refuses cleanly
// (exit 2, honest message) and writes no output file - it never fabricates data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "turso_snapshot.mjs");
const MOCK_LOADER_URL = pathToFileURL(path.join(__dirname, "_mock_libsql_loader.mjs")).href;
const MOCK_SUCCESS_LOADER_URL = pathToFileURL(path.join(__dirname, "_mock_libsql_success_loader.mjs")).href;

test("requires an output path", () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    // strip creds + skip .env.local so the arg-check path is what fails first
    env: { ...process.env, TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", DBBF_SKIP_ENV_LOCAL: "1" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:/);
});

test("exits 2 with an honest message and writes nothing when credentials are absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turso-smoke-"));
  const out = path.join(dir, "snap.db");
  const r = spawnSync(process.execPath, [SCRIPT, out], {
    encoding: "utf8",
    env: { ...process.env, TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", DBBF_SKIP_ENV_LOCAL: "1" },
  });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /not set|not a failure/i);
  assert.equal(existsSync(out), false, "no snapshot file must be written without credentials");
  rmSync(dir, { recursive: true, force: true });
});

// Regression test for a real defect found under adversarial testing (2026-07-28): the script used
// to write directly to the final output path table-by-table, so a network drop or crash mid-copy
// left a PARTIAL but structurally-valid SQLite file at the final path - indistinguishable from a
// complete snapshot to any caller checking existsSync(outPath). The fix writes to a
// "<outPath>.partial-<pid>-<ts>.tmp" file and only renames it to outPath after every table copies
// successfully; any failure cleans up the temp file (and WAL sidecars) instead of leaving it or a
// look-alike file behind. This test mocks @libsql/client (via an ESM resolution hook) to succeed
// on the first table and throw on the second, simulating exactly that mid-transfer failure -
// never touches live Turso.
test("a mid-transfer failure leaves NO file at the output path (no partial-looking snapshot)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turso-partial-"));
  const out = path.join(dir, "snap.db");
  const r = spawnSync(
    process.execPath,
    ["--experimental-loader", MOCK_LOADER_URL, SCRIPT, out],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TURSO_DATABASE_URL: "libsql://fake-mid-transfer-test",
        TURSO_AUTH_TOKEN: "fake-token",
        DBBF_SKIP_ENV_LOCAL: "1",
      },
    }
  );
  assert.notEqual(r.status, 0, "a mid-transfer failure must be a non-zero exit");
  assert.match(r.stderr, /SIMULATED_NETWORK_DROP_MID_TRANSFER/, r.stderr);
  assert.equal(existsSync(out), false, "no file must exist at the final output path after a mid-transfer failure");
  const strayFiles = readdirSync(dir);
  assert.deepEqual(strayFiles, [], "no stray temp/partial/WAL files must be left behind either");
  rmSync(dir, { recursive: true, force: true });
});

// Happy-path proof that the write-to-temp-then-rename fix does not break a genuinely successful
// snapshot: every table copies fine, the final file lands at outPath (not the temp name), and no
// stray temp/WAL sidecar files are left once the rename completes.
test("a fully successful snapshot lands cleanly at the output path with no stray temp files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "turso-success-"));
  const out = path.join(dir, "snap.db");
  const r = spawnSync(
    process.execPath,
    ["--experimental-loader", MOCK_SUCCESS_LOADER_URL, SCRIPT, out],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TURSO_DATABASE_URL: "libsql://fake-success-test",
        TURSO_AUTH_TOKEN: "fake-token",
        DBBF_SKIP_ENV_LOCAL: "1",
      },
    }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), true, "the snapshot must exist at the requested output path");
  const filesInDir = readdirSync(dir);
  assert.deepEqual(filesInDir, ["snap.db"], "only the final snap.db must remain, no temp/partial/WAL files");
  const summary = JSON.parse(r.stdout).rowsCopied;
  assert.equal(summary.tires, 1);
  assert.equal(summary.tire_barcode_aliases, 1);
  rmSync(dir, { recursive: true, force: true });
});
