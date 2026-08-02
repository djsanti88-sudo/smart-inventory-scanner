import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const lockJson = JSON.parse(readFileSync("package-lock.json", "utf8"));
const vitestConfig = readFileSync("vitest.config.ts", "utf8");
const workflows = {
  ci: readFileSync(".github/workflows/ci.yml", "utf8"),
  playwright: readFileSync(".github/workflows/playwright.yml", "utf8"),
};

const localDemoNodeTests = [
  "scripts/local-demo.test.mjs",
  "scripts/local-demo-egress-guard.test.mjs",
  "scripts/local-demo-environment.test.mjs",
  "scripts/local-demo-preflight.test.mjs",
  "scripts/local-demo-sampler.test.mjs",
];
const tireProofNodeTests = [
  "scripts/tire-demo-proof/generate-manifest.test.mjs",
  "scripts/tire-demo-proof/summarize.test.mjs",
  "scripts/tire-demo-proof/validate-result.test.mjs",
];

test("runtime contract pins supported Node versions in package and lock metadata", () => {
  assert.equal(packageJson.engines?.node, ">=22 <25");
  assert.equal(lockJson.packages?.[""]?.engines?.node, ">=22 <25");
});

test("owned workflows use Node 22 only", () => {
  for (const [name, body] of Object.entries(workflows)) {
    assert.doesNotMatch(body, /node-version:\s*20\b/, `${name} must not pin Node 20`);
    assert.match(body, /node-version:\s*22\b/, `${name} must pin Node 22`);
  }
  const pins = Object.values(workflows).join("\n").match(/node-version:\s*22\b/g) ?? [];
  assert.equal(pins.length, 6, "exactly six Node 22 setup-node pins are required");
});

test("owned workflows restrict the token to read-only repository contents", () => {
  for (const [name, body] of Object.entries(workflows)) {
    const permissionBlock = body.match(/^permissions:\s*\n((?: {2}[^\n]*\n?)*)/m)?.[1];
    assert.ok(permissionBlock, `${name} must set a top-level permissions block`);
    assert.equal(permissionBlock.trim(), "contents: read", `${name} must grant only contents: read`);
  }
});

test("every action reference in owned workflows is immutable and has the expected inventory", () => {
  const actionRefs = (body) => [...body.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  const inventories = {
    ci: {
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683": 5,
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020": 5,
      "actions/cache@5a3ec84eff668545956fd18022155c47e93e2684": 1,
    },
    playwright: {
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683": 1,
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020": 1,
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02": 1,
    },
  };

  for (const [name, inventory] of Object.entries(inventories)) {
    const refs = actionRefs(workflows[name]);
    assert.equal(refs.length, Object.values(inventory).reduce((total, value) => total + value, 0));
    for (const ref of refs) assert.match(ref, /^[^@\s]+@[0-9a-f]{40}$/i, `${ref} must be SHA pinned`);
    for (const [ref, expectedCount] of Object.entries(inventory)) {
      assert.equal(refs.filter((value) => value === ref).length, expectedCount, `${name} must retain ${expectedCount} ${ref} references`);
    }
  }
});

test("named proof scripts reach the exact formerly-orphaned Node suites", () => {
  for (const [script, files] of Object.entries({
    "test:local-demo": localDemoNodeTests,
    "test:tire-demo-proof": tireProofNodeTests,
  })) {
    const command = packageJson.scripts?.[script];
    assert.match(command ?? "", /^node --test\b/, `${script} must directly invoke node:test`);
    for (const file of files) {
      assert.ok(existsSync(file), `${file} must exist`);
      const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.equal((command.match(new RegExp(escapedFile, "g")) ?? []).length, 1, `${script} must reach ${file} exactly once`);
      assert.match(vitestConfig, new RegExp(`"${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `${file} must stay excluded from broad Vitest`);
    }
  }

  assert.equal(packageJson.scripts?.["test:identity-apply-perf"], "vitest run src/eval/identity/applyPerf.test.ts --maxWorkers=1");
  assert.ok(existsSync("src/eval/identity/applyPerf.test.ts"));
  assert.doesNotMatch(packageJson.scripts?.["test:local-demo"] ?? "", /local-demo-countability/);
  assert.match(vitestConfig, /include: \[[^\]]*"scripts\/\*\*\/\*\.test\.mjs"/s, "broad Vitest must retain script ownership");
  assert.match(vitestConfig, /"scripts\/runtime-contract\.test\.mjs"/, "runtime contract must remain excluded from broad Vitest");
  assert.doesNotMatch(vitestConfig, /"scripts\/local-demo-countability\.test\.mjs"/, "local-demo-countability must remain Vitest-owned");
});

test("CI runs the complete proof suite in order and isolates the ten-minute apply-perf job", () => {
  const unitOrder = [
    "Run unit + dom tests (excluding local-only DB/fixture-dependent suites)",
    "Run local-demo proof suite",
    "Run tire-demo proof suite",
    "Verify tire metadata refresh preserves the generated payload",
  ].map((label) => workflows.ci.indexOf(label));
  assert.ok(unitOrder.every((offset) => offset >= 0));
  assert.deepEqual([...unitOrder].sort((left, right) => left - right), unitOrder);
  assert.match(workflows.ci, /identity-apply-perf:[\s\S]*?timeout-minutes:\s*10[\s\S]*?run:\s*npm run test:identity-apply-perf/);
});
