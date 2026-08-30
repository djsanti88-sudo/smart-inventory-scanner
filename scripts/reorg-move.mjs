#!/usr/bin/env node
/**
 * Manifest-driven folder reorganization codemod (Project A).
 *
 * Moves files, then rewrites every `@/...` alias specifier and every raw
 * repo-relative path literal that pointed at them, across source, tests, configs and ignore
 * files. Prints a report of EVERY changed path literal, and flags non-TypeScript string edits
 * separately so the orchestrator reviews those by hand (configs, ignore files, workflows).
 *
 * Usage:
 *   node scripts/reorg-move.mjs <manifest.json> --dry-run
 *   node scripts/reorg-move.mjs <manifest.json> --apply
 *
 * Manifest shape:
 *   { "wave": "authentication",
 *     "moves": [ { "from": "src/lib/auth.ts", "to": "src/authentication/service/auth.ts" } ] }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const BACKSLASH = String.fromCharCode(92);

const [, , manifestPath, mode] = process.argv;
if (!manifestPath || !["--dry-run", "--apply", "--rewrite-only"].includes(mode)) {
  console.error("usage: node scripts/reorg-move.mjs <manifest.json> --dry-run|--apply|--rewrite-only");
  process.exit(2);
}
// --rewrite-only: files are ALREADY at their destinations; just fix references. Needed when a wave
// was applied but some importers were reverted or missed, since --apply refuses to re-run once the
// sources are gone.
const REWRITE_ONLY = mode === "--rewrite-only";
const APPLY = mode === "--apply" || REWRITE_ONLY;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ROOT = process.cwd();

// "src/lib/auth.ts" -> "@/lib/auth". Extensions are dropped for ts/tsx (how they are imported);
// .json keeps its extension because it is imported with one.
const toAlias = (p) => "@/" + p.replace(/^src\//, "").replace(/\.(ts|tsx)$/, "");

// Manifest paths contain only letters, digits, / - _ and . ; the dot is the sole regex metachar.
const escapeDots = (s) => s.split(".").join("[.]");

const rewrites = manifest.moves
  .map((m) => ({ from: toAlias(m.from), to: toAlias(m.to), fromPath: m.from, toPath: m.to }))
  .filter((r) => r.from !== r.to)
  // longest first, so "@/services/auth/authMode" rewrites before "@/services/auth"
  .sort((a, b) => b.from.length - a.from.length);

// NOTE: `docs/` is deliberately NOT scanned. docs/archive/ and docs/superpowers/{plans,reports,specs}
// are DATED HISTORICAL RECORDS - a 2026-07-19 plan must keep citing the paths that existed in July,
// or the record becomes fiction. Living docs (ARCHITECTURE.md, AGENTS.md, COMMANDS.md, README.md) are
// updated deliberately in the final wave, by hand, not mechanically mid-move.
const SCAN_DIRS = ["src", "e2e", "scripts", "testing", "ct", ".github"];
const SCAN_ROOT_FILES = [
  "vitest.config.ts", "vitest.setup.ts", "next.config.ts", "package.json", "tsconfig.json",
  "eslint.config.mjs", ".vercelignore", ".gitignore", ".gitattributes", "firebase.json", "codemap.json",
  ...readdirSync(ROOT).filter((f) => /^playwright.*\.(ts|json)$/.test(f)),
];
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

const SELF = join(ROOT, "scripts", "reorg-move.mjs");

// Enumerated AFTER the move step (see below), never before. Enumerating first was a real defect:
// the list held the OLD paths, so once `git mv` ran, the moved files themselves were unreadable and
// silently skipped - leaving their own imports stale. tsc caught it, but only after the fact.
function collectFiles() {
  return [
    ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...SCAN_ROOT_FILES.map((f) => join(ROOT, f)).filter(existsSync),
    // This file documents example paths in its own header; never rewrite them.
  ].filter((f) => f !== SELF);
}

// --- 1. move ------------------------------------------------------------------------------
const moved = [];
for (const m of manifest.moves) {
  if (REWRITE_ONLY) { moved.push("(already moved) " + m.from + "  ->  " + m.to); continue; }
  if (!existsSync(join(ROOT, m.from))) {
    console.error("MISSING SOURCE: " + m.from);
    process.exit(1);
  }
  if (APPLY) {
    mkdirSync(join(ROOT, dirname(m.to)), { recursive: true });
    // Plain filesystem rename, NOT `git mv`. Sandboxed agent environments often cannot write
    // .git/index.lock, which makes `git mv` fail on the first file and abort the whole wave.
    // A filesystem move is equivalent here: git detects the renames at `git add` time from
    // content similarity, which is what the orchestrator's review relies on anyway.
    renameSync(join(ROOT, m.from), join(ROOT, m.to));
  }
  moved.push(m.from + "  ->  " + m.to);
}

// --- 2. rewrite ---------------------------------------------------------------------------
// Collect here, so in --apply mode the moved files are scanned at their NEW paths and their own
// imports get rewritten too. In --dry-run nothing moved yet, so this is the pre-move tree.
const files = collectFiles();
const changes = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(BACKSLASH).join("/");
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  const original = src;

  // (c) SEGMENT-BUILT paths: join(process.cwd(), ...legacy path segments...).
  // There is no contiguous slash-delimited path string here, so (a) and (b) are both blind
  // to it - and so is tsc, because it is a runtime string. This class has already caused two real
  // breakages in this reorganization. Driven by an explicit `segmentDirs` map in the manifest so the
  // mapping is reviewed, never inferred. Longest source path first, so nested dirs win over parents.
  for (const s of [...(manifest.segmentDirs || [])].sort((a, b) => b.from.length - a.from.length)) {
    const seq = (p) => p.split("/").map((x) => '"' + x + '"');
    const fromRe = new RegExp(seq(s.from).map(escapeDots).join('\\s*,\\s*'), "g");
    src = src.replace(fromRe, (match, offset) => {
      const line = original.slice(0, offset).split("\n").length;
      changes.push({ file: rel, line, before: match, after: seq(s.to).join(", "), kind: "path-segments" });
      return seq(s.to).join(", ");
    });
  }

  for (const r of rewrites) {
    // (a) alias specifier. Lookahead on a non-identifier char so "@/lib/auth" does not
    //     match inside "@/lib/authOther", while "@/lib/auth/x" and "@/lib/auth" both do.
    const aliasRe = new RegExp(escapeDots(r.from) + "(?![A-Za-z0-9_-])", "g");
    // (b) raw repo-relative path literal, as found in configs, ignore files and scripts.
    const pathRe = new RegExp(escapeDots(r.fromPath), "g");
    for (const [re, to, kind] of [[aliasRe, r.to, "alias"], [pathRe, r.toPath, "path-literal"]]) {
      src = src.replace(re, (match, offset) => {
        const line = original.slice(0, offset).split("\n").length;
        changes.push({ file: rel, line, before: match, after: to, kind });
        return to;
      });
    }
  }
  if (src !== original && APPLY) writeFileSync(file, src, "utf8");
}

// --- 3. report ----------------------------------------------------------------------------
const aliasChanges = changes.filter((c) => c.kind === "alias");
const pathChanges = changes.filter((c) => c.kind === "path-literal");
const segChanges = changes.filter((c) => c.kind === "path-segments");
const nonTs = pathChanges.filter((c) => !/\.(ts|tsx)$/.test(c.file));

console.log("\n=== WAVE: " + manifest.wave + "  (" + (APPLY ? "APPLIED" : "DRY RUN") + ") ===");

console.log("\n--- " + moved.length + " files moved ---");
moved.forEach((m) => console.log("  " + m));

const aliasFiles = new Set(aliasChanges.map((c) => c.file));
console.log("\n--- " + aliasChanges.length + " alias rewrites across " + aliasFiles.size + " files ---");
[...aliasFiles].sort().forEach((f) => console.log("  " + f));

console.log("\n--- " + pathChanges.length + " raw path-literal rewrites ---");
pathChanges.forEach((c) => console.log("  " + c.file + ":" + c.line + "  " + c.before + " -> " + c.after));

console.log("\n--- " + segChanges.length + " SEGMENT-BUILT path rewrites (invisible to tsc AND to a text search) ---");
segChanges.forEach((c) => console.log("  " + c.file + ":" + c.line + "  " + c.before + "  ->  " + c.after));

console.log("\n*** " + nonTs.length + " NON-TYPESCRIPT path literals changed - ORCHESTRATOR MUST REVIEW EACH ***");
nonTs.forEach((c) => console.log("  REVIEW  " + c.file + ":" + c.line + "  " + c.before + " -> " + c.after));

// --- 4. relative-import warning -----------------------------------------------------------
// A relative import inside a moved file breaks if its target did not move with it. tsc is the
// backstop, but listing them up front makes a tsc failure instantly explainable.
const relWarn = [];
for (const m of manifest.moves) {
  const target = join(ROOT, APPLY ? m.to : m.from);
  if (!existsSync(target)) continue;
  const body = readFileSync(target, "utf8");
  for (const match of body.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    relWarn.push("  " + m.to + "  imports relative  " + match[1]);
  }
}
if (relWarn.length) {
  console.log("\n*** " + relWarn.length + " relative imports inside moved files - verify none crossed the boundary ***");
  relWarn.forEach((w) => console.log(w));
}

console.log("\nNext: npx tsc --noEmit  then compare vitest list counts to outputs/reorg/baseline-*.txt\n");
