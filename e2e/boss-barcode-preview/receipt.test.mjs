import assert from "node:assert/strict";
import test from "node:test";

import { createPreviewReceipt, verifyPreviewReceipt } from "./receipt.mjs";

test("Preview receipt is self-hashed, redacted, and cleanup-gated", () => {
  const receipt = createPreviewReceipt({
    status: "passed", runId: "boss-preview-20260804-receipt-001", manifest: { contentDigest: "A".repeat(64) }, targetHost: "preview-123.vercel.app",
    cleanup: { attempted: true, complete: true, expectedDeleted: 33, deleted: 33, postcheckRemaining: 0 }, failures: [new Error("https://secret@preview-123.vercel.app rejected 012345678905")],
  });
  assert.doesNotMatch(JSON.stringify(receipt), /012345678905|preview-123\.vercel\.app/);
  assert.doesNotThrow(() => verifyPreviewReceipt(receipt));
  const cannotOverrideFixedFields = createPreviewReceipt({
    status: "failed", runId: "boss-preview-20260804-receipt-002", manifest: { contentDigest: "B".repeat(64) }, targetHost: "preview-123.vercel.app",
    cleanup: { attempted: false, complete: false, expectedDeleted: 0, deleted: 0, postcheckRemaining: 1 },
    target: "direct", targetHost: "raw-host", manifest: { contentDigest: "not-a-digest" },
  });
  assert.equal(cannotOverrideFixedFields.target, "preview");
  assert.match(cannotOverrideFixedFields.targetHost, /^[A-F\d]{64}$/i);
  assert.equal(cannotOverrideFixedFields.manifest.contentDigest, "not-a-digest");
  assert.throws(() => verifyPreviewReceipt(cannotOverrideFixedFields), /digest/i);
  const cleanupIncomplete = createPreviewReceipt({
    status: "passed", runId: "boss-preview-20260804-receipt-003", manifest: { contentDigest: "A".repeat(64) }, targetHost: "preview-123.vercel.app",
    cleanup: { attempted: true, complete: false, expectedDeleted: 33, deleted: 33, postcheckRemaining: 0 },
  });
  assert.throws(() => verifyPreviewReceipt(cleanupIncomplete), /cleanup/i);
});
