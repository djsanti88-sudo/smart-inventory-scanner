import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import * as launcher from "./local-demo.mjs";

test("launcher rejects unsafe modes, host overrides, and skipped builds", () => {
  for (const argument of ["--prod", "--emulator", "--skip-build", "--host=0.0.0.0", "-H"]) {
    assert.throws(() => launcher.parseLocalDemoArgs([argument]), /local demo|unsupported|host|build/i);
  }
});

test("launcher pins a fresh build and loopback-only production server with one inherited ledger", () => {
  const plan = launcher.buildLocalDemoLaunchPlan({
    argv: ["--port", "3456"],
    baseEnvironment: { OPENAI_API_KEY: "secret" },
    ledgerPath: resolve("reports/local-tire-demo/runtime/test-ledger.jsonl"),
  });
  assert.deepEqual(plan.build.args, ["next", "build", "--webpack"]);
  assert.deepEqual(plan.start.args, ["next", "start", "-H", "127.0.0.1", "-p", "3456"]);
  assert.equal(plan.build.env.OPENAI_API_KEY, "");
  assert.equal(plan.start.env.OPENAI_API_KEY, "");
  assert.equal(plan.build.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER, plan.start.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER);
  assert.match(plan.start.env.NODE_OPTIONS, /local-demo-egress-guard\.cjs/);
});

test("launcher binds both build and server to the exact manifest revision and database", () => {
  const gitSha = "a".repeat(40);
  const databaseSha256 = "b".repeat(64);
  const runtimeSessionNonce = "c".repeat(48);
  const plan = launcher.buildLocalDemoLaunchPlan({
    gitSha,
    databaseSha256,
    runtimeSessionNonce,
    ledgerPath: resolve("reports/local-tire-demo/runtime/revision-binding-ledger.jsonl"),
  });
  for (const environment of [plan.build.env, plan.start.env]) {
    assert.equal(environment.SCANBIN_LOCAL_DEMO_GIT_SHA, gitSha);
    assert.equal(environment.SCANBIN_LOCAL_DEMO_DATABASE_SHA256, databaseSha256);
    assert.equal(environment.SCANBIN_LOCAL_DEMO_RUNTIME_SESSION_NONCE, runtimeSessionNonce);
  }
});

test("launcher writes a fresh runtime session bound to its active manifest and ledger", () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "scanbin-runtime-session-"));
  try {
    const gitSha = "a".repeat(40);
    const databaseSha256 = "b".repeat(64);
    const manifestSha256 = "c".repeat(64);
    const runDirectory = "run-1";
    const run = join(reportsRoot, runDirectory);
    const runtime = join(reportsRoot, "runtime");
    mkdirSync(run, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(reportsRoot, "active-run.json"), JSON.stringify({
      schemaVersion: 1, runDirectory, gitSha, databaseSha256, manifestSha256,
      generatedAt: "2026-07-30T00:00:00.000Z",
    }));
    const escapedRoot = mkdtempSync(join(tmpdir(), "scanbin-runtime-escape-"));
    const escapedLedger = join(escapedRoot, "ledger.jsonl");
    writeFileSync(escapedLedger, "");
    const escapedLink = join(runtime, "escaped");
    symlinkSync(escapedRoot, escapedLink, "junction");
    assert.throws(() => launcher.writeLocalDemoRuntimeSession({
      reportsRoot, ledgerPath: join(escapedLink, "ledger.jsonl"), gitSha, databaseSha256,
    }), /escaped/i);
    rmSync(escapedRoot, { recursive: true, force: true });
    const ledgerPath = join(runtime, "egress-test.jsonl");
    writeFileSync(ledgerPath, "");
    const runtimeSession = launcher.writeLocalDemoRuntimeSession({
      reportsRoot, ledgerPath, gitSha, databaseSha256,
    });
    const anchorPath = runtimeSession.sessionPath;
    assert.equal(anchorPath, join(run, "runtime-session.json"));
    const anchor = JSON.parse(readFileSync(anchorPath, "utf8"));
    assert.deepEqual(Object.keys(anchor).sort(), [
      "databaseSha256", "gitSha", "ledgerPath", "manifestSha256", "nonce",
      "runDirectory", "schemaVersion", "startedAt",
    ]);
    assert.equal(anchor.gitSha, gitSha);
    assert.equal(anchor.databaseSha256, databaseSha256);
    assert.equal(anchor.manifestSha256, manifestSha256);
    assert.equal(anchor.ledgerPath, ledgerPath);
    assert.match(anchor.nonce, /^[a-f0-9]{32,}$/);
    assert.equal(runtimeSession.nonce, anchor.nonce);
  } finally {
    rmSync(reportsRoot, { recursive: true, force: true });
  }
});

