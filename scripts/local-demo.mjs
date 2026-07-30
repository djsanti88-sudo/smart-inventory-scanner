#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function buildLocalDemoLaunchPlan({
  argv = [],
  baseEnvironment = process.env,
  ledgerPath = resolve(RUNTIME_ROOT, `egress-${Date.now()}-${process.pid}.jsonl`),
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
  return {
    port,
    ledgerPath: validatedLedgerPath,
    build: { args: ["next", "build"], env: { ...environment } },
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

  const plan = buildLocalDemoLaunchPlan({ argv });
  mkdirSync(dirname(plan.ledgerPath), { recursive: true });
  writeFileSync(plan.ledgerPath, "", { encoding: "utf8", flag: "wx" });

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
