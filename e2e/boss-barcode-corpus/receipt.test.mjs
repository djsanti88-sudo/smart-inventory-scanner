import assert from "node:assert/strict";
import test from "node:test";
import { createReceipt, redactedCode, verifyReceipt } from "./receipt.mjs";
test("local receipt is self-hashed and does not expose raw code material", () => {
  const receipt = createReceipt({ status: "passed", aggregate: { code: redactedCode("123456789") } });
  verifyReceipt(receipt); assert.equal(JSON.stringify(receipt).includes("123456789"), false);
  assert.throws(() => verifyReceipt({ ...receipt, status: "failed" }), /self-hash/);
});
