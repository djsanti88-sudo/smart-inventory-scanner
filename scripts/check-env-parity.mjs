#!/usr/bin/env node
// Env-parity gate (never-again decision package item 2, Option M - name check only, no value
// pulling; agy's review flagged local secret-pulling as an avoidable exposure, so this checker
// intentionally never runs `vercel env pull` and never inspects a var's VALUE - only whether the
// NAME is present in the right Vercel environment(s)).
//
// Prevents: a required var (e.g. GO_UPC_API_KEY) silently absent from an environment before a
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
// environment. Vercel's table has columns: name | value | environments | created. We only ever
// read `name` and `environments` - `value` is always the literal string "Encrypted" or "Plain"
// (Vercel never prints the secret itself in `env ls`), so no secret material is parsed or stored.
function parseVercelEnvLs(stdout, targetEnvironment) {
  const names = new Set();
  const lines = stdout.split(/\r?\n/);
  // Vercel prints a capitalized environment label, e.g. "Production", "Preview", "Development".
  const targetLabel = targetEnvironment[0].toUpperCase() + targetEnvironment.slice(1);

  for (const line of lines) {
    // Skip header, blanks, and the "Common next commands" footer block.
    if (!line.trim()) continue;
    if (/^\s*name\s+value\s+environments/i.test(line)) continue;
    if (/^(Vercel CLI|Retrieving project|>|Common next commands|-\s*`vercel)/i.test(line.trim())) continue;

    // Row format (whitespace-column-separated): "<name>   <value-status>   <environments...>   <created>"
    // environments cell can be "Production", "Preview", "Preview, Production", "Development, Preview, Production".
    const trimmed = line.trim();
    if (!trimmed) continue;

    // The name is the first whitespace-delimited token cluster; split on 2+ spaces to respect columns.
    const cols = trimmed.split(/\s{2,}/).filter(Boolean);
    if (cols.length < 3) continue; // not a data row we can parse safely
    const [name, , environmentsCell] = cols;
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue; // guard against stray non-name rows

    if (environmentsCell && environmentsCell.split(",").map((s) => s.trim()).includes(targetLabel)) {
      names.add(name);
    }
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

main();
