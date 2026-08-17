// Regression guard for DT2-1 (2026-08-13, docs/superpowers/reports/2026-08-13-loop2-data.md):
// build-knowledge-db.mjs swaps its two paired outputs (knowledge.generated.db and
// knowledge.generated.db.gz) into place with two INDEPENDENT renameSync calls. A crash between them
// (OOM during gzip, killed CI job, power loss) leaves the .db and .db.gz representing DIFFERENT
// corpus generations, with nothing detecting the mismatch -- src/server/knowledgeDb.ts prefers the
// uncompressed .db locally while Vercel production ships only the .gz, so local dev and production
// would silently serve different data indefinitely.
//
// Fix: the generator now also writes a small, committed manifest
// (knowledge.generated.manifest.json) recording a sha256 fingerprint of the finalized DB content
// (db_sha256) and of the gzip bytes (gz_sha256), and renames it into place as the LAST of three
// back-to-back renames (db, then gz, then manifest -- nothing else runs between any of them). A
// consumer (src/server/knowledgeDb.ts, proven in its own test file) can then verify whichever file
// it actually opens against the manifest's recorded db_sha256 and fail loudly on a mismatch instead
// of silently trusting whichever generation happens to be on disk.
//
// This test proves the generator SIDE of the contract: the manifest is written, its hash actually
// matches what's on disk, and the three renames all still happen together (no manifest without a
// matching db/gz, and vice versa).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(process.cwd(), "scripts", "build-knowledge-db.mjs");

let root;

function tinyTireJson() {
  return JSON.stringify({
    schema_version: "1.0.0",
    generated_at: "2026-07-01T00:00:00.000Z",
    barcodeIndex: {
      "1000000000001": { canonical_product_uid: "uid-1", brand: "Acme", model: "X1", size: "205/55R16" },
    },
    partNumberIndex: {},
    identityIndex: {},
  });
}

function tinyRetailJson() {
  return JSON.stringify({
    generated_at: "2026-07-01T00:00:00.000Z",
    index: { "0100000000001": ["Snack", "Acme", "Snacks"] },
  });
}

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "kdb-pairconsistency-"));
  mkdirSync(join(dir, "src", "server", "tire-knowledge"), { recursive: true });
  mkdirSync(join(dir, "src", "server", "retail-knowledge"), { recursive: true });
  mkdirSync(join(dir, "src", "server"), { recursive: true });
  writeFileSync(join(dir, "src", "server", "tire-knowledge", "tireKnowledge.generated.json"), tinyTireJson());
  writeFileSync(join(dir, "src", "server", "retail-knowledge", "retailKnowledge.generated.json"), tinyRetailJson());
  return dir;
}

function runGenerator(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

beforeEach(() => { root = null; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("build-knowledge-db paired-output generation manifest (DT2-1)", () => {
  it("writes a manifest naming a sha256 fingerprint that actually matches the finalized .db and .gz bytes", () => {
    root = makeRoot();
    const result = runGenerator(root);
    expect(result.code).toBe(0);

    const dbPath = join(root, "src", "server", "knowledge.generated.db");
    const gzPath = dbPath + ".gz";
    const manifestPath = join(root, "src", "server", "knowledge.generated.manifest.json");

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(typeof manifest.db_sha256).toBe("string");
    expect(manifest.db_sha256.length).toBe(64);
    expect(typeof manifest.gz_sha256).toBe("string");

    expect(manifest.db_sha256).toBe(sha256(readFileSync(dbPath)));
    expect(manifest.gz_sha256).toBe(sha256(readFileSync(gzPath)));
  });

  it("never leaves a manifest describing a DIFFERENT generation than the db/gz that ship with it, across repeated runs", () => {
    root = makeRoot();
    expect(runGenerator(root).code).toBe(0);

    const dbPath = join(root, "src", "server", "knowledge.generated.db");
    const gzPath = dbPath + ".gz";
    const manifestPath = join(root, "src", "server", "knowledge.generated.manifest.json");

    // Force a second, deliberately DIFFERENT generation (bigger tire index) and rebuild with --force
    // (a legitimate shrink/replace is not the scenario under test here, just a distinct generation).
    writeFileSync(
      join(root, "src", "server", "tire-knowledge", "tireKnowledge.generated.json"),
      JSON.stringify({
        schema_version: "1.0.0",
        generated_at: "2026-07-02T00:00:00.000Z",
        barcodeIndex: {
          "1000000000001": { canonical_product_uid: "uid-1", brand: "Acme", model: "X1", size: "205/55R16" },
          "1000000000002": { canonical_product_uid: "uid-2", brand: "Acme", model: "X2", size: "215/60R16" },
        },
        partNumberIndex: {},
        identityIndex: {},
      }),
    );
    expect(runGenerator(root, ["--force"]).code).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.db_sha256).toBe(sha256(readFileSync(dbPath)));
    expect(manifest.gz_sha256).toBe(sha256(readFileSync(gzPath)));
  });
});
