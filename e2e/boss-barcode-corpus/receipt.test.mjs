import assert from "node:assert/strict";
import test from "node:test";
import { createReceipt, redactedCode, verifyReceipt } from "./receipt.mjs";
test("local receipt is self-hashed and does not expose raw code material", () => {
  const raw = "123456789"; const receipt = createReceipt({ status: "passed", aggregate: { code: redactedCode(raw) } });
  verifyReceipt(receipt); assert.equal(JSON.stringify(receipt).includes(raw), false); assert.equal(JSON.stringify(receipt).includes("MTIzNDU2Nzg5"), false);
  assert.throws(() => verifyReceipt({ ...receipt, status: "failed" }), /self-hash/);
});
