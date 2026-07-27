#!/usr/bin/env node
// provision-worktree.mjs — Build-prevention item 4 ("Never Again" package, fail-loud provisioning).
//
// Root cause it fixes: a fresh `git worktree add` does not carry the generated corpus DB
// (src/server/knowledge.generated.db, ~340MB) or the stress-test fixtures
// (.superpowers/stress/fixtures/), because both are large generated/local-only assets. Without
// them, tests either fail with confusing "file not found" errors, or — worse — knowledgeDb.ts's
// resolveDbPath() falls back to a copy sitting in os.tmpdir() that may be stale/unrelated, which
// manufactured 11-17 phantom test failures in past sessions that looked like real regressions.
//
// This script copies the known-good generated assets from a source checkout (default:
// C:/Users/djsan/inventory, the primary checkout) into the current worktree, verifying sizes
// after each copy so a truncated/failed copy is never silently accepted.
//
// Usage:
//   node scripts/provision-worktree.mjs [--source <path>] [--force]
//
// --source <path>  Source checkout to copy from (default: C:/Users/djsan/inventory, or
//                   PROVISION_WORKTREE_SOURCE env var if set).
// --force          Re-copy even if the destination file/dir already exists and looks fine.

import { existsSync, statSync, copyFileSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = { source: process.env.PROVISION_WORKTREE_SOURCE || "C:/Users/djsan/inventory", force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--force") args.force = true;
  }
  return args;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + "GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + "MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + "KB";
  return n + "B";
}

/** Copy a single file, verify the destination size matches the source. Throws loudly on mismatch. */
function copyFileVerified(src, dest, label) {
  mkdirSync(dirname(dest), { recursive: true });
  const srcSize = statSync(src).size;
  copyFileSync(src, dest);
  const destSize = statSync(dest).size;
  if (destSize !== srcSize) {
    throw new Error(
      `[provision-worktree] Copy verification FAILED for ${label}: source ${fmtBytes(srcSize)} ` +
        `(${srcSize} bytes) but destination is ${fmtBytes(destSize)} (${destSize} bytes) after copy. ` +
        `Destination: ${dest}. Do not trust this file; re-run provisioning.`,
    );
  }
  return { srcSize, destSize };
}

/** Recursively count total bytes under a directory (files only). */
function dirByteTotal(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirByteTotal(p);
    else total += statSync(p).size;
  }
  return total;
}

/** Copy a directory tree, verify total byte count matches. Throws loudly on mismatch. */
function copyDirVerified(src, dest, label) {
  const srcTotal = dirByteTotal(src);
  cpSync(src, dest, { recursive: true, force: true });
  const destTotal = dirByteTotal(dest);
  if (destTotal !== srcTotal) {
    throw new Error(
      `[provision-worktree] Copy verification FAILED for ${label}: source tree ${fmtBytes(srcTotal)} ` +
        `(${srcTotal} bytes) but destination tree is ${fmtBytes(destTotal)} (${destTotal} bytes) after ` +
        `copy. Destination: ${dest}. Do not trust these files; re-run provisioning.`,
    );
  }
  return { srcTotal, destTotal };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source;

  if (!existsSync(source)) {
    console.error(`[provision-worktree] Source checkout not found: ${source}`);
    console.error(`[provision-worktree] Pass --source <path> or set PROVISION_WORKTREE_SOURCE.`);
    process.exit(1);
  }

  if (source === ROOT) {
    console.log(`[provision-worktree] Source and destination are the same checkout (${ROOT}). Nothing to do.`);
    return;
  }

  console.log(`[provision-worktree] Provisioning worktree at ${ROOT}`);
  console.log(`[provision-worktree] Source checkout:          ${source}`);

  const targets = [
    {
      label: "knowledge.generated.db (corpus DB)",
      src: join(source, "src", "server", "knowledge.generated.db"),
      dest: join(ROOT, "src", "server", "knowledge.generated.db"),
      kind: "file",
      required: true,
    },
    {
      label: "knowledge.generated.db.gz (compressed corpus DB)",
      src: join(source, "src", "server", "knowledge.generated.db.gz"),
      dest: join(ROOT, "src", "server", "knowledge.generated.db.gz"),
      kind: "file",
      required: false,
    },
    {
      label: "stress-test fixtures",
      src: join(source, ".superpowers", "stress", "fixtures"),
      dest: join(ROOT, ".superpowers", "stress", "fixtures"),
      kind: "dir",
      required: false,
    },
  ];

  let provisioned = 0;
  let skipped = 0;
  let missing = 0;

  for (const t of targets) {
    if (!existsSync(t.src)) {
      const msg = `[provision-worktree] ${t.required ? "MISSING (required)" : "missing (optional)"}: ${t.label} not found at ${t.src}`;
      if (t.required) {
        console.error(msg);
        missing++;
      } else {
        console.log(msg);
      }
      continue;
    }

    if (!args.force && existsSync(t.dest)) {
      // Cheap sanity check: same size as source means "already provisioned, trust it."
      const srcSize = t.kind === "file" ? statSync(t.src).size : dirByteTotal(t.src);
      const destSize = t.kind === "file" ? statSync(t.dest).size : dirByteTotal(t.dest);
      if (srcSize === destSize) {
        console.log(`[provision-worktree] Already provisioned (size match): ${t.label} (${fmtBytes(destSize)})`);
        skipped++;
        continue;
      }
      console.log(`[provision-worktree] Destination exists but size differs (source ${fmtBytes(srcSize)} vs dest ${fmtBytes(destSize)}) -- re-copying: ${t.label}`);
    }

    console.log(`[provision-worktree] Copying ${t.label}...`);
    const t0 = performance.now();
    const result = t.kind === "file"
      ? copyFileVerified(t.src, t.dest, t.label)
      : copyDirVerified(t.src, t.dest, t.label);
    const ms = Math.round(performance.now() - t0);
    console.log(`[provision-worktree] Provisioned ${t.label}: ${fmtBytes(result.destSize ?? result.destTotal)} in ${ms}ms (verified size match)`);
    provisioned++;
  }

  console.log("");
  console.log(`[provision-worktree] Done. Provisioned: ${provisioned}, already-ok: ${skipped}, missing-required: ${missing}`);

  if (missing > 0) {
    console.error(
      `[provision-worktree] ${missing} required asset(s) could not be provisioned. Tests relying on ` +
        `the corpus DB will fail loud (see src/server/knowledgeDb.ts resolveDbPath) rather than ` +
        `silently using stale data -- that is the safe/expected behavior, but you still need the ` +
        `real asset. Check --source or regenerate via: npm run build:knowledge-db`,
    );
    process.exit(1);
  }
}

main();
