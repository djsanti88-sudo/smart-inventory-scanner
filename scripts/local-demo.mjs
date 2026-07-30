#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { buildLocalDemoEnvironment } from "./local-demo-environment.mjs";
import { assertLocalDemoDatabase } from "./local-demo-preflight.mjs";

const ROOT = process.cwd();
const RUNTIME_ROOT = resolve(ROOT, "reports/local-tire-demo/runtime");
const GUARD_PATH = resolve(ROOT, "scripts/local-demo-egress-guard.cjs");

export function parseLocalDemoArgs(argv) {
  let port = 3400;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--prod", "--emulator", "--skip-build"].includes(argument)) {
      throw new Error(`Unsupported local demo option: ${argument}`);
    }
    if (argument === "--host" || argument === "--hostname" || argument === "-H"
      || argument.startsWith("--host=") || argument.startsWith("--hostname=")) {
      throw new Error("Local demo host overrides are forbidden; the server is fixed to 127.0.0.1.");
    }
    if (argument === "--port" || argument === "-p") {
      port = Number(argv[++index]);
    } else if (argument.startsWith("--port=")) {
      port = Number(argument.slice("--port=".length));
    } else {
      throw new Error(`Unsupported local demo option: ${argument}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local demo port: ${port}`);
  }
  return { port };
}

function validateLedgerPath(ledgerPath) {
  const resolvedPath = resolve(ledgerPath);
  const pathFromRuntime = relative(RUNTIME_ROOT, resolvedPath);
  if (!pathFromRuntime || pathFromRuntime.startsWith("..") || isAbsolute(pathFromRuntime)) {
    throw new Error(`Local demo egress ledger must be a new file inside ${RUNTIME_ROOT}.`);
  }
  return resolvedPath;
}

const ACTIVE_RUN_KEYS = ["schemaVersion", "runDirectory", "gitSha", "databaseSha256", "manifestSha256", "generatedAt"];

function hasExactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function realPathWithin(rootPath, candidatePath, label) {
  const root = realpathSync(rootPath);
  const candidate = realpathSync(candidatePath);
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Local demo ${label} escaped its evidence root.`);
  }
  return candidate;
}

function readActiveRun(reportsRoot) {
  const canonicalReportsRoot = realpathSync(reportsRoot);
  const activePath = realPathWithin(canonicalReportsRoot, resolve(canonicalReportsRoot, "active-run.json"), "active manifest pointer");
  const active = JSON.parse(readFileSync(activePath, "utf8"));
  if (!hasExactKeys(active, ACTIVE_RUN_KEYS) || active.schemaVersion !== 1 ||
    typeof active.runDirectory !== "string" ||
    !/^[a-f0-9]{40}$/i.test(active.gitSha) ||
    !/^[a-f0-9]{64}$/i.test(active.databaseSha256) ||
    !/^[a-f0-9]{64}$/i.test(active.manifestSha256) ||
    typeof active.generatedAt !== "string" || !Number.isFinite(Date.parse(active.generatedAt))) {
    throw new Error("Local demo requires a valid active manifest run.");
  }
  const runPath = realPathWithin(canonicalReportsRoot, resolve(canonicalReportsRoot, active.runDirectory), "active manifest run");
  return { active, runPath, reportsRoot: canonicalReportsRoot };
}

export function writeLocalDemoRuntimeSession({ reportsRoot = resolve(ROOT, "reports/local-tire-demo"), ledgerPath, gitSha, databaseSha256 }) {
  const { active, runPath, reportsRoot: resolvedReportsRoot } = readActiveRun(reportsRoot);
  const runtimeRoot = realPathWithin(resolvedReportsRoot, resolve(resolvedReportsRoot, "runtime"), "runtime root");
  const resolvedLedgerPath = realPathWithin(runtimeRoot, resolve(ledgerPath), "runtime ledger");
  if (active.gitSha !== gitSha || active.databaseSha256 !== databaseSha256) {
    throw new Error("Local demo active manifest is stale for the current revision or database.");
  }
  if (readFileSync(resolvedLedgerPath, "utf8") !== "") {
    throw new Error("Local demo runtime ledger must be empty when its session is anchored.");
  }
  const sessionPath = resolve(runPath, "runtime-session.json");
  const session = {
    schemaVersion: 1,
    gitSha,
    databaseSha256,
    manifestSha256: active.manifestSha256,
    runDirectory: active.runDirectory,
    ledgerPath: resolvedLedgerPath,
    nonce: randomBytes(24).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(sessionPath, JSON.stringify(session), { encoding: "utf8", flag: "wx" });
  return { sessionPath, nonce: session.nonce };
}

export function buildLocalDemoLaunchPlan({
  argv = [],
  baseEnvironment = process.env,
  ledgerPath = resolve(RUNTIME_ROOT, `egress-${Date.now()}-${process.pid}.jsonl`),
  gitSha,
  databaseSha256,
  runtimeSessionNonce,
} = {}) {
  const { port } = parseLocalDemoArgs(argv);
  const safeEnvironment = buildLocalDemoEnvironment(baseEnvironment);
  const validatedLedgerPath = validateLedgerPath(ledgerPath);
  const requiredGuard = `--require=${JSON.stringify(GUARD_PATH)}`;
  const environment = {
    ...safeEnvironment,
    NODE_OPTIONS: requiredGuard,
    SCANBIN_LOCAL_DEMO_EGRESS_LEDGER: validatedLedgerPath,
  };
  if (gitSha !== undefined) environment.SCANBIN_LOCAL_DEMO_GIT_SHA = String(gitSha);
  if (databaseSha256 !== undefined) environment.SCANBIN_LOCAL_DEMO_DATABASE_SHA256 = String(databaseSha256);
  if (runtimeSessionNonce !== undefined) environment.SCANBIN_LOCAL_DEMO_RUNTIME_SESSION_NONCE = String(runtimeSessionNonce);
  return {
    port,
    ledgerPath: validatedLedgerPath,
    build: { args: ["next", "build", "--webpack"], env: { ...environment } },
    start: {
      args: ["next", "start", "-H", "127.0.0.1", "-p", String(port)],
      env: { ...environment },
    },
  };
}

export function assertEmptyEgressLedger(ledgerPath) {
  const content = readFileSync(ledgerPath, "utf8");
  if (!content.trim()) return [];
  const entries = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      throw new Error(`Malformed local-demo egress ledger at line ${index + 1}; refusing to start.`);
    }
  }
  if (entries.length > 0) {
    throw new Error(`Blocked external egress was attempted during the local-demo build (${entries.length} attempt(s)); refusing to start.`);
  }
  return entries;
}

function runNext(args, environment, options = {}) {
  const nextBin = resolve(ROOT, "node_modules/next/dist/bin/next");
  return spawn(process.execPath, [nextBin, ...args.slice(1)], {
    cwd: ROOT,
    env: environment,
    stdio: "inherit",
    ...options,
  });
}

function waitForConnection(host, port, expectSuccess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = createConnection({ host, port });
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        if (expectSuccess) resolvePromise();
        else rejectPromise(new Error(`Local demo unexpectedly accepted a non-loopback connection on ${host}:${port}.`));
      });
      const failed = () => {
        socket.destroy();
        if (!expectSuccess) resolvePromise();
        else if (Date.now() < deadline) setTimeout(attempt, 100);
        else rejectPromise(new Error(`Local demo did not become reachable at 127.0.0.1:${port}.`));
      };
      socket.once("error", failed);
      socket.once("timeout", failed);
    };
    attempt();
  });
}

async function verifyLoopbackOnly(port) {
  await waitForConnection("127.0.0.1", port, true);
  const nonLoopback = Object.values(networkInterfaces()).flat()
    .find((address) => address && address.family === "IPv4" && !address.internal);
  if (nonLoopback?.address) await waitForConnection(nonLoopback.address, port, false, 1000);
}

async function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal) rejectPromise(new Error(`Child process exited from signal ${signal}.`));
      else resolvePromise(code ?? 1);
    });
  });
}

export async function runLocalDemo(argv = process.argv.slice(2)) {
  let preflight;
  try {
    preflight = assertLocalDemoDatabase();
  } catch (error) {
    if (error instanceof Error && /local tire database is required/i.test(error.message)) {
      throw new Error(`${error.message}\nRemediation: node scripts/provision-worktree.mjs`);
    }
    throw error;
  }

  const gitSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (gitSha.status !== 0 || !/^[a-f0-9]{40}$/i.test(gitSha.stdout.trim())) {
    throw new Error("Local demo requires an exact current Git HEAD revision.");
  }
  const plan = buildLocalDemoLaunchPlan({
    argv,
    gitSha: gitSha.stdout.trim(),
    databaseSha256: preflight.databaseSha256,
  });
  mkdirSync(dirname(plan.ledgerPath), { recursive: true });
  realPathWithin(resolve(ROOT, "reports/local-tire-demo"), dirname(plan.ledgerPath), "runtime directory");
  writeFileSync(plan.ledgerPath, "", { encoding: "utf8", flag: "wx" });
  const runtimeSession = writeLocalDemoRuntimeSession({
    ledgerPath: plan.ledgerPath,
    gitSha: gitSha.stdout.trim(),
    databaseSha256: preflight.databaseSha256,
  });
  plan.build.env.SCANBIN_LOCAL_DEMO_RUNTIME_SESSION_NONCE = runtimeSession.nonce;
  plan.start.env.SCANBIN_LOCAL_DEMO_RUNTIME_SESSION_NONCE = runtimeSession.nonce;

  const build = runNext(plan.build.args, plan.build.env);
  const buildCode = await waitForExit(build);
  if (buildCode !== 0) return buildCode;
  assertEmptyEgressLedger(plan.ledgerPath);

  const server = runNext(plan.start.args, plan.start.env);
  try {
    await verifyLoopbackOnly(plan.port);
    console.log("\u001b[32mLOCAL TIRE DEMO\u001b[0m");
    console.log(`http://localhost:${plan.port}/scan`);
    console.log(`Database SHA-256: ${preflight.databaseSha256}`);
    console.log(`Tire rows: ${preflight.tireCount} (eligible: ${preflight.eligibleTireCount})`);
    console.log("external decode disabled");
  } catch (error) {
    server.kill();
    throw error;
  }
  return waitForExit(server);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runLocalDemo().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
