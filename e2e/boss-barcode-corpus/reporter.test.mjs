import assert from "node:assert/strict";
import test from "node:test";
import { redactPersistenceDiagnostic } from "./reporter.mjs";
test("failed-receipt persistence diagnostics retain only aggregate safe categories", () => {
  const result = redactPersistenceDiagnostic({ pending: "Saving: 24", queue: { total: 24, byOperation: { SAVE_PRODUCT: 24 }, byStatus: { error: 24 }, errors: { "Firebase: permission-denied for code 123456789": 24 } }, consoleErrors: ["x"] });
  assert.deepEqual(result.queue.errorCategories, { permission_denied: 24 }); assert.equal(JSON.stringify(result).includes("123456789"), false);
});
test("payload idempotency mismatch has its own safe category", () => {
  const result = redactPersistenceDiagnostic({ queue: { errors: { "payload_idempotency_mismatch: private review 123456789": 3 } } });
  assert.deepEqual(result.queue.errorCategories, { payload_idempotency_mismatch: 3 });
});
