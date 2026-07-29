#!/usr/bin/env node
// M2 fix proof (Codex panel finding M2): PROMOTE_PREFLIGHT_REPORT.md previously said
// "PART_NUMBER_CONFLICTS.csv section 1 lists 33 total conflict rows (matches
// tire_part_numbers_quarantine's 34 quarantined rows)" - 33 does not match 34, which the panel
// correctly flagged as a self-check that mislabeled a mismatched count as a successful cross-check.
//
// Root cause (verified against the real data, not assumed): PART_NUMBER_CONFLICTS.csv section 1 has
// one row per DISTINCT old_uid CONFLICT GROUP (33 rows); tire_part_numbers_quarantine has one row
// per QUARANTINED KEY (34 rows), because the old_uid
// "bfgoodrich_g_force_r1_s_p225_45r17_84_w_20244" quarantines BOTH the "20244" and "202440" keys.
// These are different units and were never expected to be numerically equal to each other.
//
// This test proves computeQuarantineCrossCheck() (extracted from
// scripts/tire-db-repair/09_promote_preflight.mjs) compares GROUP COUNT to GROUP COUNT correctly,
// using both a synthetic minimal fixture and the REAL checked-in dataset (PART_NUMBER_CONFLICTS.csv
// + REPAIRED_TIRE_DATABASE.db's tire_part_numbers_quarantine table), without requiring any live
// Turso connection (09_promote_preflight.mjs's main() requires live Turso and is out of scope for
// an offline unit test; PREFLIGHT_SKIP_MAIN=1 avoids triggering it on import).
//
// Usage: node --test scripts/tire-db-repair/09_promote_preflight.test.mjs

process.env.PREFLIGHT_SKIP_MAIN = "1";
const { computeQuarantineCrossCheck } = await import("./09_promote_preflight.mjs");

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUTPUT_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28");
const PART_NUMBER_CONFLICTS_CSV = join(OUTPUT_DIR, "PART_NUMBER_CONFLICTS.csv");
const WORKING_DB_PATH = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");

test("computeQuarantineCrossCheck: synthetic fixture where one group quarantines two keys", () => {
  // 3 distinct conflict groups in the CSV (section1Rows), matching 3 distinct old_uids in the
  // quarantine table, but one of those old_uids quarantines 2 keys -> 4 quarantine rows total.
  const section1Rows = [
    { old_uid: "group_a" }, { old_uid: "group_b" }, { old_uid: "group_c" },
  ];
  const quarantineRows = [
    { canonical_product_uid: "group_a" },
    { canonical_product_uid: "group_b" },
    { canonical_product_uid: "group_b" }, // group_b quarantines a SECOND key
    { canonical_product_uid: "group_c" },
  ];

  const result = computeQuarantineCrossCheck(section1Rows, quarantineRows);

  assert.equal(result.csvGroupCount, 3);
  assert.equal(result.quarantineRowCount, 4);
  assert.equal(result.quarantineDistinctUids, 3);
  assert.equal(result.groupCountsMatch, true, "3 CSV groups should match 3 distinct quarantined old_uids, even though row counts (3 vs 4) differ");
  assert.equal(result.keysPerGroup, 1, "exactly 1 extra key beyond one-per-group");
});

test("computeQuarantineCrossCheck: flags a genuine group-count MISMATCH (not just a row-count difference)", () => {
  // 2 distinct conflict groups in the CSV, but 3 distinct old_uids in quarantine - a REAL mismatch
  // this cross-check must catch (as opposed to the previous test's benign row-count difference).
  const section1Rows = [{ old_uid: "group_a" }, { old_uid: "group_b" }];
  const quarantineRows = [
    { canonical_product_uid: "group_a" },
    { canonical_product_uid: "group_b" },
    { canonical_product_uid: "group_x" }, // not in the CSV at all - genuine mismatch
  ];

  const result = computeQuarantineCrossCheck(section1Rows, quarantineRows);

  assert.equal(result.csvGroupCount, 2);
  assert.equal(result.quarantineDistinctUids, 3);
  assert.equal(result.groupCountsMatch, false, "a genuine group-count divergence must be flagged as a mismatch");
});

