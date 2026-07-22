#!/usr/bin/env node
// Task 20 (owner-ratified 2026-07-15, pay-once durability): a decode_cache wipe (Turso or the local
// file store) would force re-paying every un-approved paid decode all over again. This CLI is the
// faithful dump/restore of that cache so a wipe costs a `--restore`, never a re-pay.
//
//   node scripts/decode-cache-backup.mjs --dump              writes backups/decode-cache-<date>.jsonl
//   node scripts/decode-cache-backup.mjs --restore <file>     upserts rows back, EXISTING ROWS ALWAYS WIN
//
// Backend selection: Turso (decode_cache table) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set,
// else the local file store (DECODE_CACHE_FILE or .decode-cache.json, same as decodeCacheStore.ts).
//
// Restore semantics (owner rule): a restore can never overwrite a newer/existing decode.
//   - Turso: `INSERT OR IGNORE` - if the code's row already exists, the backup row is dropped.
//   - File store: only keys ABSENT from the current store are added; existing keys are left untouched.
//
// Pure Node + the JSONL format module (src/server/decodeCacheBackup.ts, imported via a small on-the-fly
// require of the compiled logic is avoided - the format is duplicated here in plain JS on purpose,
// matching decode-outcomes-report.mjs's convention of zero-build-step scripts). Only imports
// @libsql/client when Turso env vars are present.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// JSONL format (mirrors src/server/decodeCacheBackup.ts's exportDecodeCache/parseBackup contract -
// duplicated here in plain JS so this script has no build step / TS import, per decode-outcomes-
// report.mjs's existing convention).
// ---------------------------------------------------------------------------

function exportDecodeCache(rows) {
  if (!rows || rows.length === 0) return "";
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function isValidPersistedDecode(v) {
  if (!v || typeof v !== "object") return false;
  return (
    typeof v.code === "string" &&
    v.code.length > 0 &&
    (v.kind === "result" || v.kind === "no_result_receipt") &&
    typeof v.payload === "string" &&
    typeof v.tier === "string" &&
    typeof v.createdAt === "number"
  );
}

function parseBackup(jsonl) {
  const rows = [];
  if (!jsonl) return rows;
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // corrupt line - skip, never throw
    }
    if (!isValidPersistedDecode(parsed)) continue; // wrong shape - skip, never throw
    rows.push({ code: parsed.code, kind: parsed.kind, payload: parsed.payload, tier: parsed.tier, createdAt: parsed.createdAt });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Backend: Turso
// ---------------------------------------------------------------------------

const DDL = "CREATE TABLE IF NOT EXISTS decode_cache (code TEXT PRIMARY KEY, kind TEXT, payload TEXT, tier TEXT, created_at INTEGER)";

async function getTursoClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) return null;
  const { createClient } = await import("@libsql/client");
  return createClient({ url, authToken: token });
}

async function dumpFromTurso(db) {
  await db.execute({ sql: DDL, args: [] });
  const result = await db.execute({ sql: "SELECT code, kind, payload, tier, created_at FROM decode_cache", args: [] });
  return result.rows.map((row) => ({
    code: String(row.code),
    kind: row.kind === "no_result_receipt" ? "no_result_receipt" : "result",
    payload: String(row.payload ?? ""),
    tier: String(row.tier ?? ""),
    createdAt: Number(row.created_at) || 0,
  }));
}

/** INSERT OR IGNORE: existing rows always win over a restore. Returns count actually inserted. */
async function restoreToTurso(db, rows) {
  await db.execute({ sql: DDL, args: [] });
  let inserted = 0;
  for (const row of rows) {
    const before = await db.execute({ sql: "SELECT 1 FROM decode_cache WHERE code = ?", args: [row.code] });
    if (before.rows.length > 0) continue; // existing row wins, never overwritten
    await db.execute({
      sql: "INSERT OR IGNORE INTO decode_cache (code, kind, payload, tier, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [row.code, row.kind, row.payload, row.tier, row.createdAt],
    });
    inserted += 1;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Backend: local file store (mirrors src/server/decodeCacheStore.ts's file adapter exactly)
// ---------------------------------------------------------------------------

function cacheFilePath() {
  return process.env.DECODE_CACHE_FILE || path.resolve(".decode-cache.json");
}

function readFileStore() {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(), "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
    // no file yet / unreadable / corrupted -> treat as empty
  }
  return {};
}

function writeFileStore(store) {
  writeFileSync(cacheFilePath(), JSON.stringify(store));
}

function dumpFromFileStore() {
  const store = readFileStore();
  return Object.values(store);
}

/** Only-add-missing-keys: existing rows always win over a restore. Returns count actually inserted. */
function restoreToFileStore(rows) {
  const store = readFileStore();
  let inserted = 0;
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(store, row.code)) continue; // existing row wins
    store[row.code] = row;
    inserted += 1;
  }
  writeFileStore(store);
  return inserted;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function runDump() {
  const db = await getTursoClient();
  const backend = db ? "Turso" : "local file store";
  const rows = db ? await dumpFromTurso(db) : dumpFromFileStore();

  const backupsDir = path.resolve("backups");
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
  const outFile = path.join(backupsDir, `decode-cache-${todayKey()}.jsonl`);
  writeFileSync(outFile, exportDecodeCache(rows), "utf8");

  console.log(`[decode-cache-backup] dumped ${rows.length} row(s) from ${backend} -> ${outFile}`);
  await db?.close?.();
}

async function runRestore(file) {
  if (!file) {
    console.error("[decode-cache-backup] --restore requires a file path");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) {
    console.error(`[decode-cache-backup] backup file not found: ${file}`);
    process.exitCode = 1;
    return;
  }
  const jsonl = readFileSync(file, "utf8");
  const rows = parseBackup(jsonl);

  const db = await getTursoClient();
  const backend = db ? "Turso" : "local file store";
  const inserted = db ? await restoreToTurso(db, rows) : restoreToFileStore(rows);
  const skipped = rows.length - inserted;

  console.log(
    `[decode-cache-backup] restore from ${file}: ${rows.length} row(s) parsed, ${inserted} inserted, ` +
      `${skipped} skipped (already present - existing rows always win) into ${backend}`,
  );
  await db?.close?.();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--dump")) {
    await runDump();
    return;
  }
  const restoreIdx = args.indexOf("--restore");
  if (restoreIdx !== -1) {
    await runRestore(args[restoreIdx + 1]);
    return;
  }
  console.error("Usage: node scripts/decode-cache-backup.mjs --dump | --restore <file>");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("[decode-cache-backup] failed:", e?.message ?? e);
  process.exitCode = 1;
});
