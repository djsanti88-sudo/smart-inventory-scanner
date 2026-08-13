#!/usr/bin/env node
// Creates a source-isolated distributor catalog ledger. It never reads or writes the app corpus.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [sourceCode, target] = process.argv.slice(2);
if (!/^[A-Z]{3}$/.test(sourceCode || "") || !target) {
  throw new Error("Usage: node scripts/distributor-catalog/init-db.mjs <ATD|NTW> <database-path>");
}

const dbPath = resolve(process.cwd(), target);
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
    source_code TEXT NOT NULL, source_url TEXT NOT NULL, rate_policy TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'stopped', 'complete')), notes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS shards (
    shard_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    parent_shard_id TEXT REFERENCES shards(shard_id), filter_json TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'capped', 'error', 'paused')),
    attempts INTEGER NOT NULL DEFAULT 0, result_count INTEGER, cap_detected INTEGER NOT NULL DEFAULT 0 CHECK(cap_detected IN (0,1)),
    requested_at TEXT, finished_at TEXT, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS products (
    source_identifier_normalized TEXT PRIMARY KEY, source_identifier_display TEXT NOT NULL,
    manufacturer_part_number TEXT, brand TEXT, description TEXT, tire_size TEXT, category TEXT,
    details_url TEXT, upc TEXT, upc_status TEXT NOT NULL DEFAULT 'not_exposed',
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS product_snapshots (
    snapshot_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    shard_id TEXT NOT NULL REFERENCES shards(shard_id), source_identifier_normalized TEXT NOT NULL REFERENCES products(source_identifier_normalized),
    observed_at TEXT NOT NULL, source_url TEXT NOT NULL, raw_row_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS detail_attempts (
    attempt_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    source_identifier_normalized TEXT NOT NULL REFERENCES products(source_identifier_normalized),
    source_url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','no_data','transient_error','paused')),
    extracted_row_count INTEGER, error_text TEXT, attempted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS specs (
    spec_id INTEGER PRIMARY KEY, source_identifier_normalized TEXT NOT NULL REFERENCES products(source_identifier_normalized),
    source TEXT NOT NULL CHECK(source IN ('results','detail')), raw_label TEXT NOT NULL, raw_value TEXT NOT NULL, captured_at TEXT NOT NULL,
    UNIQUE(source_identifier_normalized, source, raw_label, raw_value)
  );
  CREATE TABLE IF NOT EXISTS collection_events (
    event_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), occurred_at TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shards_status ON shards(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_snapshots_identifier ON product_snapshots(source_identifier_normalized);
`);
db.close();
console.log(JSON.stringify({ sourceCode, database: dbPath, schema: "distributor-catalog-v1" }));
