import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const lockJson = JSON.parse(readFileSync("package-lock.json", "utf8"));
const vitestConfig = readFileSync("vitest.config.ts", "utf8");
const vitestProfilePaths = {
  "test:parallel": "vitest.parallel.config.ts",
  "test:ci:parallel": "vitest.ci.parallel.config.ts",
  "test:no-browser:parallel": "vitest.no-browser.parallel.config.ts",
};
const vitestProfiles = Object.fromEntries(
  Object.entries(vitestProfilePaths).map(([scriptName, path]) => [scriptName, existsSync(path) ? readFileSync(path, "utf8") : ""]),
);
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
const serialPerformanceSuites = [
  "src/services/import/importPerf.test.ts",
  "src/server/identity/atomicLocalStorage.test.ts",
  "src/server/identity/localIdentityReadModel.test.ts",
  "src/server/identity/readOnlyCandidateSource.test.ts",
  "src/eval/identity/importPerf.test.ts",
];
const applyPerformanceSuite = "src/eval/identity/applyPerf.test.ts";
const ciOnlySuite = "src/server/tire-knowledge/dtHarvestIntegration.test.ts";
const browserOnlySuite = "scripts/__tests__/render-report-pdf.test.mjs";

const testPathsIn = (body) => [...body.matchAll(/"((?:src|scripts)\/[^"\n]+\.test\.(?:ts|mjs))"/g)].map((match) => match[1]);

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

  assert.ok(existsSync(applyPerformanceSuite));
  assert.doesNotMatch(packageJson.scripts?.["test:local-demo"] ?? "", /local-demo-countability/);
  assert.match(vitestConfig, /include: \[[^\]]*"scripts\/\*\*\/\*\.test\.mjs"/s, "broad Vitest must retain script ownership");
  assert.match(vitestConfig, /"scripts\/runtime-contract\.test\.mjs"/, "runtime contract must remain excluded from broad Vitest");
  assert.doesNotMatch(vitestConfig, /"scripts\/local-demo-countability\.test\.mjs"/, "local-demo-countability must remain Vitest-owned");
});

