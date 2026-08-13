import assert from "node:assert/strict";
import test from "node:test";
import { persistedPreviewLaneIsTrusted } from "./persistence.mjs";

const product = { id: "p1", status: "active", verified: true, provisional: false, trustedExactCanonicalId: "trusted-exact:00012345678905" };
const input = { events: [{ status: "known", matchedProductId: "p1" }], products: [product], counts: [{ productId: "p1", quantity: 1 }], reviews: [], expectedEvents: 1, expectedByCanonical: { "trusted-exact:00012345678905": 1 } };
test("persisted Preview proof accepts Firebase-stripped decodeStatus but rejects archived products and unresolved review states", () => {
  assert.equal(persistedPreviewLaneIsTrusted(input), true);
  assert.equal(persistedPreviewLaneIsTrusted({ ...input, products: [{ ...product, status: "archived" }] }), false);
  assert.equal(persistedPreviewLaneIsTrusted({ ...input, reviews: [{ status: "conflict" }] }), false);
});
