#!/usr/bin/env node
// scripts/deploy-preview.mjs
//
// THE ONLY SANCTIONED DEPLOY PATH for preview deploys in this repo.
//
// Why this exists: multiple parallel Claude Code sessions can touch this repo's deploy surface at
// once with no shared awareness of what any other session already did. On 2026-07-22 that caused a
// preview-only branch to reach production and four already-shipped fixes to go missing from the
// lineage that actually got deployed. See scratchpad/never-again-decision-package.md item 5 (deploy
// lock) + item 1 (fix-lineage guard) for the full incident writeup and design rationale.
//
// What this wrapper does, in order:
//   1. Acquire an exclusive deploy lock (.deploy-lock at repo root) so only one session can be
//      mid-deploy at a time. Stale locks (> 30 min old) are treated as abandoned and reclaimed.
//   2. Run whatever preflight gates exist: scripts/check-fix-lineage.mjs and
//      scripts/check-env-parity.mjs. Both are being built by parallel agents as of this writing, so
//      their absence is tolerated with a warning, not a hard failure -- once they land, they start
//      gating automatically with no change needed here.
//   3. Run `vercel deploy` (PREVIEW ONLY -- this script must never pass --prod; that stays a
//      manual, explicitly-approved action per CLAUDE.md's No-Deploy Rule).
//   4. Run scripts/smoke-fingerprint.mjs against the freshly deployed preview URL, if present.
//   5. Release the lock (always, even on failure -- see the finally-style cleanup below).
//
// Usage:
//   node scripts/deploy-preview.mjs                 real preview deploy
//   node scripts/deploy-preview.mjs --dry-run        exercises lock + preflight logic only, never
//                                                     shells out to `vercel` or any network call
//
// Sets DEPLOY_WRAPPER=1 in the child `vercel` process's environment. This is a marker the
// companion hookify rule (.claude/hookify.deploy-lock.local.md, main repo only, untracked-local)
// uses to distinguish "vercel deploy run through this wrapper" from "raw vercel deploy run
// directly in a Bash tool call" -- see that file's own doc-comment for the honest limitation on
// how well a regex-based hook can actually detect the marker.
//
// Node built-ins only. No new dependencies.

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const LOCK_PATH = path.join(REPO_ROOT, ".deploy-lock");
const STALE_MS = 30 * 60 * 1000; // 30 minutes

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function log(msg) {
  console.log(`[deploy-preview] ${msg}`);
}
function warn(msg) {
  console.warn(`[deploy-preview] WARNING: ${msg}`);
}
function fail(msg) {
  console.error(`[deploy-preview] FAILED: ${msg}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 1. Deploy lock
// ---------------------------------------------------------------------------

/** Reads the lock file, returns parsed JSON or null if absent/corrupt. */
function readLock() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null; // corrupt lock file is treated as no lock (fail open, not closed)
  }
}

/** Returns true if the given lock record is older than STALE_MS. */
function isStale(lock) {
  if (!lock || typeof lock.startedAt !== "number") return true;
  return Date.now() - lock.startedAt > STALE_MS;
}

/**
 * Acquires the deploy lock for this session. Returns the lock record on success, or null if
 * another session genuinely holds a fresh lock (caller should abort).
 */
function acquireLock(sessionId) {
  const existing = readLock();
  if (existing && !isStale(existing)) {
    return null; // someone else holds a live lock
  }
  if (existing && isStale(existing)) {
    warn(
      `reclaiming stale lock held by session ${existing.heldBy} since ` +
        `${new Date(existing.startedAt).toISOString()} (> 30 min old)`
    );
  }
  const record = {
    heldBy: sessionId,
    startedAt: Date.now(),
    action: "deploying",
    pid: process.pid,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(record, null, 2));
  return record;
}

/** Releases the lock ONLY if it is still held by this session (avoid releasing someone else's). */
function releaseLock(sessionId) {
  const existing = readLock();
  if (!existing) return;
  if (existing.heldBy !== sessionId) {
    warn(
      `lock is held by a different session (${existing.heldBy}), not releasing ` +
        `(expected ${sessionId})`
    );
    return;
  }
  try {
    unlinkSync(LOCK_PATH);
    log("lock released");
  } catch (e) {
    warn(`could not remove lock file: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Preflight gates (tolerate absence -- parallel agents are still building these)
// ---------------------------------------------------------------------------

/**
 * Runs a preflight script if it exists. Returns { ran, ok } -- ran=false means the script was
 * absent (warn only, never a hard failure); ok=false with ran=true means it exists and failed
 * (hard failure, deploy must not proceed).
 */
function runPreflight(scriptRelPath, label) {
  const full = path.join(REPO_ROOT, scriptRelPath);
  if (!existsSync(full)) {
    warn(`${label} not found at ${scriptRelPath} -- skipping (tolerated: still being built)`);
    return { ran: false, ok: true };
  }
  log(`running ${label} (${scriptRelPath})...`);
  if (DRY_RUN) {
    log(`  [dry-run] would execute: node ${scriptRelPath}`);
    return { ran: true, ok: true };
  }
  const result = spawnSync(process.execPath, [full], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  const ok = result.status === 0;
  if (!ok) {
    fail(`${label} exited with status ${result.status}`);
  } else {
    log(`${label} passed`);
  }
  return { ran: true, ok };
}

// ---------------------------------------------------------------------------
// 3. vercel deploy (preview only)
// ---------------------------------------------------------------------------

function runVercelDeploy() {
  if (DRY_RUN) {
    log("[dry-run] would execute: vercel deploy   (NEVER --prod)");
    return { ok: true, url: "https://dry-run-fake-preview.vercel.app" };
  }
  log("running `vercel deploy` (preview)...");
  const result = spawnSync("vercel", ["deploy"], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_WRAPPER: "1" },
  });
  const stdout = result.stdout || "";
  process.stdout.write(stdout);
  const ok = result.status === 0;
  // `vercel deploy` prints the deployment URL as the last non-empty line of stdout.
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const urlLine = [...lines].reverse().find((l) => /^https:\/\//.test(l));
  return { ok, url: urlLine || null };
}

// ---------------------------------------------------------------------------
// 4. Post-deploy smoke fingerprint (tolerate absence, same as preflight)
// ---------------------------------------------------------------------------

function runSmokeFingerprint(url) {
  const scriptRelPath = "scripts/smoke-fingerprint.mjs";
  const full = path.join(REPO_ROOT, scriptRelPath);
  if (!existsSync(full)) {
    warn(`${scriptRelPath} not found -- skipping post-deploy smoke fingerprint (tolerated)`);
    return { ran: false, ok: true };
  }
  if (!url) {
    warn("no deploy URL available -- skipping smoke fingerprint");
    return { ran: false, ok: true };
  }
  log(`running smoke fingerprint against ${url}...`);
  if (DRY_RUN) {
    log(`  [dry-run] would execute: node ${scriptRelPath} ${url}`);
    return { ran: true, ok: true };
  }
  const result = spawnSync(process.execPath, [full, url], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  const ok = result.status === 0;
  if (!ok) {
    fail(`smoke fingerprint failed against ${url}`);
  } else {
    log("smoke fingerprint passed");
  }
  return { ran: true, ok };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const sessionId = `${process.env.USERNAME || process.env.USER || "session"}-${process.pid}-${randomUUID().slice(0, 8)}`;

  log(DRY_RUN ? "DRY RUN -- no vercel/network calls will be made" : "starting preview deploy");
  log(`session id: ${sessionId}`);

  const lock = acquireLock(sessionId);
  if (!lock) {
    const existing = readLock();
    fail(
      `deploy lock is held by another session (${existing?.heldBy}, started ` +
        `${existing ? new Date(existing.startedAt).toISOString() : "unknown"}). ` +
        `Refusing to proceed -- wait for it to finish or release, or ask the owner.`
    );
    process.exit(1);
  }
  log(`lock acquired (${LOCK_PATH})`);

  let exitCode = 0;
  try {
    const lineage = runPreflight("scripts/check-fix-lineage.mjs", "fix-lineage guard");
    if (lineage.ran && !lineage.ok) {
      exitCode = 1;
      return;
    }

    const envParity = runPreflight("scripts/check-env-parity.mjs", "env-parity gate");
    if (envParity.ran && !envParity.ok) {
      exitCode = 1;
      return;
    }

    const deploy = runVercelDeploy();
    if (!deploy.ok) {
      fail("vercel deploy failed");
      exitCode = 1;
      return;
    }
    if (deploy.url) {
      log(`preview deployed: ${deploy.url}`);
    } else if (!DRY_RUN) {
      warn("could not parse a deployment URL from vercel output -- smoke fingerprint will be skipped");
    }

    const smoke = runSmokeFingerprint(deploy.url);
    if (smoke.ran && !smoke.ok) {
      exitCode = 1;
      return;
    }

    log(DRY_RUN ? "DRY RUN complete -- lock + preflight logic exercised, nothing deployed" : "deploy-preview complete");
  } finally {
    releaseLock(sessionId);
    process.exitCode = exitCode;
  }
}

main();
