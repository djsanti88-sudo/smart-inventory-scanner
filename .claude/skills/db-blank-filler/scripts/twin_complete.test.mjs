#!/usr/bin/env node
// Smoke test for twin_complete.mjs (node --test). Uses a tiny fixture DB in the OS temp dir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./_make_fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require("better-sqlite3");
const SCRIPT = path.join(__dirname, "twin_complete.mjs");

let dir, dbPath;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "twin-smoke-"));
  dbPath = path.join(dir, "fixture.db");
  makeFixture(dbPath);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, dbPath, ...args], { encoding: "utf8" });
}

test("adds twins in both directions and sets primary-form designation", () => {
  const r = runScript([]);
  assert.equal(r.status, 0, r.stderr);
  const db = new Database(dbPath, { readonly: true });

  // Direction A: UPC-A twin of the leading-zero EAN-13 now exists.
  assert.ok(db.prepare("SELECT 1 FROM tire_barcode_aliases WHERE barcode='012345678905'").get());
  // Direction B: EAN-13 twin of the 12-digit UPC-A now exists.
  assert.ok(db.prepare("SELECT 1 FROM tire_barcode_aliases WHERE barcode='0036731100016'").get());

  // is_primary_form column exists and 12-digit UPC-A is primary, EAN twin is not.
  const cols = db.prepare("PRAGMA table_info(tire_barcode_aliases)").all().map((c) => c.name);
  assert.ok(cols.includes("is_primary_form"), "is_primary_form column added");
  assert.equal(db.prepare("SELECT is_primary_form p FROM tire_barcode_aliases WHERE barcode='012345678905'").get().p, 1);
  assert.equal(db.prepare("SELECT is_primary_form p FROM tire_barcode_aliases WHERE barcode='036731100016'").get().p, 1);
  assert.equal(db.prepare("SELECT is_primary_form p FROM tire_barcode_aliases WHERE barcode='0036731100016'").get().p, 0);

  // Invariant: every alias has a matching tires row (validator gate parity).
  const orphanAlias = db.prepare(
    "SELECT count(*) c FROM tire_barcode_aliases a WHERE NOT EXISTS (SELECT 1 FROM tires t WHERE t.barcode=a.barcode)"
  ).get().c;
  assert.equal(orphanAlias, 0, "no alias without a tire row");
  const orphanTire = db.prepare(
    "SELECT count(*) c FROM tires t WHERE NOT EXISTS (SELECT 1 FROM tire_barcode_aliases a WHERE a.barcode=t.barcode)"
  ).get().c;
  assert.equal(orphanTire, 0, "no tire without an alias row");

  // Twin tire row copied the source product identity, and barcode stored as TEXT.
  const twin = db.prepare("SELECT typeof(barcode) tb, brand FROM tires WHERE barcode='012345678905'").get();
  assert.equal(twin.tb, "text");
  assert.equal(twin.brand, "Nexen");
  db.close();
});

test("is idempotent: a second run adds nothing", () => {
  const r = runScript([]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(out.addedUpcTwin, 0);
  assert.equal(out.addedEanTwin, 0);
  const db = new Database(dbPath, { readonly: true });
  const remA = db.prepare(
    "SELECT count(*) c FROM tire_barcode_aliases a WHERE length(a.barcode)=13 AND substr(a.barcode,1,1)='0' AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode=substr(a.barcode,2))"
  ).get().c;
  const remB = db.prepare(
    "SELECT count(*) c FROM tire_barcode_aliases a WHERE length(a.barcode)=12 AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode='0'||a.barcode)"
  ).get().c;
  assert.equal(remA, 0);
  assert.equal(remB, 0);
  db.close();
});

// Regression test for a real defect found under adversarial testing (2026-07-28): the candidate
// queries used only length(barcode)=12/13 with no digit check, so an alphanumeric string of the
// same character length (a corrupted or vendor-style value, not a real GTIN) was silently treated
// as a UPC-A/EAN-13 twin candidate and string-concatenated into a garbage alias
// (e.g. "0AB345678905" -> fabricated twin "00AB345678905"). Barcodes are TEXT always but twin
// math must only ever apply to genuine all-digit GTIN/UPC/EAN forms.
test("ignores same-length alphanumeric barcodes (never fabricates a non-numeric twin)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "twin-nondigit-"));
  const db2 = path.join(dir, "f.db");
  makeFixture(db2);
  {
    const d = new Database(db2);
    // 12-char alphanumeric value - same length as a UPC-A but not a real barcode.
    d.prepare(
      `INSERT INTO tires (barcode, canonical_product_uid, brand, model, size, barcode_type, source_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run("0AB345678905".slice(0, 12), "UID-JUNK", "BrandJunk", "ModelJunk", "1", "unknown");
    d.prepare(
      `INSERT INTO tire_barcode_aliases (barcode, barcode_type, canonical_product_id, source_table, alias_confidence)
       VALUES (?, ?, ?, ?, ?)`
    ).run("0AB345678905".slice(0, 12), "unknown", "UID-JUNK", "source_junk", 100);
    d.close();
  }
  const rr = spawnSync(process.execPath, [SCRIPT, db2], { encoding: "utf8" });
  assert.equal(rr.status, 0, rr.stderr);
  const d = new Database(db2, { readonly: true });
  const junkTwin = d.prepare("SELECT 1 FROM tire_barcode_aliases WHERE barcode = '0' || ?").get("0AB345678905".slice(0, 12));
  assert.equal(junkTwin, undefined, "must never fabricate a twin for a non-numeric same-length barcode");
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

// Regression test: an invalid working copy (missing required tables) must fail with a clear,
// actionable message and a non-zero exit - not a raw unhandled SqliteError stack trace.
test("fails cleanly with an honest message when required tables are missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "twin-badschema-"));
  const db2 = path.join(dir, "bad.db");
  const d = new Database(db2);
  d.exec("CREATE TABLE tires (barcode TEXT, canonical_product_uid TEXT, brand TEXT)");
  d.close();
  const r = spawnSync(process.execPath, [SCRIPT, db2], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing required table/i);
  assert.doesNotMatch(r.stderr, /SqliteError/, "must not leak a raw SQLite stack trace");
  rmSync(dir, { recursive: true, force: true });
});

test("--dry-run writes nothing", () => {
  const dir2 = mkdtempSync(path.join(tmpdir(), "twin-dry-"));
  const db2 = path.join(dir2, "f.db");
  makeFixture(db2);
  const d1 = new Database(db2, { readonly: true });
  const before = d1.prepare("SELECT count(*) c FROM tire_barcode_aliases").get().c;
  d1.close();
  const r = spawnSync(process.execPath, [SCRIPT, db2, "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const d2 = new Database(db2, { readonly: true });
  const after = d2.prepare("SELECT count(*) c FROM tire_barcode_aliases").get().c;
  d2.close();
  assert.equal(before, after, "dry-run must not change alias count");
  rmSync(dir2, { recursive: true, force: true });
});
