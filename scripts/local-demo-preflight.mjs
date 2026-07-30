import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { isTrustedLocalDemoTireRow } from "../src/server/tire-knowledge/localDemoTrust.mjs";

const DEFAULT_DATABASE_PATH = resolve("src/server/knowledge.generated.db");
const MINIMUM_TIRE_ROWS = 3000;

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function assertLocalDemoDatabase(databasePath = DEFAULT_DATABASE_PATH) {
  const resolvedPath = resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`A local tire database is required at ${resolvedPath}. Run node scripts/provision-worktree.mjs.`);
  }

  let database;
  try {
    database = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    const integrityRows = database.pragma("quick_check");
    if (integrityRows.length !== 1 || integrityRows[0].quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${JSON.stringify(integrityRows)}`);
    }
    const tireCount = Number(database.prepare("SELECT COUNT(*) AS count FROM tires").get().count);
    if (tireCount < MINIMUM_TIRE_ROWS) {
      throw new Error(`Local tire database requires at least ${MINIMUM_TIRE_ROWS} tire rows; found ${tireCount}.`);
    }
    const rows = database.prepare(`
      SELECT barcode, canonical_product_uid, brand, model, model_display, size,
             current_status, usable_for, source_count, barcode_type
      FROM tires
    `).all();
    const eligibleTireCount = rows.reduce(
      (count, row) => count + (isTrustedLocalDemoTireRow(row) ? 1 : 0),
      0,
    );
    if (eligibleTireCount < MINIMUM_TIRE_ROWS) {
      throw new Error(
        `Local tire database requires at least ${MINIMUM_TIRE_ROWS} eligible tire rows; found ${eligibleTireCount}.`,
      );
    }
    return {
      databasePath: resolvedPath,
      databaseSha256: sha256File(resolvedPath),
      tireCount,
      eligibleTireCount,
    };
  } catch (error) {
    if (error instanceof Error && /at least \d+|quick_check/i.test(error.message)) throw error;
    throw new Error(`SQLite quick_check could not validate the local tire database: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}
