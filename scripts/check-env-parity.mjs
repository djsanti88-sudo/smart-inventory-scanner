#!/usr/bin/env node
// Env-parity gate (never-again decision package item 2, Option M - name check only, no value
// pulling; agy's review flagged local secret-pulling as an avoidable exposure, so this checker
// intentionally never runs `vercel env pull` and never inspects a var's VALUE - only whether the
// NAME is present in the right Vercel environment(s)).
//
// Prevents a required variable from being silently absent from an environment before a
// deploy, and a var that must NEVER exist in Preview (e.g. NEXT_PUBLIC_FIREBASE_*, which would let
// a preview build reach real cloud/tenancy) silently being present there.
//
// Mechanism: shells out to `vercel env ls <environment>` (Vercel CLI must already be authenticated;
// this repo's CLI is), parses ONLY the `name` and `environments` columns of that table (never the
// `value` column - values are always shown as "Encrypted"/"Plain" by Vercel, never the secret
// itself, so nothing sensitive is read or printed here), and diffs the result against
// scripts/env-manifest.json's required/forbidden/optional sets for that environment.
//
// Exit 0: no gaps. Exit 1: prints every missing required var and every present forbidden var,
// per environment checked.
//
// Usage:
//   node scripts/check-env-parity.mjs                 # checks production AND preview
//   node scripts/check-env-parity.mjs --env=production # checks one environment
//   node scripts/check-env-parity.mjs --env=preview
//
// Node built-ins only (child_process, fs, path, url). No new dependencies.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "env-manifest.json");

const KNOWN_ENVIRONMENTS = ["production", "preview"];

function parseArgs(argv) {
  const args = { env: null };
  for (const raw of argv) {
    const m = raw.match(/^--env=(.+)$/);
    if (m) args.env = m[1].trim().toLowerCase();
  }
  return args;
}

function loadManifest() {
  let raw;
  try {
    raw = readFileSync(MANIFEST_PATH, "utf8");
  } catch (err) {
    console.error(`FATAL: could not read manifest at ${MANIFEST_PATH}: ${err.message}`);
    process.exit(2);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: manifest at ${MANIFEST_PATH} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  if (!json.environments || typeof json.environments !== "object") {
    console.error(`FATAL: manifest missing "environments" object.`);
    process.exit(2);
  }
  return json;
}

// Parses `vercel env ls <environment>` table output into a Set of var names present for that
// environment. We only ever read the `name` column and the environments column - `value` is
// always shown as a status ("Encrypted"/"Hidden"/"Plain", or a redacted/truncated blob for
// non-sensitive vars) never the real secret, so no secret material is parsed or stored.
//
// CLI format drift (observed live 2026-08-06 against sharpenly/inventory): older `vercel env ls`
// output was `name | value | environments | created` (3 data columns before `created`). The
// current CLI (58.7.0) inserts an extra `type` column: `name | value | type |
// environments (git branch) | created`. A parser hardcoded to "environments is the 3rd column"
// silently reads 0 vars against that format - exactly the defect that made the parity gate
// invisible to a live env-var drift. Indexing `environments` and `created` from the END of the
// row (rather than a fixed position from the start) is stable across both formats, since
// `created` is always last and `environments` is always immediately before it.
export function parseVercelEnvLs(stdout, targetEnvironment) {
  const names = new Set();
  const lines = stdout.split(/\r?\n/);
  // Vercel prints a capitalized environment label, e.g. "Production", "Preview", "Development".
  const targetLabel = targetEnvironment[0].toUpperCase() + targetEnvironment.slice(1);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank line

    // Row format (whitespace-column-separated, 2+ spaces between columns):
    // "<name>  <value>  [<type>]  <environments...>  <created>"
    // environments cell can be "Production", "Preview", "Preview, Production",
    // "Preview (git-branch-name)", "Development, Preview, Production".
    const cols = trimmed.split(/\s{2,}/).filter(Boolean);
    if (cols.length < 3) continue; // banner/footer/"Common next commands" lines never have 3+ columns

    const name = cols[0];
    if (/^name$/i.test(name)) continue; // header row, old or new format
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue; // guard against stray non-name rows

    // environments is always second-to-last; created ("11h ago", "3d ago", ...) is always last.
    const environmentsCell = cols[cols.length - 2];
    if (!environmentsCell) continue;

    const matches = environmentsCell
      .split(",")
      .map((part) => part.trim())
      .some((part) => part === targetLabel || part.startsWith(`${targetLabel} `));

    if (matches) names.add(name);
  }
  return names;
}

