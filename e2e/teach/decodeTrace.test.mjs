import test from "node:test";
import assert from "node:assert/strict";
import { DECODE_TRACE_ORDER, decodeTraceTableRow, evaluateDecodeTriggerOutcome, parseDecodeTraceTrace, summarizeDecodeTrace } from "./decodeTrace.mjs";

test("decode trace exposes only the current path", () => {
  assert.deepEqual(DECODE_TRACE_ORDER, ["cache", "tire_corpus", "retail_corpus", "learned_products", "master_catalog", "gpt_5_4_mini"]);
});

test("parses a GPT result and free cache result", () => {
  const paid = parseDecodeTraceTrace({ providerNames: ["gpt-5.4-mini"], providerStatuses: [{ provider: "gpt-5.4-mini", status: "ok" }], decision: { status: "suggested" }, results: [{ productName: "Widget", brand: "Acme" }] });
  assert.equal(paid.settledSource, "gpt_5_4_mini");
  assert.equal(paid.reachedGpt, true);
  const cached = parseDecodeTraceTrace({ debug: { cached: true } });
  assert.equal(cached.settledSource, "cache");
});

test("table and summary retain latency and path counts", () => {
  const row = decodeTraceTableRow("123", parseDecodeTraceTrace({ debug: { decodePath: "tire-corpus" }, results: [{ productName: "Tire" }], decision: { status: "verified" } }), { latencyMs: 7 });
  assert.equal(row.latencyMs, 7);
  assert.deepEqual(summarizeDecodeTrace([row]), { total: 1, bySource: { tire_corpus: 1 }, reachedGptCount: 0, partialIdentityCount: 0 });
});

test("trigger outcome never silently passes an inert control", () => {
  assert.equal(evaluateDecodeTriggerOutcome({ attemptedCount: 1, triggerAvailableCount: 1, traceCount: 0, apiCallCount: 0 }).outcome, "silent_miss");
});