test("launcher discards a hostile inherited NODE_OPTIONS preload", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-hostile-preload-"));
  try {
    const marker = join(directory, "executed.txt");
    const preload = join(directory, "hostile.cjs");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`);
    const ledger = resolve("reports/local-tire-demo/runtime/hostile-preload-ledger.jsonl");
    const plan = launcher.buildLocalDemoLaunchPlan({
      baseEnvironment: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
      ledgerPath: ledger,
    });
    const child = spawnSync(process.execPath, ["-e", "console.log('safe')"], {
      encoding: "utf8",
      env: plan.build.env,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launcher refuses malformed or non-empty build egress ledgers", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-build-ledger-"));
  try {
    const ledger = join(directory, "ledger.jsonl");
    writeFileSync(ledger, "");
    assert.deepEqual(launcher.assertEmptyEgressLedger(ledger), []);
    writeFileSync(ledger, "{not-json}\n");
    assert.throws(() => launcher.assertEmptyEgressLedger(ledger), /malformed.*egress ledger/i);
    writeFileSync(ledger, `${JSON.stringify({ pid: 1, host: "example.com" })}\n`);
    assert.throws(() => launcher.assertEmptyEgressLedger(ledger), /blocked.*during.*build/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function reservePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPromise(error) : resolvePromise(port));
    });
  });
}

function connectOnce(host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise();
    });
    const reject = (error) => {
      socket.destroy();
      rejectPromise(error);
    };
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error(`Timed out connecting to ${host}:${port}`)));
  });
}

async function waitForLoopback(port, child, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next production server exited before readiness.\n${output()}`);
    }
    try {
      await connectOnce("127.0.0.1", port);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Next production server did not become ready.\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error("Next production server did not terminate cleanly.")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

test("actual guarded Next production server is loopback-only and records blocked worker egress", async () => {
  const fixture = resolve("scripts/fixtures/local-demo-next");
  assert.equal(existsSync(fixture), true, "Task 1 Next production fixture is required");
  const directory = mkdtempSync(join(tmpdir(), "scanbin-next-production-"));
  const appDirectory = join(directory, "app");
  const ledger = join(directory, "egress.jsonl");
  let server;
  try {
    cpSync(fixture, appDirectory, { recursive: true });
    symlinkSync(resolve("node_modules"), join(appDirectory, "node_modules"), "junction");
    writeFileSync(ledger, "");
    const port = await reservePort();
    const plan = launcher.buildLocalDemoLaunchPlan({
      argv: ["--port", String(port)],
      ledgerPath: resolve("reports/local-tire-demo/runtime/next-integration-ledger.jsonl"),
    });
    const environment = {
      ...plan.build.env,
      SCANBIN_LOCAL_DEMO_EGRESS_LEDGER: ledger,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const nextBin = resolve("node_modules/next/dist/bin/next");
    const build = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: appDirectory,
      encoding: "utf8",
      env: environment,
      timeout: 120_000,
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    assert.equal(readFileSync(ledger, "utf8"), "");

    let serverOutput = "";
    server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: appDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; });
    server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForLoopback(port, server, () => serverOutput);

    const response = await fetch(`http://127.0.0.1:${port}/api/canary`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      blocked: true,
      code: "LOCAL_DEMO_EGRESS_BLOCKED",
      guardMarker: 1,
    });

    const externalAddress = Object.values(networkInterfaces()).flat()
      .find((address) => address && address.family === "IPv4" && !address.internal)?.address;
    assert.ok(externalAddress, "A machine non-loopback IPv4 address is required for binding proof");
    await assert.rejects(connectOnce(externalAddress, port));

    const entries = readFileSync(ledger, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].host, "example.com");
    assert.equal(entries[0].path, "/task-1-canary");
    assert.notEqual(entries[0].pid, process.pid);
  } finally {
    if (server) await stopChild(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unguarded local-demo Next startup exits promptly after the missing launcher attestation", async () => {
  const fixture = resolve("scripts/fixtures/local-demo-next");
  const directory = mkdtempSync(join(tmpdir(), "scanbin-next-unguarded-"));
  const appDirectory = join(directory, "app");
  let server;
  try {
    cpSync(fixture, appDirectory, { recursive: true });
    symlinkSync(resolve("node_modules"), join(appDirectory, "node_modules"), "junction");
    const nextBin = resolve("node_modules/next/dist/bin/next");
    const build = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: appDirectory,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      timeout: 120_000,
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const port = await reservePort();
    let output = "";
    server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: appDirectory,
      env: { ...process.env, SCANBIN_LOCAL_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(
        () => rejectPromise(new Error(`Unguarded Next server did not exit after attestation failure.\n${output}`)),
        3_000,
      );
      server.once("exit", (code) => { clearTimeout(timeout); resolvePromise(code); });
    });
    assert.notEqual(exitCode, 0);
    assert.match(output, /Local demo egress guard attestation failed/i);
  } finally {
    if (server) await stopChild(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
