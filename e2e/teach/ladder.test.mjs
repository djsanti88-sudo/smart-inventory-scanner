import test from "node:test";
import assert from "node:assert/strict";
import { parseLadderTrace, ladderTableRow, summarizeLadder, LADDER_ORDER, evaluateDecodeTriggerOutcome } from "./ladder.mjs";

test("LADDER_ORDER is the expected cost-ordered sequence", () => {
  assert.deepEqual(LADDER_ORDER, ["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
});

test("GPT-settled body: reachedGpt true, settledRung gpt", () => {
  const body = {
    debug: {
      ladderPath: "gpt",
      ladderReasons: [
        { rung: "fetchv2", reason: "miss" },
        { rung: "gpt", reason: "settled" },
      ],
    },
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.settledRung, "gpt");
  assert.equal(parsed.reachedGpt, true);
  assert.equal(parsed.gptSkipReason, null);
  assert.equal(parsed.escapedGpt, false);
});

test("corpus hit body: settledRung is corroborationPath, reachedGpt false", () => {
  const body = {
    debug: {
      corroborationPath: "corpus_exact_barcode",
      ladderPath: "none",
    },
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.settledRung, "corpus_exact_barcode");
  assert.equal(parsed.reachedGpt, false);
  assert.equal(parsed.escapedGpt, false);
});

test("GPT-skipped body: reachedGpt false, gptSkipReason set, escapedGpt false", () => {
  const body = {
    debug: {
      ladderPath: "fetchv2",
      ladderReasons: [{ rung: "fetchv2", reason: "settled" }],
      gptLadderSkipReason: "non_public_code_type",
    },
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.settledRung, "fetchv2");
  assert.equal(parsed.reachedGpt, false);
  assert.equal(parsed.gptSkipReason, "non_public_code_type");
  assert.equal(parsed.escapedGpt, false);
});

test("fetchv2 ran but GPT unreachable with no skip reason -> escapedGpt true", () => {
  const body = {
    debug: {
      ladderPath: "fetchv2",
      ladderReasons: [{ rung: "fetchv2", reason: "settled" }],
    },
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.reachedGpt, false);
  assert.equal(parsed.gptSkipReason, null);
  assert.equal(parsed.escapedGpt, true);
});

test("partial-identity body: brand present, model+size missing -> partialIdentity true", () => {
  const body = {
    debug: { ladderPath: "goupc", ladderReasons: [{ rung: "goupc", reason: "settled" }] },
    decision: { status: "suggestion", confidence: 0.5 },
    results: [{ brand: "Falken" }],
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.partialIdentity, true);
  assert.equal(parsed.identity.brand, "Falken");
  assert.equal(parsed.identity.model, null);
  assert.equal(parsed.identity.size, null);
});

test("full identity (brand+model+size) -> partialIdentity false", () => {
  const body = {
    results: [{ brand: "Falken", model: "Wildpeak", size: "265/70R17" }],
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.partialIdentity, false);
});

test("undefined body -> settledRung none, no throw", () => {
  const parsed = parseLadderTrace(undefined);
  assert.equal(parsed.settledRung, "none");
  assert.equal(parsed.reachedGpt, false);
  assert.deepEqual(parsed.reasons, []);
  assert.equal(parsed.cached, false);
  assert.equal(parsed.escapedGpt, false);
});

test("body with no debug object at all -> well-formed default", () => {
  const parsed = parseLadderTrace({ results: [] });
  assert.equal(parsed.settledRung, "none");
  assert.equal(parsed.missReasonCode, null);
});

test("cached flag reads debug.cached and debug.persistedCacheHit", () => {
  assert.equal(parseLadderTrace({ debug: { cached: true } }).cached, true);
  assert.equal(parseLadderTrace({ debug: { persistedCacheHit: true } }).cached, true);
  assert.equal(parseLadderTrace({ debug: {} }).cached, false);
});

test("reachedGpt true via providerStatuses gpt entry with status ok (no ladderReasons)", () => {
  const body = {
    debug: { ladderPath: "gpt" },
    providerStatuses: [{ provider: "gpt-5.5-ladder", status: "ok" }],
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.reachedGpt, true);
});

test("gptSkipReason falls back to providerStatuses errorCode when debug field absent", () => {
  const body = {
    debug: { ladderPath: "fetchv2", ladderReasons: [{ rung: "fetchv2", reason: "settled" }] },
    providerStatuses: [{ provider: "gpt-5.5-ladder", status: "skipped", errorCode: "request_budget_exhausted" }],
  };
  const parsed = parseLadderTrace(body);
  assert.equal(parsed.gptSkipReason, "request_budget_exhausted");
  assert.equal(parsed.reachedGpt, false);
  assert.equal(parsed.escapedGpt, false);
});

test("ladderTableRow flattens a parsed trace", () => {
  const parsed = parseLadderTrace({
    debug: {
      ladderPath: "gpt",
      ladderReasons: [
        { rung: "fetchv2", reason: "miss" },
        { rung: "gpt", reason: "settled" },
      ],
    },
    decision: { status: "verified", confidence: 0.9 },
  });
  const row = ladderTableRow("012345678905", parsed);
  assert.equal(row.code, "012345678905");
  assert.equal(row.settledRung, "gpt");
  assert.equal(row.reachedGpt, true);
  assert.equal(row.confidence, 0.9);
  assert.equal(row.reasonsSummary, "fetchv2:miss; gpt:settled");
});

test("ladderTableRow includes latencyMs when provided", () => {
  const parsed = parseLadderTrace({
    debug: { ladderPath: "gpt", ladderReasons: [{ rung: "gpt", reason: "settled" }] },
  });
  const row = ladderTableRow("012345678905", parsed, { latencyMs: 842 });
  assert.equal(row.latencyMs, 842);
});

test("ladderTableRow defaults latencyMs to null when not provided", () => {
  const parsed = parseLadderTrace({ debug: { ladderPath: "gpt" } });
  const row = ladderTableRow("012345678905", parsed);
  assert.equal(row.latencyMs, null);
});

test("ladderTableRow defaults latencyMs to null when options object has no latencyMs", () => {
  const parsed = parseLadderTrace({ debug: { ladderPath: "gpt" } });
  const row = ladderTableRow("012345678905", parsed, {});
  assert.equal(row.latencyMs, null);
});

test("summarizeLadder aggregates rows", () => {
  const rows = [
    ladderTableRow("a", parseLadderTrace({ debug: { ladderPath: "gpt", ladderReasons: [{ rung: "gpt", reason: "settled" }] } })),
    ladderTableRow("b", parseLadderTrace({ debug: { corroborationPath: "corpus_exact_barcode" } })),
    ladderTableRow("c", parseLadderTrace({ results: [{ brand: "Falken" }] })),
  ];
  const summary = summarizeLadder(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.byRung.gpt, 1);
  assert.equal(summary.byRung.corpus_exact_barcode, 1);
  assert.equal(summary.reachedGptCount, 1);
  assert.equal(summary.partialIdentityCount, 1);
});

test("evaluateDecodeTriggerOutcome: no codes attempted -> unavailable/no_codes_attempted", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 0,
    triggerAvailableCount: 0,
    traceCount: 0,
    apiCallCount: 0,
  });
  assert.deepEqual(result, { outcome: "unavailable", reason: "no_codes_attempted" });
});

