import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/deploy-preview.mjs");

function runDeployPreview(lockPath, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      DEPLOY_PREVIEW_LOCK_PATH: lockPath,
      // Keep tests deterministic and dependency-free; no real deploy tooling should run.
      IS_E2E: "0",
    },
  });
}

function writeLock(lockPath, payload) {
  fs.writeFileSync(lockPath, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

function nowMs() {
  return Date.now();
}

describe("scripts/deploy-preview lock safety", () => {
  it("acquires and releases lock on fresh dry-run invocation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    const result = runDeployPreview(lockPath, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/lock acquired/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects concurrent acquire when another fresh lock exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    writeLock(lockPath, {
      heldBy: "active-session",
      startedAt: nowMs(),
      action: "deploying",
      pid: 12345,
    });
    const result = runDeployPreview(lockPath, ["--dry-run"]);
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/deploy lock acquisition blocked/);
    expect(output).toMatch(/heldBy=active-session/);
    expect(output).toMatch(/pid=12345/);
    expect(output).toMatch(/action=deploying/);
    expect(output).toMatch(/startedAt=/);
  });

  it("rejects malformed lock without force-unlock, without auto-reclaim", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    writeLock(lockPath, "{not-json");
    const result = runDeployPreview(lockPath, ["--dry-run"]);
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/deploy lock acquisition blocked/);
    expect(output).toMatch(/malformed=true/);
  });

  it("rejects stale lock older than 30 minutes without force-unlock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    writeLock(lockPath, {
      heldBy: "stale-session",
      startedAt: nowMs() - (31 * 60 * 1000),
      action: "deploying",
      pid: 99999,
    });
    const result = runDeployPreview(lockPath, ["--dry-run"]);
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/deploy lock acquisition blocked/);
    expect(output).toMatch(/existing stale lock blocked/);
    expect(output).toMatch(/heldBy=stale-session/);
    expect(output).toMatch(/pid=99999/);
  });

  it("allows stale lock to be reclaimed with --force-unlock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    writeLock(lockPath, {
      heldBy: "stale-session",
      startedAt: nowMs() - (45 * 60 * 1000),
      action: "deploying",
      pid: 77777,
    });
    const result = runDeployPreview(lockPath, ["--dry-run", "--force-unlock"]);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/force-unlock requested/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("allows malformed lock to be reclaimed with --force-unlock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-preview-lock-"));
    const lockPath = path.join(dir, "deploy.lock");
    writeLock(lockPath, "{bad-json");
    const result = runDeployPreview(lockPath, ["--dry-run", "--force-unlock"]);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/force-unlock requested/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

