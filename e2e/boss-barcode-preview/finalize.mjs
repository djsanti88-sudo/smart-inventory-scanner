import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPreviewReceipt, isCompletePreviewCleanup, verifyPreviewReceipt } from "./receipt.mjs";
import { previewReporterDraftPath } from "./reporter.mjs";
import { readPreviewRunState } from "./state.mjs";

const EMPTY_CLEANUP = Object.freeze({ attempted: false, complete: false, expectedDeleted: 0, deleted: 0, postcheckRemaining: -1 });
const EMPTY_TESTS = Object.freeze({ passed: 0, failed: 1, skipped: 0, interrupted: 0, timedOut: 0 });
const EMPTY_EVIDENCE = Object.freeze({ lanes: 0, uiEvents: 0, canonicalGroups: 0, unexpectedEgress: 0, coldLatencyP95Ms: null, coldLatencyMaxMs: null, warmP95Ms: null, warmP99Ms: null, warmMaxMs: null });
const RUN_ID = /^boss-preview-[a-z0-9-]{16,64}-\d{3}$/;

function validDraft(draft) {
  const tests = draft?.tests; const evidence = draft?.evidence; const totals = evidence?.totals;
  return draft?.schemaVersion === "1.0.0" && draft.runStatus === "passed" && Number.isSafeInteger(draft.startedAtMs)
    && draft.testsExpected === 20 && draft.testsObserved === 20
    && tests?.passed === 20 && tests.failed === 0 && tests.skipped === 0 && tests.interrupted === 0 && tests.timedOut === 0
    && evidence.complete === true && /^[a-f\d]{64}$/i.test(String(evidence.fingerprint ?? ""))
    && totals?.lanes === 20 && totals.uiEvents === 13_346 && totals.canonicalGroups === 5_316 && totals.unexpectedEgress === 0
    && Number.isFinite(totals.coldLatencyP95Ms) && totals.coldLatencyP95Ms <= 2_000
    && Number.isFinite(totals.coldLatencyMaxMs) && totals.coldLatencyMaxMs <= 2_000
    && Number.isFinite(totals.warmP95Ms) && totals.warmP95Ms <= 500
    && Number.isFinite(totals.warmP99Ms) && totals.warmP99Ms <= 750
    && Number.isFinite(totals.warmMaxMs) && totals.warmMaxMs <= 2_000;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function finalizePreviewReceipt({ runId, targetHost, playwrightExitCode, now = Date.now }) {
  if (!RUN_ID.test(runId)) throw new Error("Preview finalizer run id is invalid.");
  const draft = readJson(previewReporterDraftPath(runId));
  let state = null;
  try { state = readPreviewRunState(runId); } catch { state = null; }
  const cleanup = state?.cleanup ?? EMPTY_CLEANUP;
  const draftValid = validDraft(draft);
  const passed = playwrightExitCode === 0 && draftValid && isCompletePreviewCleanup(cleanup);
  const fingerprint = draftValid && /^[a-f\d]{64}$/i.test(String(draft.evidence.fingerprint ?? ""))
    ? draft.evidence.fingerprint
    : "0".repeat(64);
  const failures = draftValid ? [...(Array.isArray(draft.failures) ? draft.failures : [])] : ["Preview reporter draft is missing or invalid."];
  if (playwrightExitCode !== 0 && failures.length === 0) failures.push("Preview browser certification exited unsuccessfully.");
  if (!isCompletePreviewCleanup(cleanup)) failures.push("Preview cleanup postcheck is incomplete.");
  const receipt = createPreviewReceipt({
    status: passed ? "passed" : "failed", runId,
    manifest: { contentDigest: fingerprint }, targetHost, cleanup,
    totals: {
      testsExpected: draftValid ? draft.testsExpected : 20,
      testsObserved: draftValid ? draft.testsObserved : 0,
      tests: draftValid ? draft.tests : EMPTY_TESTS,
      evidence: draftValid ? draft.evidence.totals : EMPTY_EVIDENCE,
    },
    timings: { elapsedMs: draftValid ? Math.max(0, now() - draft.startedAtMs) : 0 }, failures,
  });
  verifyPreviewReceipt(receipt);
  const dir = resolve("outputs/boss-barcode-certification"); mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `preview-${runId}-${fingerprint.slice(0, 12)}.receipt.json`);
  const temp = resolve(dir, `.preview-final-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); renameSync(temp, target);
  return receipt;
}
