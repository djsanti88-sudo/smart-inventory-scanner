#!/usr/bin/env node
// scripts/proof-scope.mjs
//
// DIFF-SCOPED PROOF SELECTOR.
//
// `npm run proof:all` (tsc + vitest + node:test, ~64s) already runs on every change and
// is NOT touched here. What this file scopes is the three suites that are expensive
// and mostly redundant per-PR: `npm run test:e2e` (dozens of Playwright specs),
// `npm run qa:bots:all` (6 human-bot configs), and `npm run test:firebase` (Firestore
// emulator). Today those three always run in full regardless of what a PR touched.
//
// mapChangedFilesToSuites() is a pure function: given the list of changed files, it
// returns exactly which of those suites are relevant. It has no I/O so it is directly
// unit-testable (see scripts/proof-scope.test.mjs) without spawning git or Playwright.
//
// THE ONE INVARIANT THAT MATTERS: fail CLOSED, never open. Any changed file that does
// not match a known rule below sets `runAll: true` and the CLI falls back to running
// every suite in full, same as today. A diff-scope tool that silently under-runs is
// worse than no tool at all -- it would report green while covering less, exactly the
// class of bug AGENTS.md calls out ("anything that identifies code by path is a trap").
//
// GLOB LIVENESS: the mapping table below names spec-file substrings and bot-config
// names by hand. If e2e/ gets reorganized (this branch is mid folder-reorg) and a spec
// is renamed, this table can silently point at nothing -- `npx playwright test
// count-always` matching zero files exits 0 with "no tests found", which looks just
// like a scoped pass. scripts/proof-scope.test.mjs walks the real e2e/ directory and
// package.json scripts and asserts every substring/config name here still matches a
// real file. That test is the guardrail against this table drifting stale; keep it
// green whenever this table changes.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------
// THE MAPPING TABLE
//
// Each entry: changed-path prefixes -> the suites required. `pathPrefixes` are matched
// with String.startsWith against a repo-relative, forward-slash path. `pathPattern` is
// an optional regex for prefixes that don't fit a plain startsWith (e.g. `*.rules.ts`
// anywhere in the tree).
// ---------------------------------------------------------------------------------------
export const RULES = [
  {
    id: "ledger",
    // src/stores/scan/ (Project B waves 1-6) is scanStore.ts split into files -- still the
    // ledger/counting-law store, just modularized. Route it here rather than leave it to
    // fail-closed runAll, which would otherwise fire on every scanStore refactor commit.
    pathPrefixes: ["src/inventory/", "src/stores/scanStore", "src/stores/ledger", "src/stores/scan/"],
    playwrightSpecSubstrings: ["count-always", "ledger-markwrong", "count-law-mixed-tiers"],
    botConfigs: [],
    npmScripts: ["test:ledger"],
    firebase: false,
  },
  {
    // e2e/firebase-phase2/* runs under its own config (playwright.firebase.config.ts,
    // via `npm run test:e2e:firebase`) -- the default test:e2e config testIgnores that
    // directory entirely, so these specs are NOT added to playwrightSpecSubstrings
    // (which feeds the default-config leg). runFirebase alone drives the dedicated
    // test:firebase + test:e2e:firebase legs; see main() below.
    id: "firebase",
    pathPrefixes: ["src/sync-database/"],
    pathPattern: /\.rules\.ts$/,
    playwrightSpecSubstrings: [],
    botConfigs: [],
    npmScripts: [],
    firebase: true,
  },
  {
    id: "scanning",
    pathPrefixes: ["src/scanning/"],
    playwrightSpecSubstrings: ["scan.spec.ts", "scanner-focus.spec.ts", "camera-scan.spec.ts"],
    botConfigs: ["ux-no-training"],
    npmScripts: [],
    firebase: false,
  },
  {
    id: "decoding",
    pathPrefixes: ["src/decoding/"],
    playwrightSpecSubstrings: [
      "decode.spec.ts",
      "auto-decode.spec.ts",
      "gpt-decode-burst.spec.ts",
      "best-guess-identity.spec.ts",
      "firewall.spec.ts",
      "trust-gate-law.spec.ts",
    ],
    botConfigs: ["platformOwner-tire-resolution"],
    npmScripts: [],
    firebase: false,
  },
  {
    id: "products-review",
    pathPrefixes: ["src/products/", "src/review/"],
    playwrightSpecSubstrings: [
      "resolver.spec.ts",
      "suggested-decode.spec.ts",
      "suggested-label.spec.ts",
      "cross-identifier.spec.ts",
      "verified-decode-not-unknown.spec.ts",
    ],
    botConfigs: [],
    npmScripts: [],
    firebase: false,
  },
  {
    id: "reports-roles",
    pathPrefixes: ["src/reports/", "src/users-businesses/"],
    playwrightSpecSubstrings: ["export-menu.spec.ts", "export-content-correctness.spec.ts"],
    botConfigs: ["role-security-leak", "export-leak"],
    npmScripts: [],
    firebase: false,
  },
  {
    id: "import-reconcile",
    pathPrefixes: ["src/import/", "src/reconcile/"],
    playwrightSpecSubstrings: ["phase4-universal-import.spec.ts", "phase4-fuzzy-reconcile.spec.ts", "reconcile.spec.ts"],
    botConfigs: [],
    npmScripts: [],
    firebase: false,
  },
];

