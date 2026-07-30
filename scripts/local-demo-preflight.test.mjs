import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertLocalDemoDatabase } from "./local-demo-preflight.mjs";

function upc(index) {
  const payload = String(index).padStart(11, "0");
  let sum = 0;
  for (let offset = 0; offset < payload.length; offset += 1) {
    sum += Number(payload[payload.length - 1 - offset]) * (offset % 2 === 0 ? 3 : 1);
  }
  return payload + ((10 - (sum % 10)) % 10);
}

function makeDatabase(path, count) {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE tires (
      barcode TEXT, canonical_product_uid TEXT, brand TEXT, model TEXT,
      model_display TEXT, size TEXT, current_status TEXT, usable_for TEXT,
      source_count INTEGER, barcode_type TEXT
    )
  `);
  const insert = database.prepare("INSERT INTO tires VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(upc(index), `tire-${index}`, "Brand", "Model", "Model", "225/65R17",
        "active_retail", "auto_count_candidate", 2, "upc");
    }
  })();
  database.close();
}

test("preflight validates integrity, total rows, eligible rows, and hash without mutating SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-local-db-"));
  try {
    const valid = join(directory, "valid.db");
    const tooSmall = join(directory, "small.db");
    const corrupt = join(directory, "corrupt.db");
    makeDatabase(valid, 3000);
    makeDatabase(tooSmall, 2999);
    writeFileSync(corrupt, "not sqlite");

    const result = assertLocalDemoDatabase(valid);
    assert.equal(result.tireCount, 3000);
    assert.equal(result.eligibleTireCount, 3000);
    assert.match(result.databaseSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => assertLocalDemoDatabase(join(directory, "missing.db")), /local tire database is required/i);
    assert.throws(() => assertLocalDemoDatabase(corrupt), /quick_check/i);
    assert.throws(() => assertLocalDemoDatabase(tooSmall), /at least 3000/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
