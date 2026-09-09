#!/usr/bin/env node
// scripts/check-section.mjs -- npm run check:section [id] [--brief|--gates]
//
// Sections are REVIEW UNITS, not folders. This repo is deliberately NOT reorganized to
// match them: src/server vs src/services vs src/stores is a SECURITY boundary (server-only
// vs client-safe vs client state), and several guards find their targets BY PATH --
// keySafety.transitive.test.ts and the importBoundary tests locate client code with
// /[\\/](components|stores)[\\/]/. Move those directories and the regexes stop matching:
// the tests keep PASSING while checking nothing. A feature-folder reorg would silently
// disarm the very guards that keep API keys out of the browser bundle.
//
// The map lives in codemap.json; docs/ARCHITECTURE.md explains its review sections. This script makes it
// runnable. Handing a subagent `npm run check:section decode` gives it the file globs,
// the invariants it must not break, the traps that have bitten before, and the exact gate
// commands -- which is what the folder layout was being asked to communicate.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MAP = "codemap.json";
if (!existsSync(MAP)) { console.error(`[check-section] ${MAP} not found`); process.exit(1); }
const { sections } = JSON.parse(readFileSync(MAP, "utf8"));

const args = process.argv.slice(2);
const runGates = args.includes("--gates");
const id = args.find((a) => !a.startsWith("--"));

if (!id) {
  console.log("\nSections (npm run check:section <id> [--gates]):\n");
  for (const s of sections) console.log(`  ${s.id.padEnd(12)} ${s.title}\n${" ".repeat(16)}${s.owns}`);
  console.log("\n  --gates   also RUN the section's gate commands (slow)\n");
  process.exit(0);
}

const s = sections.find((x) => x.id === id);
if (!s) { console.error(`[check-section] unknown section "${id}". Known: ${sections.map((x) => x.id).join(", ")}`); process.exit(1); }

const rule = "=".repeat(72);
console.log(`\n${rule}\n${s.title}  (${s.id})\n${rule}\n\n${s.owns}\n`);
console.log("FILES");
for (const g of s.globs) console.log(`  ${g}`);
console.log("\nINVARIANTS -- a change that breaks one of these is a defect, not a tradeoff");
for (const i of s.invariants) console.log(`  - ${i}`);
console.log("\nTRAPS -- these have caused wrong conclusions before");
for (const t of s.traps) console.log(`  - ${t}`);
console.log("\nGATES");
for (const g of s.gates) console.log(`  ${g}`);

if (!runGates) { console.log("\n(pass --gates to run them)\n"); process.exit(0); }

console.log(`\n${rule}\nRUNNING GATES\n${rule}`);
const failed = [];
for (const cmd of s.gates) {
  console.log(`\n--- ${cmd} ---`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) failed.push(cmd);
}
console.log(`\n${rule}`);
if (failed.length) { console.log(`SECTION ${s.id}: FAILED -- ${failed.join(", ")}`); process.exit(1); }
console.log(`SECTION ${s.id}: all gates green`);