// Files that never require a code suite on their own. Recognized so they don't fall
// into "matches no rule" and trip runAll -- but they don't grant a docs-only diff any
// suites either; see mapChangedFilesToSuites for how an all-docs diff is handled.
const DOCS_ONLY_RE = /(^|\/)README(\.[^/]+)?$|\.md$|(^|\/)docs\//i;

/**
 * Pure mapping: changed repo-relative file paths -> the suites a PR touching them
 * needs. No I/O. See RULES above for the table and the file header for the fail-closed
 * invariant.
 *
 * @param {string[]} changedFiles
 * @returns {{
 *   playwrightSpecs: string[],
 *   botConfigs: string[],
 *   runFirebase: boolean,
 *   runAll: boolean,
 *   npmScripts: string[],
 *   reasons: Array<{file: string, rule: string}>,
 *   unmatchedFiles: string[],
 * }}
 */
export function mapChangedFilesToSuites(changedFiles) {
  const files = (changedFiles ?? []).map((f) => f.split(path.sep).join("/"));

  const playwrightSpecs = new Set();
  const botConfigs = new Set();
  const npmScripts = new Set();
  let runFirebase = false;
  const reasons = [];
  const unmatchedFiles = [];

  for (const file of files) {
    const matchedRules = RULES.filter(
      (rule) =>
        rule.pathPrefixes.some((prefix) => file.startsWith(prefix)) ||
        (rule.pathPattern && rule.pathPattern.test(file))
    );

    if (matchedRules.length === 0) {
      if (DOCS_ONLY_RE.test(file)) continue; // recognized as docs -- no suite, not an unmatched/unknown file
      unmatchedFiles.push(file);
      continue;
    }

    for (const rule of matchedRules) {
      rule.playwrightSpecSubstrings.forEach((s) => playwrightSpecs.add(s));
      rule.botConfigs.forEach((b) => botConfigs.add(b));
      rule.npmScripts.forEach((s) => npmScripts.add(s));
      if (rule.firebase) runFirebase = true;
      reasons.push({ file, rule: rule.id });
    }
  }

  // Fail CLOSED: any file this table has no opinion about (and that isn't recognized
  // docs) means we cannot vouch that a narrower run is safe. Run everything.
  const runAll = unmatchedFiles.length > 0;

  return {
    playwrightSpecs: [...playwrightSpecs],
    botConfigs: [...botConfigs],
    runFirebase,
    runAll,
    npmScripts: [...npmScripts],
    reasons,
    unmatchedFiles,
  };
}

// ---------------------------------------------------------------------------------------
// GLOB LIVENESS CHECK (exported so scripts/proof-scope.test.mjs can assert it directly)
//
// Confirms every playwrightSpecSubstring and botConfig name in RULES actually matches a
// real file/script today. Returns the list of dead references (empty = table is live).
// ---------------------------------------------------------------------------------------
export function findDeadTableReferences({ e2eFiles } = {}) {
  const dead = [];
  const specs = e2eFiles ?? [];

  for (const rule of RULES) {
    for (const substring of rule.playwrightSpecSubstrings) {
      if (!specs.some((f) => f.includes(substring))) {
        dead.push({ kind: "playwrightSpecSubstring", rule: rule.id, value: substring });
      }
    }
    // botConfigs are the `--config=playwright.bots.config.ts <arg>` filters (see
    // qa:bots:* in package.json), which Playwright matches as a substring against
    // e2e/human-bots/scenarios/*.spec.ts paths -- same matching rule as spec substrings,
    // so they are checked against the same real-file listing.
    for (const bot of rule.botConfigs) {
      if (!specs.some((f) => f.includes(bot))) {
        dead.push({ kind: "botConfig", rule: rule.id, value: bot });
      }
    }
  }
  return dead;
}

