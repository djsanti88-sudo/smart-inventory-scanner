import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizePreviewReceipt } from "./finalize.mjs";
import { verifyPreviewReceipt } from "./receipt.mjs";
import { previewReporterDraftPath } from "./reporter.mjs";
import { writePreviewRunState } from "./state.mjs";

test("finalizes a passing self-hashed receipt only after complete teardown cleanup", () => {
  const prior = process.cwd(); const cwd = mkdtempSync(join(tmpdir(), "boss-preview-finalize-"));
  try {
    process.chdir(cwd);
    const runId = "boss-preview-20260804-finalize-001";
    writePreviewRunState(runId, { cleanup: { attempted: true, complete: true, expectedDeleted: 5, deleted: 5, postcheckRemaining: 0 } });
    const draftPath = previewReporterDraftPath(runId); mkdirSync(join(draftPath, ".."), { recursive: true });
    writeFileSync(draftPath, JSON.stringify({
      schemaVersion: "1.0.0", runStatus: "passed", startedAtMs: 1_000,
      testsExpected: 20, testsObserved: 20,
      tests: { passed: 20, failed: 0, skipped: 0, interrupted: 0, timedOut: 0 },
      evidence: { complete: true, fingerprint: "a".repeat(64), totals: { lanes: 20, uiEvents: 13_346, canonicalGroups: 5_316, unexpectedEgress: 0, coldLatencyP95Ms: 900, coldLatencyMaxMs: 1_000, warmP95Ms: 200, warmP99Ms: 300, warmMaxMs: 400 } },
      failures: [],
    }));
    const receipt = finalizePreviewReceipt({ runId, targetHost: "https://example.vercel.app", playwrightExitCode: 0, now: () => 2_000 });
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.cleanup.postcheckRemaining, 0);
    assert.equal(receipt.timings.elapsedMs, 1_000);
    verifyPreviewReceipt(receipt);
  } finally { process.chdir(prior); rmSync(cwd, { recursive: true, force: true }); }
});

test("fails closed when cleanup or the browser exit is incomplete", () => {
  const prior = process.cwd(); const cwd = mkdtempSync(join(tmpdir(), "boss-preview-finalize-fail-"));
  try {
    process.chdir(cwd);
    const receipt = finalizePreviewReceipt({ runId: "boss-preview-20260804-finalize-002", targetHost: "https://example.vercel.app", playwrightExitCode: 1 });
    assert.equal(receipt.status, "failed");
    verifyPreviewReceipt(receipt);
  } finally { process.chdir(prior); rmSync(cwd, { recursive: true, force: true }); }
});

test("rejects a partial reporter draft even with complete cleanup and exit zero", () => {
  const prior = process.cwd(); const cwd = mkdtempSync(join(tmpdir(), "boss-preview-finalize-partial-"));
  try {
    process.chdir(cwd);
    const runId = "boss-preview-20260804-finalize-003";
    writePreviewRunState(runId, { cleanup: { attempted: true, complete: true, expectedDeleted: 1, deleted: 1, postcheckRemaining: 0 } });
    const draftPath = previewReporterDraftPath(runId); mkdirSync(join(draftPath, ".."), { recursive: true });
    writeFileSync(draftPath, JSON.stringify({ schemaVersion: "1.0.0", runStatus: "passed", startedAtMs: 1, testsExpected: 20, testsObserved: 20, tests: { passed: 20 }, evidence: { complete: true, fingerprint: "a".repeat(64) } }));
    const receipt = finalizePreviewReceipt({ runId, targetHost: "https://example.vercel.app", playwrightExitCode: 0 });
    assert.equal(receipt.status, "failed");
    verifyPreviewReceipt(receipt);
  } finally { process.chdir(prior); rmSync(cwd, { recursive: true, force: true }); }
});