test("computeQuarantineCrossCheck: against the REAL checked-in dataset, 33 CSV groups match 33 distinct quarantined old_uids (34 quarantine ROWS is correct and not a bug)", (t) => {
  if (!existsSync(PART_NUMBER_CONFLICTS_CSV) || !existsSync(WORKING_DB_PATH)) {
    t.skip("real dataset files not present in this checkout");
    return;
  }

  const conflictsCsvText = readFileSync(PART_NUMBER_CONFLICTS_CSV, "utf8");
  const section1Rows = [];
  for (const line of conflictsCsvText.split(/\r?\n/).slice(1)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (line.startsWith("# Section 2")) break;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [old_uid, cls] = parts;
    if (cls !== "conflict") continue;
    section1Rows.push({ old_uid });
  }

  const db = new Database(WORKING_DB_PATH, { readonly: true });
  const quarantineRows = db.prepare("SELECT * FROM tire_part_numbers_quarantine").all();
  db.close();

  const result = computeQuarantineCrossCheck(section1Rows, quarantineRows);

  // The real, verified breakdown: 33 distinct conflict groups, 34 quarantined key rows (one group
  // - bfgoodrich_g_force_r1_s_p225_45r17_84_w_20244 - quarantines both "20244" and "202440").
  assert.equal(result.csvGroupCount, 33);
  assert.equal(result.quarantineRowCount, 34);
  assert.equal(result.quarantineDistinctUids, 33);
  assert.equal(result.groupCountsMatch, true, "the real dataset's group counts genuinely agree (33 == 33); only the raw row counts (33 vs 34) differ, which is expected and no longer misreported as a mismatch");
  assert.equal(result.keysPerGroup, 1);

  // Confirm the specific known multi-key group by name, so this proof is tied to the actual root
  // cause rather than just matching numbers coincidentally.
  const bfgGroupRows = quarantineRows.filter((r) => r.canonical_product_uid === "bfgoodrich_g_force_r1_s_p225_45r17_84_w_20244");
  assert.equal(bfgGroupRows.length, 2, "expected the bfgoodrich group to quarantine exactly 2 keys (20244 and 202440)");
  const keys = bfgGroupRows.map((r) => r.normalized_part_number).sort();
  assert.deepEqual(keys, ["20244", "202440"]);
});

test("NOTE: the checked-in PROMOTE_PREFLIGHT_REPORT.md is a STALE artifact from before this fix", (t) => {
  // 09_promote_preflight.mjs's main() requires a live Turso connection to regenerate this report
  // (see the PREFLIGHT_SKIP_MAIN guard above) - regenerating it is out of scope for this offline
  // fix (no live Turso reads/writes permitted here). The checked-in report on disk therefore still
  // shows the OLD buggy wording ("lists 33 total conflict rows (matches ... 34 quarantined rows")
  // until an operator re-runs `node scripts/tire-db-repair/09_promote_preflight.mjs` live. The
  // CODE fix itself (computeQuarantineCrossCheck, used by the report generator) is proven correct
  // against the real dataset by the test above ("against the REAL checked-in dataset..."); this
  // test only documents that the on-disk .md snapshot needs a live re-run to pick up the corrected
  // wording, so a future reader isn't confused by a stale mismatch string in the tracked report.
  const reportPath = join(OUTPUT_DIR, "PROMOTE_PREFLIGHT_REPORT.md");
  if (!existsSync(reportPath)) {
    t.skip("report not present in this checkout");
    return;
  }
  const text = readFileSync(reportPath, "utf8");
  const isStale = /lists 33 total conflict rows \(matches/.test(text);
  if (isStale) {
    console.log(
      "NOTE: backups/.../PROMOTE_PREFLIGHT_REPORT.md still contains the pre-fix wording. " +
        "Re-run `node scripts/tire-db-repair/09_promote_preflight.mjs` (requires live Turso, owner-gated) " +
        "to regenerate it with the corrected group-vs-row cross-check text."
    );
  }
  // Not a hard assertion - this is a documentation note, not a code-correctness check. The fix's
  // correctness is proven by computeQuarantineCrossCheck's own tests above.
});
