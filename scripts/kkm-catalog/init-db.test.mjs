// Schema proof for scripts/kkm-catalog/init-db.mjs. Self-contained since 2026-08-19: it runs the real
// init script against a scratch cwd instead of requiring the gitignored data/kkm-catalog/kkm.sqlite
// to already exist in this checkout (a fresh worktree or CI has no such file).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INIT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "init-db.mjs");

test("init-db.mjs creates the KKM catalog schema (isolated from the app corpus)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "kkm-init-db-"));
  try {
    const run = spawnSync(process.execPath, [INIT_SCRIPT], { cwd: scratch, encoding: "utf8" });
    assert.equal(run.status, 0, `init-db.mjs exited ${run.status}: ${run.stderr}`);
    const db = new Database(join(scratch, "data", "kkm-catalog", "kkm.sqlite"), { readonly: true });
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
      for (const expected of ["runs", "shards", "products", "product_snapshots", "datasheet_attempts", "specs", "collection_events"]) {
        assert.ok(names.includes(expected), `Missing table: ${expected}`);
      }
      const product = db.prepare("PRAGMA table_info(products)").all();
      assert.ok(
        product.some((column) => column.name === "part_number_normalized" && column.pk === 1),
        "Product key is not normalized part number",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
