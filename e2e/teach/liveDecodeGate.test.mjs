// e2e/teach/liveDecodeGate.test.mjs
//
// Proves the OWNER-GATED live-paid-spend gate on lesson 7
// (live-decode-ladder-trace): without TEACH_ALLOW_LIVE_DECODE=1 the lesson
// must skip BEFORE touching the page/persona/harness (i.e. before any scan,
// any "Look up with AI" click, or any real /api/ai-lookup spend). See
// Codex-19 Finding 3.
import test from "node:test";
import assert from "node:assert/strict";
import lesson from "./lessons/7-live-decode-ladder-trace.mjs";

// A ctx whose live surfaces throw the instant they are touched, so the test
// fails loudly if the gate ever falls through to real work.
function trapCtx() {
  const boom = (name) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`live-decode gate leaked: touched ctx.${name} before opting in`);
        },
      },
    );
  return {
    page: boom("page"),
    h: boom("h"),
    persona: boom("persona"),
    limits: boom("limits"),
    triage: boom("triage"),
    deploymentMode: "live_auth", // even in live_auth, the env gate must win first
  };
}

test("lesson 7 skips (no live spend) when TEACH_ALLOW_LIVE_DECODE is unset", async () => {
  const prev = process.env.TEACH_ALLOW_LIVE_DECODE;
  delete process.env.TEACH_ALLOW_LIVE_DECODE;
  try {
    const result = await lesson.run(trapCtx());
    assert.equal(result.pass, true);
    assert.equal(result.learned.skipped, true);
    assert.equal(result.learned.reason, "live_decode_not_opted_in");
    assert.match(result.notes, /TEACH_ALLOW_LIVE_DECODE=1/);
  } finally {
    if (prev === undefined) delete process.env.TEACH_ALLOW_LIVE_DECODE;
    else process.env.TEACH_ALLOW_LIVE_DECODE = prev;
  }
});

test("lesson 7 skips when TEACH_ALLOW_LIVE_DECODE is set to a non-1 value", async () => {
  const prev = process.env.TEACH_ALLOW_LIVE_DECODE;
  process.env.TEACH_ALLOW_LIVE_DECODE = "0";
  try {
    const result = await lesson.run(trapCtx());
    assert.equal(result.learned.reason, "live_decode_not_opted_in");
  } finally {
    if (prev === undefined) delete process.env.TEACH_ALLOW_LIVE_DECODE;
    else process.env.TEACH_ALLOW_LIVE_DECODE = prev;
  }
});

test("lesson 7 passes the env gate when TEACH_ALLOW_LIVE_DECODE=1 (then stops on next gate, not the env one)", async () => {
  const prev = process.env.TEACH_ALLOW_LIVE_DECODE;
  process.env.TEACH_ALLOW_LIVE_DECODE = "1";
  try {
    // deploymentMode !== 'live_auth' means the SECOND gate returns cleanly
    // without touching page/persona - proving the env gate let execution
    // through to the existing downstream gates rather than short-circuiting.
    const ctx = trapCtx();
    ctx.deploymentMode = "demo_open";
    const result = await lesson.run(ctx);
    assert.equal(result.learned.reason, "not_live_auth");
  } finally {
    if (prev === undefined) delete process.env.TEACH_ALLOW_LIVE_DECODE;
    else process.env.TEACH_ALLOW_LIVE_DECODE = prev;
  }
});
