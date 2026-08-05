import assert from "node:assert/strict";
import test from "node:test";
import { createReceipt, redactedCode, verifyReceipt } from "./receipt.mjs";

const TEST_RECEIPT_HMAC_KEY = "unit-test-only-receipt-key-do-not-use-outside-tests";

test("local receipt uses a domain-separated keyed HMAC and never exposes raw code material", () => {
  const raw = "123456789";
  const codeDigest = redactedCode(raw, TEST_RECEIPT_HMAC_KEY);
  const receipt = createReceipt({ status: "passed", aggregate: { code: codeDigest } }, TEST_RECEIPT_HMAC_KEY);

  assert.match(codeDigest, /^[A-F0-9]{32}$/);
  assert.notEqual(codeDigest, redactedCode(raw, "different-unit-test-key"));
  verifyReceipt(receipt, TEST_RECEIPT_HMAC_KEY);
  assert.equal(JSON.stringify(receipt).includes(raw), false);
  assert.equal(JSON.stringify(receipt).includes("MTIzNDU2Nzg5"), false);
  assert.throws(() => verifyReceipt({ ...receipt, status: "failed" }, TEST_RECEIPT_HMAC_KEY), /self-hash/);
});

test("receipt identifiers reject a missing real-proof HMAC key", () => {
  assert.throws(() => redactedCode("private-code", ""), /BOSS_CERT_RECEIPT_HMAC_KEY/);
  assert.throws(() => createReceipt({ status: "passed" }, ""), /BOSS_CERT_RECEIPT_HMAC_KEY/);
});
