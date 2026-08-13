#!/usr/bin/env node
// KKM = internal code name for the isolated K&M/Weblink catalog snapshot.
// This never reads, joins, or writes the application's knowledge corpus.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), "data", "kkm-catalog", "kkm.sqlite");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source_code TEXT NOT NULL CHECK(source_code = 'KKM'),
    source_url TEXT NOT NULL,
    rate_policy TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'stopped', 'complete')),
    notes TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS shards (
    shard_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    parent_shard_id TEXT REFERENCES shards(shard_id),
    vendor_id TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    class_id TEXT NOT NULL,
    class_name TEXT NOT NULL,
    filter_kind TEXT NOT NULL DEFAULT 'vendor_class',
    filter_value TEXT NOT NULL DEFAULT '',
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'capped', 'error', 'paused')),
    attempts INTEGER NOT NULL DEFAULT 0,
    result_count INTEGER,
    cap_detected INTEGER NOT NULL DEFAULT 0 CHECK(cap_detected IN (0, 1)),
    requested_at TEXT,
    finished_at TEXT,
    last_error TEXT,
    UNIQUE(run_id, vendor_id, class_id, filter_kind, filter_value)
  );

  CREATE TABLE IF NOT EXISTS products (
    part_number_normalized TEXT PRIMARY KEY,
    part_number_display TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    class_id TEXT NOT NULL,
    class_name TEXT NOT NULL,
    description TEXT,
    datasheet_url TEXT,
    upc TEXT,
    upc_status TEXT NOT NULL DEFAULT 'not_exposed',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS product_snapshots (
    snapshot_id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    shard_id TEXT NOT NULL REFERENCES shards(shard_id),
    part_number_normalized TEXT NOT NULL REFERENCES products(part_number_normalized),
    observed_at TEXT NOT NULL,
    source_url TEXT NOT NULL,
    raw_row_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS datasheet_attempts (
    attempt_id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    part_number_normalized TEXT NOT NULL REFERENCES products(part_number_normalized),
    source_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'no_data', 'transient_error', 'paused')),
    extracted_row_count INTEGER,
    error_text TEXT,
    attempted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS specs (
    spec_id INTEGER PRIMARY KEY,
    part_number_normalized TEXT NOT NULL REFERENCES products(part_number_normalized),
    source TEXT NOT NULL CHECK(source IN ('results', 'datasheet')),
    raw_label TEXT NOT NULL,
    raw_value TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    UNIQUE(part_number_normalized, source, raw_label, raw_value)
  );

  CREATE TABLE IF NOT EXISTS collection_events (
    event_id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_shards_status ON shards(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_snapshots_part ON product_snapshots(part_number_normalized);
  CREATE INDEX IF NOT EXISTS idx_specs_part ON specs(part_number_normalized);
`);

const tableCount = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
db.close();
console.log(JSON.stringify({ database: DB_PATH, tableCount, schema: "kkm-catalog-v1" }));
