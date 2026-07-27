import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runVercelDeploy, validatePreviewUrlForSmoke } from "./deploy-preview.mjs";

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.pid = 12345;
  child.killed = false;
  return child;
}

describe("deploy-preview wrapper", () => {
  it("terminates a Windows-style Vercel child that prints completion but never exits, preserving the Preview URL", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killTree = vi.fn(() => {
      child.killed = true;
      child.emit("close", null);
    });
    const spawnImpl = vi.fn(() => child);

    const pending = runVercelDeploy({ spawnImpl, killTree, timeoutMs: 60_000, completeGraceMs: 25 });
    child.stdout.write("Preview         https://inventory-hang-sharpenly.vercel.app\n");
    child.stdout.write("Deployment completed\n");
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      ok: true,
      url: "https://inventory-hang-sharpenly.vercel.app",
      timedOut: true,
    });
    expect(killTree).toHaveBeenCalledWith(12345);
    expect(spawnImpl.mock.calls[0][1]).toEqual(["deploy", "--yes"]);
    expect(spawnImpl.mock.calls[0][1]).not.toContain("--prod");
    vi.useRealTimers();
  });

  it("fails a timeout before Vercel has emitted any Preview URL", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killTree = vi.fn(() => {
      child.killed = true;
      child.emit("close", null);
    });
    const pending = runVercelDeploy({ spawnImpl: () => child, killTree, timeoutMs: 10, completeGraceMs: 1000 });
    child.stdout.write("Building…\n");
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({ ok: false, url: null, timedOut: true });
    expect(killTree).toHaveBeenCalledWith(12345);
    vi.useRealTimers();
  });

  it("fails a global timeout when Vercel emitted a URL but never printed deployment completion", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killTree = vi.fn(() => {
      child.killed = true;
      child.emit("close", null);
    });
    const pending = runVercelDeploy({ spawnImpl: () => child, killTree, timeoutMs: 10, completeGraceMs: 1000 });
    child.stdout.write("Preview         https://inventory-url-before-complete.vercel.app\n");
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({
      ok: false,
      url: "https://inventory-url-before-complete.vercel.app",
      timedOut: true,
    });
    expect(killTree).toHaveBeenCalledWith(12345);
    vi.useRealTimers();
  });

  it("ignores non-Vercel https links in stdout and uses the real deployment URL", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killTree = vi.fn(() => {
      child.killed = true;
      child.emit("close", null);
    });
    const pending = runVercelDeploy({ spawnImpl: () => child, killTree, timeoutMs: 60_000, completeGraceMs: 25 });
    child.stdout.write("Preview         https://inventory-real-sharpenly.vercel.app\n");
    child.stdout.write("Inspect: https://vercel.com/sharpenly/inventory/deploy-log\n");
    child.stdout.write("Docs: https://example.com/some-doc\n");
    child.stdout.write("Deployment completed\n");
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      url: "https://inventory-real-sharpenly.vercel.app",
    });
    vi.useRealTimers();
  });

  it("returns no URL when stdout only contains non-deployment https links", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killTree = vi.fn(() => {
      child.killed = true;
      child.emit("close", null);
    });
    const pending = runVercelDeploy({ spawnImpl: () => child, killTree, timeoutMs: 10, completeGraceMs: 1000 });
    child.stdout.write("Inspect: https://vercel.com/sharpenly/inventory/deploy-log\n");
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({ ok: false, url: null, timedOut: true });
    vi.useRealTimers();
  });

  it("fails closed when a non-dry-run deploy exits successfully without a Preview URL", () => {
    expect(validatePreviewUrlForSmoke({ ok: true, url: null }, { dryRun: false })).toEqual({
      ok: false,
      error: "could not parse a Preview URL from vercel output; refusing to skip smoke fingerprint",
    });
  });

  it("allows dry-run deploy proof without a Preview URL", () => {
    expect(validatePreviewUrlForSmoke({ ok: true, url: null }, { dryRun: true })).toEqual({ ok: true, error: null });
  });
});

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
