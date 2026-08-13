import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalTrustedPreviewState } from "./terminal.mjs";

const product = { status: "active", verified: true, provisional: false, trustedExactCanonicalId: "trusted-exact:00012345678905" };
test("Preview terminal state accepts nullish local-known decode status only with an active trusted product", () => {
  assert.equal(isTerminalTrustedPreviewState({ event: { status: "known" }, product, reviews: [] }), true);
  assert.equal(isTerminalTrustedPreviewState({ event: { status: "known", decodeStatus: null }, product, reviews: [{ status: "resolved" }] }), true);
  assert.equal(isTerminalTrustedPreviewState({ event: { status: "known", decodeStatus: "none" }, product: { ...product, status: "archived" }, reviews: [] }), false);
  assert.equal(isTerminalTrustedPreviewState({ event: { status: "known", decodeStatus: "none" }, product, reviews: [{ status: "conflict" }] }), false);
  assert.equal(isTerminalTrustedPreviewState({ event: { status: "known", decodeStatus: "none" }, product, reviews: [{ status: "suggested" }] }), false);
});
