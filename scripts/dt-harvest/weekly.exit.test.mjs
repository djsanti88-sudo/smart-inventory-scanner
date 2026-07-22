// Discount Tire harvest: Task 8 Step 1 - signal-kill exit-code resolution tests.
//
// Review finding (CRITICAL): weekly.mjs's runNodeScript/runNodeScriptCapture resolved
// `code ?? 0` in the child "exit" handler. Node's "exit" event fires with (code, signal);
// when a child is killed by a signal, `code` is null and `signal` is set - `code ?? 0`
// fabricated a successful exit 0 for a killed child, so a killed run-batch.mjs or
// discover.mjs would silently read as success, bypassing both the discover-failure abort
// in main() and the batchFailed anomaly flagging.
//
// These tests spawn REAL child node processes (not mocked) through the actual exported
// helpers and kill them with `child.kill("SIGKILL")` via the test-only `onSpawn` hook,
// asserting the resolved code is non-zero. Killing through the ChildProcess handle's own
// `.kill()` method (rather than an unrelated `process.kill(pid, sig)` call, or having the
// child kill itself) is deliberate: on Windows, libuv only attributes a signal to the
// exit event when the kill goes through the ChildProcess handle it created - an external
// `process.kill(pid, "SIGKILL")` or the child self-terminating both come back as
// {code: 1, signal: null} instead, which does NOT reproduce the bug this fix targets.
// Verified empirically while writing this test (see task notes) before settling on this
// approach - it is the only one that reliably reproduces {code: null, signal: "SIGKILL"}
// on this platform, matching the real scenario (a Node-based supervisor/parent killing a
// child it spawned).

import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNodeScript, runNodeScriptCapture } from "./weekly.mjs";

const LONG_RUNNING_SCRIPT = `
setInterval(() => {}, 1000);
console.log("up");
`;

async function writeLongRunningScript(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const scriptPath = path.join(dir, "long-running.mjs");
  await writeFile(scriptPath, LONG_RUNNING_SCRIPT, "utf8");
  return { dir, scriptPath };
}

/** Kills the child shortly after spawn, once it has had time to actually start. */
function killShortlyAfterSpawn(child) {
  setTimeout(() => child.kill("SIGKILL"), 300);
}

describe("runNodeScript - signal-killed children resolve as failure, never a fabricated 0", () => {
  it("resolves a non-zero code when the child is killed by SIGKILL", async () => {
    const { dir, scriptPath } = await writeLongRunningScript("weekly-exit-runscript-");
    try {
      const resolvedCode = await runNodeScript(scriptPath, [], { onSpawn: killShortlyAfterSpawn });
      expect(resolvedCode).not.toBe(0);
      expect(resolvedCode).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10000);
});

describe("runNodeScriptCapture - signal-killed children resolve as failure, never a fabricated 0", () => {
  it("resolves { code: non-zero } when the child is killed by SIGKILL", async () => {
    const { dir, scriptPath } = await writeLongRunningScript("weekly-exit-runcapture-");
    try {
      const { code } = await runNodeScriptCapture(scriptPath, [], { onSpawn: killShortlyAfterSpawn });
      expect(code).not.toBe(0);
      expect(code).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10000);
});

describe("runNodeScript / runNodeScriptCapture - normal (non-killed) exits still behave correctly", () => {
  it("resolves 0 for a script that exits 0 normally (no regression on the happy path)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "weekly-exit-ok-"));
    const scriptPath = path.join(dir, "ok.mjs");
    await writeFile(scriptPath, "process.exit(0);", "utf8");
    try {
      const resolvedCode = await runNodeScript(scriptPath, []);
      expect(resolvedCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10000);

  it("resolves the real non-zero exit code for a script that exits non-zero normally (no signal)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "weekly-exit-fail-"));
    const scriptPath = path.join(dir, "fail.mjs");
    await writeFile(scriptPath, "process.exit(7);", "utf8");
    try {
      const resolvedCode = await runNodeScript(scriptPath, []);
      expect(resolvedCode).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10000);

  it("runNodeScriptCapture resolves { code: 0 } and captures stdout for a normal successful exit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "weekly-exit-capture-ok-"));
    const scriptPath = path.join(dir, "ok.mjs");
    await writeFile(scriptPath, "console.log('hello'); process.exit(0);", "utf8");
    try {
      const { code, stdout } = await runNodeScriptCapture(scriptPath, []);
      expect(code).toBe(0);
      expect(stdout).toContain("hello");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 10000);
});