function runVercelEnvLs(environment) {
  // `environment` is always one of KNOWN_ENVIRONMENTS (validated in main() before this is called),
  // never raw user input, so shell:true here does not open an injection vector - it is required on
  // Windows because the installed `vercel` binary is a .CMD shim that execFileSync cannot invoke
  // directly without shell interpretation.
  try {
    return execFileSync("vercel", ["env", "ls", environment], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      shell: process.platform === "win32",
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    console.error(`FATAL: \`vercel env ls ${environment}\` failed.`);
    if (stdout.trim()) console.error(`--- stdout ---\n${stdout.trim()}`);
    if (stderr.trim()) console.error(`--- stderr ---\n${stderr.trim()}`);
    console.error(
      "Is the Vercel CLI installed and authenticated (`vercel whoami`), and is this directory linked to the project (`vercel link`)?"
    );
    process.exit(2);
  }
}

function checkEnvironment(environment, manifest) {
  const spec = manifest.environments[environment];
  if (!spec) {
    console.error(`FATAL: manifest has no entry for environment "${environment}".`);
    process.exit(2);
  }
  const required = new Set(spec.required || []);
  const forbidden = new Set(spec.forbidden || []);

  const stdout = runVercelEnvLs(environment);
  const present = parseVercelEnvLs(stdout, environment);

  const missingRequired = [...required].filter((name) => !present.has(name)).sort();
  const presentForbidden = [...forbidden].filter((name) => present.has(name)).sort();

  return { environment, present, missingRequired, presentForbidden };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();

  const environmentsToCheck = args.env ? [args.env] : KNOWN_ENVIRONMENTS;
  for (const env of environmentsToCheck) {
    if (!KNOWN_ENVIRONMENTS.includes(env)) {
      console.error(`FATAL: unknown --env="${env}". Expected one of: ${KNOWN_ENVIRONMENTS.join(", ")}`);
      process.exit(2);
    }
  }

  console.log(`Env-parity gate: checking ${environmentsToCheck.join(", ")} against ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
  console.log("(names only - no var values are read, pulled, or printed)\n");

  let anyGap = false;
  const results = [];

  for (const environment of environmentsToCheck) {
    const result = checkEnvironment(environment, manifest);
    results.push(result);

    console.log(`--- ${environment} ---`);
    console.log(`  present vars checked: ${result.present.size}`);

    if (result.missingRequired.length === 0) {
      console.log("  required: OK (all present)");
    } else {
      anyGap = true;
      console.log(`  required: MISSING ${result.missingRequired.length}`);
      for (const name of result.missingRequired) console.log(`    - MISSING (required): ${name}`);
    }

    if (result.presentForbidden.length === 0) {
      console.log("  forbidden: OK (none present)");
    } else {
      anyGap = true;
      console.log(`  forbidden: VIOLATION ${result.presentForbidden.length}`);
      for (const name of result.presentForbidden) console.log(`    - PRESENT (forbidden): ${name}`);
    }
    console.log("");
  }

  if (anyGap) {
    console.error("Env-parity gate: FAIL - see gaps/violations above.");
    process.exit(1);
  }

  console.log("Env-parity gate: PASS - no missing required vars, no forbidden vars present.");
  process.exit(0);
}

// Only auto-run when executed directly (`node scripts/check-env-parity.mjs ...`), never on import
// - this file is imported by scripts/check-env-parity.test.mjs to unit-test parseVercelEnvLs
// without shelling out to the real Vercel CLI or calling process.exit mid test run.
const isDirectRun = (() => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
