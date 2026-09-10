// scripts/proof-scope.test.mjs
//
// Run with: node --test scripts/proof-scope.test.mjs
//
// Two kinds of coverage:
//   1. Pure unit tests of mapChangedFilesToSuites() -- no I/O, no spawn.
//   2. The GLOB LIVENESS TEST: walks the real e2e/ directory and package.json scripts
//      and asserts every spec-name substring / bot-config name in scripts/proof-scope.mjs's
//      RULES table actually matches something that exists today. This is the guardrail
//      against the table silently drifting stale (e.g. a spec renamed during the
//      folder reorg) -- see that file's header for why this matters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULES,
  mapChangedFilesToSuites,
  findDeadTableReferences,
  listE2eFiles,
} from "./proof-scope.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------------------
// 1. mapChangedFilesToSuites unit tests
// ---------------------------------------------------------------------------------------

test("ledger changes select ledger e2e specs + test:ledger, no runAll", () => {
  const r = mapChangedFilesToSuites(["src/inventory/ledger.ts"]);
  assert.equal(r.runAll, false);
  assert.deepEqual(r.playwrightSpecs.sort(), ["count-always", "count-law-mixed-tiers", "ledger-markwrong"].sort());
  assert.deepEqual(r.npmScripts, ["test:ledger"]);
  assert.equal(r.runFirebase, false);
});

test("scanStore.ts prefix match (not just scanStore/ directory) triggers ledger rule", () => {
  const r = mapChangedFilesToSuites(["src/stores/scanStore.ts"]);
  assert.equal(r.runAll, false);
  assert.ok(r.npmScripts.includes("test:ledger"));
});

test("src/stores/scan/ (Project B slice extraction) triggers ledger rule, not runAll", () => {
  const r = mapChangedFilesToSuites(["src/stores/scan/reviewSlice.ts"]);
  assert.equal(r.runAll, false);
  assert.ok(r.npmScripts.includes("test:ledger"));
});

test("a .rules.ts file anywhere triggers the firebase rule", () => {
  const r = mapChangedFilesToSuites(["src/sync-database/cloud/newThing.rules.ts"]);
  assert.equal(r.runAll, false);
  assert.equal(r.runFirebase, true);
});

test("src/sync-database/** triggers firebase without needing .rules.ts", () => {
  const r = mapChangedFilesToSuites(["src/sync-database/queue/pendingQueue.ts"]);
  assert.equal(r.runFirebase, true);
});

test("src/scanning/** selects scan specs + qa:bots:ux", () => {
  const r = mapChangedFilesToSuites(["src/scanning/ScanInput.tsx"]);
  assert.equal(r.runAll, false);
  assert.deepEqual(r.playwrightSpecs.sort(), ["camera-scan.spec.ts", "scan.spec.ts", "scanner-focus.spec.ts"].sort());
  assert.deepEqual(r.botConfigs, ["ux-no-training"]);
});

test("src/decoding/** selects decode specs + qa:bots:tire", () => {
  const r = mapChangedFilesToSuites(["src/decoding/server/pipeline/pipeline.ts"]);
  assert.equal(r.runAll, false);
  assert.ok(r.playwrightSpecs.includes("decode.spec.ts"));
  assert.ok(r.playwrightSpecs.includes("trust-gate-law.spec.ts"));
  assert.deepEqual(r.botConfigs, ["platformOwner-tire-resolution"]);
});

test("src/products/** and src/review/** select resolver/suggested/trust specs", () => {
  const r = mapChangedFilesToSuites(["src/products/aliases/aliasTable.ts", "src/review/approve.ts"]);
  assert.equal(r.runAll, false);
  assert.ok(r.playwrightSpecs.includes("resolver.spec.ts"));
  assert.ok(r.playwrightSpecs.includes("verified-decode-not-unknown.spec.ts"));
});

test("src/reports/** and src/users-businesses/** select export specs + security bots", () => {
  const r = mapChangedFilesToSuites(["src/reports/csvExport.ts", "src/users-businesses/roles.ts"]);
  assert.equal(r.runAll, false);
  assert.deepEqual(r.playwrightSpecs.sort(), ["export-content-correctness.spec.ts", "export-menu.spec.ts"].sort());
  assert.deepEqual(r.botConfigs.sort(), ["export-leak", "role-security-leak"].sort());
});

