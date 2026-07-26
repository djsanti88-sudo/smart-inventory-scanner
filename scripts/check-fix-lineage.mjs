#!/usr/bin/env node
// Fix-lineage guard (prevention item 1, 2026-07-22 failure class).
//
// The 2026-07-22 failure: a deploy candidate was built from a lineage that did NOT contain local
// master's fixes (and specifically not the critical fixes from that round). This script checks a
// candidate ref BEFORE deploy/promote/handoff and fails loudly if either check is not satisfied:
//
//   (a) local `master` must be an ancestor of the candidate ref (git merge-base --is-ancestor).
//       This is the general form of "deploying a lineage that lacks mainline fixes."
//   (b) every commit listed in scripts/fix-lineage-pins.json (if the file exists) must ALSO be an
//       ancestor of the candidate ref. This is a belt-and-suspenders pin for specific critical fixes,
//       so lineage drift is caught even if `master` itself later moves or is rewritten.
//
// Deliberately git-ancestry based (agy's simplification), NOT a hand-maintained SHA manifest of
// "files that must exist" or similar. Ancestry is the actual guarantee we want: every commit reachable
// from master (or a pin) is present in the candidate's history.
//
// Usage:
//   node scripts/check-fix-lineage.mjs [ref]
//     ref defaults to HEAD.
//
// Exit code 0 = lineage OK. Exit code 1 = missing mainline and/or missing pinned commits (message
// names exactly what is missing). Exit code 2 = usage/environment error (not a git repo, bad ref, etc).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PINS_FILE = path.join(__dirname, "fix-lineage-pins.json");

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function gitOk(args) {
  try {
    execFileSync("git", args, { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch (err) {
    if (typeof err.status === "number") return false;
    throw err; // git itself failed to run (not found, bad cwd, etc) - surface it
  }
}

function resolveRef(ref) {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function main() {
  const candidateRef = process.argv[2] || "HEAD";

  // Sanity: must be inside a git work tree.
  if (!gitOk(["rev-parse", "--is-inside-work-tree"])) {
    console.error(`fix-lineage: ERROR - not inside a git repository (cwd resolved to ${REPO_ROOT}).`);
    process.exit(2);
  }

  const candidateSha = resolveRef(candidateRef);
  if (!candidateSha) {
    console.error(`fix-lineage: ERROR - candidate ref "${candidateRef}" does not resolve to a commit.`);
    process.exit(2);
  }

  const failures = [];

  // (a) local master must be an ancestor of the candidate.
  const masterSha = resolveRef("master");
  if (!masterSha) {
    console.error('fix-lineage: ERROR - local ref "master" does not resolve to a commit (no local master branch?).');
    process.exit(2);
  }
  const masterIsAncestor = gitOk(["merge-base", "--is-ancestor", masterSha, candidateSha]);
  if (!masterIsAncestor) {
    failures.push({
      kind: "master",
      sha: masterSha,
      label: `local master (${shortSha(masterSha)})`,
    });
  }

  // (b) optional pinned commits, each independently checked.
  let pins = [];
  if (existsSync(PINS_FILE)) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(PINS_FILE, "utf8"));
    } catch (err) {
      console.error(`fix-lineage: ERROR - failed to parse ${PINS_FILE}: ${err.message}`);
      process.exit(2);
    }
    pins = Array.isArray(raw) ? raw : Array.isArray(raw.pins) ? raw.pins : null;
    if (pins === null) {
      console.error(`fix-lineage: ERROR - ${PINS_FILE} must be a JSON array of commit SHAs, or {"pins": [...]}.`);
      process.exit(2);
    }
  }

  for (const rawPin of pins) {
    const pinRef = typeof rawPin === "string" ? rawPin : rawPin?.sha;
    if (!pinRef) {
      console.error(`fix-lineage: ERROR - malformed pin entry in ${PINS_FILE}: ${JSON.stringify(rawPin)}`);
      process.exit(2);
    }
    const pinSha = resolveRef(pinRef);
    if (!pinSha) {
      failures.push({
        kind: "pin-unresolved",
        sha: pinRef,
        label: `pinned commit "${pinRef}" (not found in this repo)`,
      });
      continue;
    }
    const pinIsAncestor = gitOk(["merge-base", "--is-ancestor", pinSha, candidateSha]);
    if (!pinIsAncestor) {
      failures.push({
        kind: "pin",
        sha: pinSha,
        label: `pinned fix commit ${shortSha(pinSha)}`,
      });
    }
  }

  if (failures.length > 0) {
    console.error("");
    console.error(`fix-lineage: FAIL - candidate ${candidateRef} (${shortSha(candidateSha)}) is missing required commits:`);
    for (const f of failures) {
      console.error(`  - ${f.label}`);
    }
    console.error("");
    console.error(
      "This means the candidate lineage does not contain mainline (master) and/or a commit pinned in " +
        "scripts/fix-lineage-pins.json. This is the exact 2026-07-22 failure class: deploying a branch " +
        "that lacks fixes already on master. Rebase/merge master into the candidate branch (and confirm " +
        "the pinned commits are present) before deploying, promoting, or handing off this ref."
    );
    process.exit(1);
  }

  console.log(
    `fix-lineage: OK - ${candidateRef} (${shortSha(candidateSha)}) contains master (${shortSha(masterSha)})` +
      (pins.length > 0 ? ` and all ${pins.length} pinned fix commit(s).` : ".")
  );
  process.exit(0);
}

main();