/** Recursive walk collecting repo-relative, forward-slash paths under e2e/. */
export function listE2eFiles(root = "e2e", readdir = readdirSync) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  }
  walk(root);
  return out.map((f) => f.split(path.sep).join("/"));
}

// ---------------------------------------------------------------------------------------
// CLI DRIVER
// ---------------------------------------------------------------------------------------

function repoRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

function gitChangedFiles(base) {
  const r = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

const legResults = [];

function runLeg(label, cmd, args) {
  process.stdout.write(`\n=== ${label} ===\n${cmd} ${args.join(" ")}\n`);
  const needsShell = process.platform === "win32" && cmd !== process.execPath;
  const r = spawnSync(cmd, args, { cwd: repoRoot(), stdio: "inherit", shell: needsShell });
  const ok = r.status === 0;
  legResults.push({ label, ok });
  if (!ok) process.stdout.write(`--- FAILED: ${label} (exit ${r.status}) ---\n`);
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const baseFlagIndex = args.indexOf("--base");
  const base = baseFlagIndex >= 0 ? args[baseFlagIndex + 1] : "origin/master";

  process.stdout.write(`proof-scope: diffing against ${base}...HEAD\n`);
  let changedFiles;
  try {
    changedFiles = gitChangedFiles(base);
  } catch (err) {
    process.stdout.write(`${err.message}\n`);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    process.stdout.write("No changed files vs base. Nothing to run.\n");
    process.exit(0);
  }

  process.stdout.write(`Changed files (${changedFiles.length}):\n${changedFiles.map((f) => `  ${f}`).join("\n")}\n`);

  const scope = mapChangedFilesToSuites(changedFiles);

  if (scope.runAll) {
    process.stdout.write(
      `\nFAIL CLOSED: ${scope.unmatchedFiles.length} changed file(s) match no rule in the mapping table:\n` +
        scope.unmatchedFiles.map((f) => `  ${f}`).join("\n") +
        "\nRunning every suite in full (test:e2e, qa:bots:all, test:firebase).\n"
    );
  } else {
    process.stdout.write("\nSelected suites and why:\n");
    if (scope.reasons.length === 0) {
      process.stdout.write("  (docs-only diff -- nothing beyond proof:all)\n");
    }
    for (const { file, rule } of scope.reasons) {
      process.stdout.write(`  ${file} -> rule "${rule}"\n`);
    }
    process.stdout.write(
      `\nplaywrightSpecs: ${scope.playwrightSpecs.join(", ") || "(none)"}\n` +
        `botConfigs: ${scope.botConfigs.join(", ") || "(none)"}\n` +
        `npmScripts: ${scope.npmScripts.join(", ") || "(none)"}\n` +
        `runFirebase: ${scope.runFirebase}\n`
    );
  }

  for (const script of scope.npmScripts) {
    runLeg(`npm run ${script}`, "npm", ["run", script]);
  }

  if (scope.runAll) {
    runLeg("test:e2e (full)", "npx", ["playwright", "test"]);
    runLeg("qa:bots:all (full)", "npx", ["playwright", "test", "--config=playwright.bots.config.ts"]);
    if (existsSync(path.join(repoRoot(), "firebase.json"))) {
      runLeg("test:firebase (full)", "npm", ["run", "test:firebase"]);
    }
  } else {
    if (scope.playwrightSpecs.length) {
      runLeg(`test:e2e (scoped: ${scope.playwrightSpecs.join(", ")})`, "npx", ["playwright", "test", ...scope.playwrightSpecs]);
    }
    if (scope.botConfigs.length) {
      runLeg(
        `qa:bots (scoped: ${scope.botConfigs.join(", ")})`,
        "npx",
        ["playwright", "test", "--config=playwright.bots.config.ts", ...scope.botConfigs]
      );
    }
    if (scope.runFirebase) {
      runLeg("test:firebase", "npm", ["run", "test:firebase"]);
      runLeg("test:e2e:firebase", "npm", ["run", "test:e2e:firebase"]);
    }
  }

  process.stdout.write("\n=== proof-scope summary ===\n");
  for (const { label, ok } of legResults) {
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n`);
  }
  if (legResults.length === 0) {
    process.stdout.write("(no legs run -- docs-only diff)\n");
  }

  const failed = legResults.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