test("src/import/** and src/reconcile/** select phase4 + reconcile specs", () => {
  const r = mapChangedFilesToSuites(["src/import/columnInference.ts", "src/reconcile/variance.ts"]);
  assert.equal(r.runAll, false);
  assert.deepEqual(
    r.playwrightSpecs.sort(),
    ["phase4-fuzzy-reconcile.spec.ts", "phase4-universal-import.spec.ts", "reconcile.spec.ts"].sort()
  );
});

test("docs-only diff (md + docs/** + README) selects nothing and does not runAll", () => {
  const r = mapChangedFilesToSuites(["docs/ARCHITECTURE.md", "README.md", "PROGRESS.md", "GUARDRAILS.md"]);
  assert.equal(r.runAll, false);
  assert.deepEqual(r.playwrightSpecs, []);
  assert.deepEqual(r.botConfigs, []);
  assert.equal(r.runFirebase, false);
  assert.deepEqual(r.reasons, []);
});

test("an unmatched file fails CLOSED: runAll true, even alongside matched files", () => {
  const r = mapChangedFilesToSuites(["src/inventory/ledger.ts", "src/some-new-area/thing.ts"]);
  assert.equal(r.runAll, true);
  assert.deepEqual(r.unmatchedFiles, ["src/some-new-area/thing.ts"]);
});

test("a totally unrecognized single file fails CLOSED", () => {
  const r = mapChangedFilesToSuites(["src/admin/newTool.ts"]);
  assert.equal(r.runAll, true);
});

test("empty changed-file list selects nothing and does not runAll", () => {
  const r = mapChangedFilesToSuites([]);
  assert.equal(r.runAll, false);
  assert.deepEqual(r.playwrightSpecs, []);
});

test("a file matching two rules unions their suites", () => {
  // src/sync-database/ AND a .rules.ts filename both hit the firebase rule; ensure no double count
  // and ensure a file that could plausibly match two categories accumulates both (defensive: RULES
  // entries currently don't overlap by design, but the union logic must not silently drop one).
  const r = mapChangedFilesToSuites(["src/sync-database/cloud/x.rules.ts"]);
  assert.equal(r.runFirebase, true);
  assert.equal(r.reasons.filter((x) => x.rule === "firebase").length >= 1, true);
});

// ---------------------------------------------------------------------------------------
// 2. GLOB LIVENESS TEST -- the hard guardrail
// ---------------------------------------------------------------------------------------

test("GLOB LIVENESS: every playwrightSpecSubstring and botConfig in RULES matches a real file/script", () => {
  const e2eFiles = listE2eFiles(path.join(repoRoot, "e2e"));

  const dead = findDeadTableReferences({ e2eFiles });

  assert.deepEqual(
    dead,
    [],
    `scripts/proof-scope.mjs RULES table references that no longer exist -- fix the table:\n${JSON.stringify(dead, null, 2)}`
  );
});

test("GLOB LIVENESS: npm scripts referenced in RULES (test:ledger) exist in package.json", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const referenced = new Set(RULES.flatMap((r) => r.npmScripts));
  for (const script of referenced) {
    assert.ok(packageJson.scripts?.[script], `package.json is missing npm script "${script}" referenced by RULES`);
  }
});

test("GLOB LIVENESS: the firebase-scoped e2e directory and .rules.test.ts convention still exist", () => {
  assert.ok(existsSync(path.join(repoRoot, "e2e", "firebase-phase2")), "e2e/firebase-phase2 directory is gone -- update the firebase rule");
  assert.ok(
    existsSync(path.join(repoRoot, "package.json")) &&
      JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts["test:e2e:firebase"],
    "test:e2e:firebase npm script is gone -- update main()'s firebase leg"
  );
});

// Sanity: findDeadTableReferences itself must actually detect a dead reference (proves the
// liveness test isn't vacuously green because the detector is broken).
test("findDeadTableReferences detects an intentionally dead reference", () => {
  const dead = findDeadTableReferences({
    e2eFiles: ["e2e/scan.spec.ts", "e2e/human-bots/scenarios/ux-no-training.spec.ts"],
  });
  // Every RULES entry's substrings/configs checked against a deliberately tiny fake universe --
  // most will be reported dead. Assert at least one, and that a known-present one is NOT flagged.
  assert.ok(dead.length > 0, "expected some references to be reported dead against a tiny fake universe");
  assert.ok(
    !dead.some((d) => d.kind === "playwrightSpecSubstring" && d.value === "scan.spec.ts"),
    "scan.spec.ts is present in the fake universe and must not be reported dead"
  );
});
