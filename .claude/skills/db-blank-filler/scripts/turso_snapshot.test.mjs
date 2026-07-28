#!/usr/bin/env node
// Smoke test for turso_snapshot.mjs (node --test). We CANNOT and MUST NOT hit live Turso in a
// test, so this proves the safe contract: with no credentials present, the script refuses cleanly
// (exit 2, honest message) and writes no output file - it never fabricates data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "turso_snapshot.mjs");

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