test("evaluateDecodeTriggerOutcome: trigger missing for at least one code -> unavailable with supplied reason", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 2,
    triggerAvailableCount: 1,
    traceCount: 0,
    apiCallCount: 0,
    unavailableReason: "ai-status=Off",
  });
  assert.deepEqual(result, { outcome: "unavailable", reason: "ai-status=Off" });
});

test("evaluateDecodeTriggerOutcome: trigger missing with no explicit reason -> default reason", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 1,
    triggerAvailableCount: 0,
    traceCount: 0,
    apiCallCount: 0,
  });
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.reason, "trigger_not_available");
});

test("evaluateDecodeTriggerOutcome: trigger available on every code but zero traces/api calls -> silent_miss", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 2,
    triggerAvailableCount: 2,
    traceCount: 0,
    apiCallCount: 0,
  });
  assert.deepEqual(result, { outcome: "silent_miss", reason: null });
});

test("evaluateDecodeTriggerOutcome: trigger available and at least one trace captured -> triggered", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 2,
    triggerAvailableCount: 2,
    traceCount: 1,
    apiCallCount: 1,
  });
  assert.deepEqual(result, { outcome: "triggered", reason: null });
});

test("evaluateDecodeTriggerOutcome: trigger available and apiCalls alone (no parsed trace) still counts as triggered", () => {
  const result = evaluateDecodeTriggerOutcome({
    attemptedCount: 1,
    triggerAvailableCount: 1,
    traceCount: 0,
    apiCallCount: 1,
  });
  assert.equal(result.outcome, "triggered");
});

test("evaluateDecodeTriggerOutcome: non-finite counters default to 0 without throwing", () => {
  const result = evaluateDecodeTriggerOutcome({});
  assert.deepEqual(result, { outcome: "unavailable", reason: "no_codes_attempted" });
});