test("Vitest scripts partition every performance suite exactly once and serialize contention-prone files", () => {
  const parallel = packageJson.scripts?.["test:parallel"] ?? "";
  const serial = packageJson.scripts?.["test:perf:serial"] ?? "";
  const apply = packageJson.scripts?.["test:identity-apply-perf"] ?? "";
  const expectedPerformanceExclusions = [...serialPerformanceSuites, applyPerformanceSuite];
  const exportedPerformanceArray = vitestConfig.match(/export const performanceSuitePaths = \[([\s\S]*?)\];/)?.[1] ?? "";
  const exportedPerformanceSuites = testPathsIn(exportedPerformanceArray);

  assert.equal(parallel, "vitest run --config vitest.parallel.config.ts");
  assert.equal(packageJson.scripts?.["test:ci:parallel"], "vitest run --config vitest.ci.parallel.config.ts");
  assert.equal(packageJson.scripts?.["test:no-browser:parallel"], "vitest run --config vitest.no-browser.parallel.config.ts");
  for (const scriptName of Object.keys(vitestProfilePaths)) {
    assert.doesNotMatch(packageJson.scripts?.[scriptName] ?? "", /--exclude\b/, `${scriptName} must not use ineffective CLI exclusions`);
  }
  assert.match(serial, /^vitest run\b/, "test:perf:serial must directly invoke Vitest");
  assert.equal(packageJson.scripts?.test, "npm run test:parallel && npm run test:perf:serial && npm run test:identity-apply-perf");
  assert.equal(packageJson.scripts?.["proof:local"], "tsc --noEmit && npm test");
  assert.deepEqual(exportedPerformanceSuites, expectedPerformanceExclusions, "base config must export the exact ordered performance suite inventory");
  assert.equal(new Set(exportedPerformanceSuites).size, exportedPerformanceSuites.length, "base performance suite inventory must be unique");
  assert.match(vitestConfig, /export const makeVitestConfig = \(unitExtraExcludes: string\[\] = \[\]\) => defineConfig\(/);
  assert.match(vitestConfig, /exclude:\s*\[[\s\S]*?\.\.\.unitExtraExcludes[\s\S]*?\]/, "unit project must append profile exclusions");
  assert.match(vitestConfig, /export default makeVitestConfig\(\);/, "base config must add no profile exclusions by default");

  const profileExpectations = {
    "test:parallel": [],
    "test:ci:parallel": [ciOnlySuite],
    "test:no-browser:parallel": [browserOnlySuite],
  };
  for (const [scriptName, extraExclusions] of Object.entries(profileExpectations)) {
    const source = vitestProfiles[scriptName];
    assert.match(source, /import \{ makeVitestConfig, performanceSuitePaths \} from "\.\/vitest\.config";/, `${scriptName} profile must import the shared factory and base inventory`);
    assert.equal(new Set(testPathsIn(source)).size, testPathsIn(source).length, `${scriptName} profile-specific exclusions must be unique`);
    assert.deepEqual(testPathsIn(source), extraExclusions, `${scriptName} profile must add only its profile-specific exclusions`);
    if (extraExclusions.length === 0) {
      assert.match(source, /export default makeVitestConfig\(performanceSuitePaths\);/);
    } else {
      assert.match(source, /export default makeVitestConfig\(\[\s*\.\.\.performanceSuitePaths,[\s\S]*?\]\);/);
    }
  }
  assert.ok(existsSync(ciOnlySuite), `${ciOnlySuite} must exist`);
  assert.ok(existsSync(browserOnlySuite), `${browserOnlySuite} must exist`);

  for (const suite of serialPerformanceSuites) {
    const escaped = suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.ok(existsSync(suite), `${suite} must exist`);
    assert.equal((serial.match(new RegExp(escaped, "g")) ?? []).length, 1, `${suite} must be reached once by test:perf:serial`);
    assert.doesNotMatch(apply, new RegExp(escaped), `${suite} must not be reached by the apply suite`);
  }
  assert.doesNotMatch(serial, new RegExp(applyPerformanceSuite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "apply performance suite must not be reached by test:perf:serial");
  assert.equal((apply.match(new RegExp(applyPerformanceSuite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1, "apply performance suite must be reached once by its dedicated script");
  assert.match(serial, /--maxWorkers=1\b/);
  assert.match(serial, /--no-file-parallelism\b/);
  assert.equal(apply, `vitest run ${applyPerformanceSuite} --maxWorkers=1 --no-file-parallelism`);
});

test("CI runs the partitioned proof suites in order and isolates the ten-minute apply-perf job", () => {
  const unitOrder = [
    "Run broad unit + dom tests (excluding dtHarvestIntegration)",
    "Run serial performance suites",
    "Run local-demo proof suite",
    "Run tire-demo proof suite",
    "Verify tire metadata refresh preserves the generated payload",
  ].map((label) => workflows.ci.indexOf(label));
  assert.ok(unitOrder.every((offset) => offset >= 0));
  assert.deepEqual([...unitOrder].sort((left, right) => left - right), unitOrder);
  const unitJob = workflows.ci.match(/unit-tests:[\s\S]*?(?=\n  [a-z-]+:)/)?.[0] ?? "";
  const broadStepCommand = unitJob.match(/- name: Run broad unit \+ dom tests \(excluding dtHarvestIntegration\)\s*\n\s*run:\s*([^\n]+)/)?.[1]?.trim();
  assert.equal(broadStepCommand, "npm run test:ci:parallel");
  assert.doesNotMatch(unitJob, /test:ci:parallel\s+--/, "CI must not append dynamic exclusions to the named command");
  assert.match(unitJob, /run:\s*npm run test:perf:serial/);
  assert.match(unitJob, /- name: Install Playwright Chromium\s*\n\s*run:\s*npx playwright install --with-deps chromium/, "CI must provision Chromium while the render-report proof remains CI-owned");
  assert.doesNotMatch(unitJob, /UniversalImportPanel\.fixtures\.test\.tsx/, "tracked stress fixtures must not be excluded");
  assert.doesNotMatch(unitJob, /test:identity-apply-perf/, "apply performance proof belongs only to its dedicated job");
  const applyJob = workflows.ci.match(/identity-apply-perf:[\s\S]*$/)?.[0] ?? "";
  assert.match(applyJob, /timeout-minutes:\s*10[\s\S]*?run:\s*npm run test:identity-apply-perf/);
  assert.doesNotMatch(applyJob, /test:parallel|test:perf:serial/, "apply performance job must remain isolated");
});
