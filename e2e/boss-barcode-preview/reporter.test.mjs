import assert from "node:assert/strict";
import test from "node:test";

import { summarizePreviewAttachments, summarizePreviewResults } from "./reporter.mjs";

test("Preview reporter rejects skipped, failed, and partial lane runs", () => {
  assert.equal(summarizePreviewResults([{ status: "passed" }], 1).complete, true);
  assert.equal(summarizePreviewResults([{ status: "passed" }, { status: "skipped" }], 2).complete, false);
  assert.equal(summarizePreviewResults([{ status: "passed" }], 2).complete, false);
  assert.equal(summarizePreviewResults([{ status: "failed" }], 1).complete, false);
});

test("Preview reporter requires all 20 attached lanes, exact totals, fingerprint, egress, latency and cleanup", () => {
  const fingerprint = "a".repeat(64);
  const laneAttachments = Array.from({ length: 20 }, (_, lane) => ({
    name: "boss-preview-lane-summary",
    body: Buffer.from(JSON.stringify({ lane, uiEvents: lane < 6 ? 668 : 667, canonicalGroups: lane < 16 ? 266 : 265, fingerprint, unexpectedEgress: 0, unauthenticatedStatus: 401, crossTenantStatus: 403, coldLatencyMs: 900, warmLatenciesMs: Array.from({ length: 3 }, () => 300) })),
  }));
  const cleanup = { name: "boss-preview-cleanup", body: Buffer.from(JSON.stringify({ attempted: true, complete: true, expectedDeleted: 64, deleted: 64, postcheckRemaining: 0 })) };
  const good = summarizePreviewAttachments([{ attachments: [...laneAttachments, cleanup] }]);
  assert.equal(good.complete, true);
  assert.equal(good.totals.uiEvents, 13_346);
  assert.equal(good.totals.canonicalGroups, 5_316);
  assert.equal(summarizePreviewAttachments([{ attachments: laneAttachments.slice(1).concat(cleanup) }]).complete, false);
  const egress = JSON.parse(laneAttachments[0].body.toString()); egress.unexpectedEgress = 1;
  laneAttachments[0].body = Buffer.from(JSON.stringify(egress));
  assert.equal(summarizePreviewAttachments([{ attachments: [...laneAttachments, cleanup] }]).complete, false);
});

test("Preview reporter fails closed for absent per-scan timing evidence and slow cold or warm scans", () => {
  const fingerprint = "b".repeat(64);
  const attachment = (lane, coldLatencyMs, warm) => ({ name: "boss-preview-lane-summary", body: Buffer.from(JSON.stringify({ lane, uiEvents: lane < 6 ? 668 : 667, canonicalGroups: lane < 16 ? 266 : 265, fingerprint, unexpectedEgress: 0, unauthenticatedStatus: 401, crossTenantStatus: 403, coldLatencyMs, warmLatenciesMs: warm ? Array.from({ length: 3 }, () => warm) : undefined })) });
  const cleanup = { name: "boss-preview-cleanup", body: Buffer.from(JSON.stringify({ attempted: true, complete: true, expectedDeleted: 64, deleted: 64, postcheckRemaining: 0 })) };
  assert.equal(summarizePreviewAttachments([{ attachments: [...Array.from({ length: 20 }, (_, lane) => attachment(lane, 900, 300)), cleanup] }]).complete, true);
  assert.equal(summarizePreviewAttachments([{ attachments: [...Array.from({ length: 20 }, (_, lane) => attachment(lane, lane === 0 ? 2_001 : 900, 300)), cleanup] }]).complete, false);
  assert.equal(summarizePreviewAttachments([{ attachments: [...Array.from({ length: 20 }, (_, lane) => attachment(lane, 900, lane === 0 ? 751 : 300)), cleanup] }]).complete, false);
  assert.equal(summarizePreviewAttachments([{ attachments: [...Array.from({ length: 20 }, (_, lane) => attachment(lane, 900, lane ? 300 : null)), cleanup] }]).complete, false);
});
