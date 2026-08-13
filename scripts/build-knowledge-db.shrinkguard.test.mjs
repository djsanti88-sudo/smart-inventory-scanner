// Regression guard for DT-1 (2026-08-13, docs/superpowers/reports/2026-08-13-loop1-data.md):
// build-knowledge-db.mjs deleted the existing runtime knowledge.generated.db via unlinkSync
// BEFORE validating the freshly built replacement had a sane row count. A truncated or stale
// tireKnowledge.generated.json / retailKnowledge.generated.json input would silently destroy the
// runtime DB every retail/tire decode rung depends on, with no sanity check -- the exact bug
// class already fixed in the sibling scripts/build-tire-knowledge.mjs (F1, 2026-08-12,
// MIN_RETAINED_FRACTION guard).
//
// These tests run the real generator in a throwaway repo root and assert it refuses to shrink an
// existing DB (leaving it byte-for-byte in place, never unlinked before validation), and that
// --force still allows a deliberate rebuild.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

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
    index: { "0100000000001": ["Truncated Snack", "Acme", "Snacks"] },
  });
}

/** Build a throwaway repo root holding a LARGE existing runtime DB and tiny JSON inputs. */
function makeRoot({ priorRows }) {
  const dir = mkdtempSync(join(tmpdir(), "kdb-shrinkguard-"));
  const tireOutDir = join(dir, "src", "server", "tire-knowledge");
  const retailOutDir = join(dir, "src", "server", "retail-knowledge");
  const dbOutDir = join(dir, "src", "server");
  mkdirSync(tireOutDir, { recursive: true });
  mkdirSync(retailOutDir, { recursive: true });
  mkdirSync(dbOutDir, { recursive: true });

  writeFileSync(join(tireOutDir, "tireKnowledge.generated.json"), tinyTireJson());
  writeFileSync(join(retailOutDir, "retailKnowledge.generated.json"), tinyRetailJson());

  if (priorRows !== null) {
    const dbPath = join(dbOutDir, "knowledge.generated.db");
    const db = new Database(dbPath);
    // Minimal schema: only the table name + row count matter to the sanity guard, which
    // counts rows -- it does not require the full production column set.
    db.exec("CREATE TABLE tires (barcode TEXT NOT NULL)");
    db.exec("CREATE TABLE retail (barcode TEXT NOT NULL)");
    const insertTire = db.prepare("INSERT INTO tires (barcode) VALUES (?)");
    const insertRetail = db.prepare("INSERT INTO retail (barcode) VALUES (?)");
    const tx = db.transaction((n) => {
      for (let i = 0; i < n; i++) {
        insertTire.run(String(300000000000 + i));
        insertRetail.run(String(400000000000 + i));
      }
    });
    tx(priorRows);
    db.close();
    // A stand-in for the real .gz sibling shipped to the Vercel bundle, so the test can
    // also prove the guard never touches it before validation.
    writeFileSync(dbPath + ".gz", Buffer.from("stand-in gzip bytes"));
  }
  return dir;
}

function runGenerator(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function rowCounts(dir) {
  const dbPath = join(dir, "src", "server", "knowledge.generated.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const tires = db.prepare("SELECT COUNT(*) AS c FROM tires").get().c;
    const retail = db.prepare("SELECT COUNT(*) AS c FROM retail").get().c;
    return { tires, retail };
  } finally {
    db.close();
  }
}

beforeEach(() => { root = null; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("build-knowledge-db output-sanity guard (DT-1)", () => {
  it("refuses to overwrite a large existing DB with a tiny-JSON rebuild, and never unlinks it first", () => {
    root = makeRoot({ priorRows: 5000 });
    const dbPath = join(root, "src", "server", "knowledge.generated.db");
    const gzPath = dbPath + ".gz";
    const gzBefore = readFileSync(gzPath);

    const result = runGenerator(root);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/shrink|smaller|force/i);
    // The critical assertion: the existing runtime DB survived untouched (never unlinked
    // before the replacement was known sane), and its .gz sibling too.
    expect(existsSync(dbPath)).toBe(true);
    expect(rowCounts(root)).toEqual({ tires: 5000, retail: 5000 });
    expect(readFileSync(gzPath)).toEqual(gzBefore);
  });

  it("allows a deliberate shrink when --force is passed", () => {
    root = makeRoot({ priorRows: 5000 });

    const result = runGenerator(root, ["--force"]);

    expect(result.code).toBe(0);
    const counts = rowCounts(root);
    expect(counts.tires).toBeLessThan(5000);
    expect(counts.retail).toBeLessThan(5000);
  });

  it("still generates normally when no prior DB exists (bootstrap case)", () => {
    root = makeRoot({ priorRows: null });

    const result = runGenerator(root);

    expect(result.code).toBe(0);
    const counts = rowCounts(root);
    expect(counts.tires).toBeGreaterThan(0);
    expect(counts.retail).toBeGreaterThan(0);
  });
});
