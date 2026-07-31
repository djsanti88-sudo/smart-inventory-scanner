import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { planSameUidBlankPropagation, runSameUidBlankPropagation } = await import("./12_same_uid_blank_propagation.mjs");

function fixture({ conflict = false, orphan = false, parentConflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "same-uid-propagation-"));
  const file = join(dir, "fixture.db"); const db = new Database(file);
  db.exec(`CREATE TABLE tires (barcode TEXT PRIMARY KEY, canonical_product_uid TEXT, brand TEXT, model TEXT, size TEXT, manufacturer_part_number TEXT);
    CREATE TABLE canonical_tire_products (canonical_product_id TEXT PRIMARY KEY, brand TEXT, model TEXT, size TEXT);
    CREATE TABLE remaining_blank_fill_audit (audit_id INTEGER PRIMARY KEY, action TEXT, trust_color TEXT, confidence_score INTEGER, canonical_product_uid TEXT, barcode TEXT, previous_value TEXT, new_value TEXT, candidate_count INTEGER, candidate_values TEXT, reason TEXT, created_at TEXT);
    CREATE TABLE provenance (id INTEGER PRIMARY KEY, barcode TEXT, content_hash TEXT);
    CREATE TABLE tire_part_numbers (id INTEGER PRIMARY KEY, canonical_product_uid TEXT, part_number TEXT);
    CREATE TABLE tire_product_part_number_aliases (id INTEGER PRIMARY KEY, canonical_product_uid TEXT, normalized_part_number TEXT);
    CREATE TABLE tire_barcode_aliases (barcode TEXT PRIMARY KEY, canonical_product_id TEXT NOT NULL);
    INSERT INTO canonical_tire_products VALUES ('U1','','',''), ('U2','Keep','Model','235/40R19');
    INSERT INTO tires VALUES ('donor','U1','Fortune Tires','Tormenta   R/T','35x12.50r17','PN1'), ('blank','U1','','','', 'PN1'), ('other','U2','','','', 'PN2');
    INSERT INTO tire_barcode_aliases VALUES ('donor','U1'), ('blank','U1'), ('other','U2');
    INSERT INTO provenance VALUES (1,'donor','p1'); INSERT INTO tire_part_numbers VALUES (1,'U1','PN1'); INSERT INTO tire_product_part_number_aliases VALUES (1,'U1','PN1');`);
  if (conflict) db.prepare("INSERT INTO tires VALUES ('conflict','U1','Other','','','PN1')").run();
  if (parentConflict) db.prepare("UPDATE canonical_tire_products SET model='Wrong Model' WHERE canonical_product_id='U1'").run();
  if (orphan) db.prepare("INSERT OR REPLACE INTO tire_barcode_aliases VALUES ('orphan','MISSING')").run();
  db.close(); return { dir, file };
}
function cleanup(x) { try { rmSync(x.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (error) { if (error?.code !== "EPERM") throw error; } }

test("dry-run is byte-identical and plans only unique normalized same-UID donors", () => {
  const x = fixture(); try {
    const before = readFileSync(x.file); const result = runSameUidBlankPropagation({ dbPath: x.file });
    assert.equal(result.executed, false); assert.equal(result.plan.childChanges.length, 3); assert.equal(result.plan.parentChanges.length, 3);
    assert.deepEqual(readFileSync(x.file), before);
    assert.equal(planSameUidBlankPropagation(x.file).childChanges[0].value, "Fortune Tires");
  } finally { cleanup(x); }
});

test("normalization follows the shared tire token grammar and rejects trailing junk", () => {
  const x = fixture(); try { const db=new Database(x.file); db.prepare("INSERT INTO tires VALUES ('equivalent','U1','Fortune Inc','Tormenta R/T','35X12.50R17','PN1')").run(); db.close(); assert.equal(planSameUidBlankPropagation(x.file).childChanges.length, 3); } finally { cleanup(x); }
  const x2=fixture(); try { const db=new Database(x2.file); db.prepare("UPDATE tires SET size='not a tire' WHERE barcode='donor'").run(); db.close(); assert.throws(() => planSameUidBlankPropagation(x2.file)); } finally { cleanup(x2); }
});

test("blank UIDs, wrong authoritative cardinality, and late audit failure cannot write", () => {
  const x=fixture(); try { const db=new Database(x.file); db.prepare("INSERT INTO tires VALUES ('no-uid','','Brand','Model','235/40R19','')").run(); db.close(); assert.throws(()=>planSameUidBlankPropagation(x.file),/blank canonical_product_uid/); } finally { cleanup(x); }
  const y=fixture(); try { const named=join(y.dir,"REPAIRED_TIRE_DATABASE.db"); copyFileSync(y.file,named); const before=readFileSync(named); assert.throws(()=>runSameUidBlankPropagation({dbPath:named,execute:true}),/authoritative snapshot guard/); assert.deepEqual(readFileSync(named),before); } finally { cleanup(y); }
  const z=fixture(); try { const db=new Database(z.file); db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON remaining_blank_fill_audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END"); db.close(); assert.throws(()=>runSameUidBlankPropagation({dbPath:z.file,execute:true}),/audit failure/); const verify=new Database(z.file); assert.equal(verify.prepare("SELECT brand FROM tires WHERE barcode='blank'").get().brand,""); assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM remaining_blank_fill_audit").get().n,0); verify.close(); } finally { cleanup(z); }
});

test("execute fills blanks, writes structured audit, and is idempotent", () => {
  const x = fixture(); try {
    const result = runSameUidBlankPropagation({ dbPath: x.file, execute: true }); assert.equal(result.executed, true);
    const db = new Database(x.file); assert.deepEqual(db.prepare("SELECT brand,model,size,manufacturer_part_number FROM tires WHERE barcode='blank'").get(), { brand: "Fortune Tires", model: "Tormenta   R/T", size: "35x12.50r17", manufacturer_part_number: "PN1" }); assert.equal(db.prepare("SELECT brand FROM tires WHERE barcode='donor'").get().brand,"Fortune Tires"); assert.deepEqual(db.prepare("SELECT brand,model,size FROM tires WHERE barcode='other'").get(),{brand:"",model:"",size:""});
    const audit = db.prepare("SELECT * FROM remaining_blank_fill_audit").all(); assert.equal(audit.length, 3); assert.ok(audit.every(x => x.action.includes("same_canonical_uid") && JSON.parse(x.candidate_values).donor_barcode === "donor")); db.close();
    assert.equal(runSameUidBlankPropagation({ dbPath: x.file, execute: true }).plan.childChanges.length, 0);
  } finally { cleanup(x); }
});

test("conflicting, malformed, missing-schema, and orphan inputs fail before writes", () => {
  for (const options of [{ conflict: true }, { orphan: true }, { parentConflict: true }]) { const x = fixture(options); try { assert.throws(() => runSameUidBlankPropagation({ dbPath: x.file, execute: true })); } finally { cleanup(x); } }
  const x = fixture(); try { const db = new Database(x.file); db.prepare("UPDATE tires SET size='not a tire' WHERE barcode='donor'").run(); db.close(); assert.throws(() => planSameUidBlankPropagation(x.file)); } finally { cleanup(x); }
  const y = fixture(); try { const db = new Database(y.file); db.exec("DROP TABLE provenance"); db.close(); assert.throws(() => planSameUidBlankPropagation(y.file), /missing required table/); } finally { cleanup(y); }
});
