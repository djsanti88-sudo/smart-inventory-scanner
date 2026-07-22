#!/usr/bin/env node
// Thin CLI over src/server/corpusPurge.ts -- one-command quarantine of corpus rows learned from a
// paid decode source (Go-UPC / GPT / Fetch V2). The library (purgeBySource) is what is unit-tested;
// this wrapper only parses args, loads the persisted product/alias store, runs the lib, and prints a
// result table. It NEVER touches the raw decode archive (data/decode-archive/*.jsonl).
//
// WHERE THE STORE LIVES: the persisted product/alias store is the MockDb (src/services/mockDb.ts),
// which persists in the BROWSER under localStorage key `sis-mockdb-v1`. Node has no localStorage, so
// this CLI operates on a JSON SNAPSHOT of MockDbState (the exact object MockDb.snapshot() returns):
// export it from the running app's localStorage, run the purge here, and re-import the written result.
//
// Usage:
//   node scripts/corpus-purge.mjs --source go-upc --dry-run
//   node scripts/corpus-purge.mjs --source gpt --revalidate --store ./mockdb-snapshot.json
//   node scripts/corpus-purge.mjs --source fetchv2                 (purge; writes the store back)
//
// Flags:
//   --source <go-upc|gpt|fetchv2>   required: which provenance to quarantine
//   --dry-run                        count only, mutate nothing (default if no mode flag given)
//   --revalidate                     flag matching rows needsRevalidation:true, delete nothing
//   (no mode flag, no --dry-run)     PURGE: delete matching product + alias rows, then write back
//   --store <path>                   snapshot JSON path (default ./mockdb-snapshot.json)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_TSCONFIG = resolve(__dirname, "corpus-purge.tsconfig.json");

// The lib is TypeScript and guards itself with `import "server-only"` (the correct app boundary).
// This CLI must run under tsx (to transpile the TS) WITH a tsconfig that aliases `server-only` to a
// no-op stub -- otherwise `server-only` throws outside a Next bundler. Run as `node
// scripts/corpus-purge.mjs ...`: on first entry we re-exec ourselves through `npx tsx` with that
// tsconfig, inherit stdio, and exit with the child's code. (Running directly under tsx also works;
// the CORPUS_PURGE_REEXEC guard stops an infinite loop.)
function ensureTsxWithCliTsconfig() {
  if (process.env.CORPUS_PURGE_REEXEC === "1") return; // already inside the re-exec
  const res = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: true, // Windows needs the shell to resolve npx.cmd; harmless on POSIX
    env: { ...process.env, CORPUS_PURGE_REEXEC: "1", TSX_TSCONFIG_PATH: CLI_TSCONFIG },
  });
  process.exit(res.status ?? 1);
}

async function loadLib() {
  const mod = await import(pathToFileURL(resolve(__dirname, "../src/server/corpusPurge.ts")).href);
  return mod.purgeBySource;
}

function parseArgs(argv) {
  const args = { source: null, mode: "dry-run", store: "./mockdb-snapshot.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--revalidate") args.mode = "revalidate";
    else if (a === "--purge") args.mode = "purge";
    else if (a === "--store") args.store = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  // Default to PURGE only when the user passed neither --dry-run nor --revalidate but DID pass a
  // no-op-safe... no: default stays dry-run for safety. Purge requires the explicit absence handled below.
  return args;
}

const VALID_SOURCES = ["go-upc", "gpt", "fetchv2"];

function printTable(source, mode, res) {
  const rows = [
    ["source", source],
    ["mode", mode],
    ["matched", String(res.matched)],
    ["removed", String(res.removed)],
    ["requeued", String(res.requeued)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  const line = "+" + "-".repeat(w + 2) + "+" + "-".repeat(12) + "+";
  console.log(line);
  for (const [k, v] of rows) console.log(`| ${k.padEnd(w)} | ${v.padEnd(10)} |`);
  console.log(line);
}

async function main() {
  ensureTsxWithCliTsconfig();
  const raw = process.argv.slice(2);
  const args = parseArgs(raw);

  if (args.help) {
    console.log("Usage: node scripts/corpus-purge.mjs --source <go-upc|gpt|fetchv2> [--dry-run|--revalidate|--purge] [--store <path>]");
    process.exit(0);
  }
  // If neither --dry-run nor --revalidate nor --purge was given, default to a SAFE dry-run; require an
  // explicit --purge to delete. (parseArgs left mode "dry-run" unless a flag overrode it.)
  const passedPurge = raw.includes("--purge");
  const passedDry = raw.includes("--dry-run");
  const passedReval = raw.includes("--revalidate");
  if (!passedPurge && !passedDry && !passedReval) {
    console.error("No mode flag given -- defaulting to --dry-run (pass --purge to actually delete).");
    args.mode = "dry-run";
  }

  if (!VALID_SOURCES.includes(args.source)) {
    console.error(`--source must be one of ${VALID_SOURCES.join(", ")} (got: ${args.source ?? "none"})`);
    process.exit(2);
  }

  const storePath = resolve(args.store);
  if (!existsSync(storePath)) {
    console.error(`Store snapshot not found: ${storePath}`);
    console.error("Export it from the app: localStorage.getItem('sis-mockdb-v1') -> save as JSON, then pass --store <path>.");
    process.exit(2);
  }

  let store;
  try {
    store = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (e) {
    console.error(`Failed to parse store snapshot ${storePath}:`, e.message);
    process.exit(2);
  }
  store.products = store.products ?? {};
  store.aliases = store.aliases ?? {};

  const purgeBySource = await loadLib();
  const res = purgeBySource({ source: args.source, mode: args.mode, store });

  printTable(args.source, args.mode, res);

  // Persist the mutated store back for the two mutating modes (never for dry-run).
  if (args.mode !== "dry-run") {
    writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
    console.log(`Wrote updated store back to ${storePath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
