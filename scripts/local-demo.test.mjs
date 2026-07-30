import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
  assert.deepEqual(plan.build.args, ["next", "build"]);
  assert.deepEqual(plan.start.args, ["next", "start", "-H", "127.0.0.1", "-p", "3456"]);
  assert.equal(plan.build.env.OPENAI_API_KEY, "");
  assert.equal(plan.start.env.OPENAI_API_KEY, "");
  assert.equal(plan.build.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER, plan.start.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER);
  assert.match(plan.start.env.NODE_OPTIONS, /local-demo-egress-guard\.cjs/);
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
