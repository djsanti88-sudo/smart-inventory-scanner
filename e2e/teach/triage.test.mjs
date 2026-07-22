import test from "node:test";
import assert from "node:assert/strict";
import { confirmReproduction, classifyFailure, buildFinding, TRIAGE_CLASSES, SEVERITIES } from "./triage.mjs";

test("confirmReproduction: reproduced true only when all attempts truthy", async () => {
  const result = await confirmReproduction(async () => true, { times: 2 });
  assert.equal(result.reproduced, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.successes, [true, true]);
});

test("confirmReproduction: reproduced false when any attempt is falsy", async () => {
  let call = 0;
  const reproFn = async () => {
    call += 1;
    return call !== 2; // second attempt fails to reproduce
  };
  const result = await confirmReproduction(reproFn, { times: 2 });
  assert.equal(result.reproduced, false);
  assert.deepEqual(result.successes, [true, false]);
});

test("confirmReproduction: unsafe short-circuits without calling reproFn", async () => {
  let called = false;
  const reproFn = () => {
    called = true;
    return true;
  };
  const result = await confirmReproduction(reproFn, { unsafe: true });
  assert.deepEqual(result, { reproduced: false, attempts: 0, unsafe: true });
  assert.equal(called, false);
});

test("confirmReproduction: a throwing attempt counts as non-reproduced but continues", async () => {
  let call = 0;
  const reproFn = async () => {
    call += 1;
    if (call === 1) throw new Error("boom");
    return true;
  };
  const result = await confirmReproduction(reproFn, { times: 2 });
  assert.equal(result.reproduced, false);
  assert.deepEqual(result.successes, [false, true]);
  assert.equal(call, 2);
});

test("confirmReproduction: default times is 2", async () => {
  let calls = 0;
  await confirmReproduction(() => {
    calls += 1;
    return true;
  });
  assert.equal(calls, 2);
});

test("classifyFailure: envSignal wins first regardless of other flags", () => {
  const result = classifyFailure({ envSignal: true, assertionFailed: true, reproduced: true });
  assert.equal(result, "environment_problem");
});

test("classifyFailure: selectorMissing with no console/network errors -> test_bug", () => {
  const result = classifyFailure({ selectorMissing: true });
  assert.equal(result, "test_bug");
});

test("classifyFailure: selectorMissing but console errors present -> not test_bug", () => {
  const result = classifyFailure({ selectorMissing: true, consoleErrors: ["err"], reproduced: true });
  assert.equal(result, "confirmed_app_bug");
});

test("classifyFailure: reproduced + failure signal -> confirmed_app_bug", () => {
  assert.equal(classifyFailure({ reproduced: true, consoleErrors: ["x"] }), "confirmed_app_bug");
  assert.equal(classifyFailure({ reproduced: true, failedRequests: [{}] }), "confirmed_app_bug");
  assert.equal(classifyFailure({ reproduced: true, assertionFailed: true }), "confirmed_app_bug");
});

test("classifyFailure: failure signal + unsafe (not reproduced) -> probable_app_bug", () => {
  const result = classifyFailure({ assertionFailed: true, unsafe: true, reproduced: false });
  assert.equal(result, "probable_app_bug");
});

test("classifyFailure: failure signal + not reproduced (safe) -> probable_app_bug", () => {
  const result = classifyFailure({ consoleErrors: ["x"], reproduced: false, unsafe: false });
  assert.equal(result, "probable_app_bug");
});

test("classifyFailure: no signals at all -> flaky", () => {
  assert.equal(classifyFailure({}), "flaky");
  assert.equal(classifyFailure(), "flaky");
});

test("buildFinding: throws on invalid severity", () => {
  assert.throws(
    () => buildFinding({ title: "t", category: "c", severity: "nope", triageClass: "confirmed_app_bug" }),
    /Invalid severity/
  );
});

test("buildFinding: throws on invalid triageClass", () => {
  assert.throws(
    () => buildFinding({ title: "t", category: "c", severity: "high", triageClass: "nope" }),
    /Invalid triageClass/
  );
});

test("buildFinding: flags needsSolutionOptions true when options empty", () => {
  const finding = buildFinding({
    title: "Scan row missing",
    category: "ladder",
    severity: "high",
    triageClass: "confirmed_app_bug",
  });
  assert.deepEqual(finding.options, []);
  assert.equal(finding.needsSolutionOptions, true);
});

test("buildFinding: needsSolutionOptions false when options provided", () => {
  const finding = buildFinding({
    title: "Scan row missing",
    category: "ladder",
    severity: "high",
    triageClass: "confirmed_app_bug",
    options: ["fix A", "fix B"],
  });
  assert.equal(finding.needsSolutionOptions, false);
});

test("buildFinding: locked passthrough and evidence shape, no secrets field", () => {
  const finding = buildFinding({
    title: "t",
    category: "c",
    severity: "low",
    triageClass: "test_bug",
    locked: true,
    evidence: { screenshot: "e2e/proof/x.png" },
  });
  assert.equal(finding.locked, true);
  assert.equal(finding.evidence.screenshot, "e2e/proof/x.png");
  assert.equal(finding.evidence.trace, null);
  assert.equal(Object.keys(finding.evidence).sort().join(","), "consoleLog,networkLog,screenshot,trace,video");
});

test("TRIAGE_CLASSES and SEVERITIES export the expected sets", () => {
  assert.deepEqual(TRIAGE_CLASSES, [
    "confirmed_app_bug",
    "probable_app_bug",
    "test_bug",
    "test_data_problem",
    "environment_problem",
    "flaky",
  ]);
  assert.deepEqual(SEVERITIES, ["critical", "high", "medium", "low"]);
});
