import assert from "node:assert/strict";
import test from "node:test";

import { bossArtifactLookupKey, deriveCorpusFixtures, opaqueTrustedExactCanonicalId, redactForReceipt, summarizeMeasuredLatency, trustedExactLatencyGate } from "./fixtures.mjs";

const TEST_INDEX_KEY = "synthetic-index-key-only-never-used-for-artifacts-0001";

const manifest = {
  admittedBossCodes: 2,
  acceptedSpellings: 3,
  nonGtinApprovedRows: 1,
  nonGtinApprovedIdentifiers: 1,
  excludedCasePacks: 1,
  blockedBossPackageKeys: [bossArtifactLookupKey("30029885620210", TEST_INDEX_KEY)],
};

test("deriveCorpusFixtures preserves approved short identifiers and GTIN aliases", () => {
  const fixtures = deriveCorpusFixtures([
    {
      final_status: "accepted", gtin_valid: "true", raw_barcode: "00012345600012",
      normalized_barcode_candidates: "00012345600012|012345600012", matched_stable_product_id: "product-a",
    },
    {
      final_status: "alias", gtin_valid: "false", raw_barcode: "A-12/BC",
      normalized_barcode_candidates: "", matched_stable_product_id: "product-b",
    },
    { final_status: "packaging_code", gtin_valid: "true", raw_barcode: "30029885620210", normalized_barcode_candidates: "30029885620210" },
  ], manifest, { hmacKey: TEST_INDEX_KEY });

  assert.equal(fixtures.spellings.size, 3);
  assert.equal(fixtures.lookupKeys.size, 2);
  assert.equal(fixtures.canonicalProductIds.size, 2);
  assert.equal(fixtures.packageSpellings.size, 1);
  assert.equal(fixtures.spellings.get("A-12/BC")?.lookupKey, "nongtin:A-12/BC");
});

test("deriveCorpusFixtures rejects an accepted spelling that is not canonical-equivalent", () => {
  assert.throws(() => deriveCorpusFixtures([{
    final_status: "accepted", gtin_valid: "true", raw_barcode: "00012345600012",
    normalized_barcode_candidates: "00012345600013", matched_stable_product_id: "product-a",
  }], { ...manifest, admittedBossCodes: 1, acceptedSpellings: 1, nonGtinApprovedRows: 0, nonGtinApprovedIdentifiers: 0, excludedCasePacks: 0, blockedBossPackageKeys: [] }, { hmacKey: TEST_INDEX_KEY }), /canonical-equivalent/);
});

test("opaque trusted exact identity matches the provider contract", () => {
  assert.equal(opaqueTrustedExactCanonicalId("product-a"), "trusted-exact:v1:2898B41B903D0EBB491452B44A103968");
});

test("receipt redaction is an irreversible keyed digest, not a reversible transport encoding", () => {
  const raw = "123456789"; const redacted = redactForReceipt(raw, "fixtures-unit-test-receipt-key");
  assert.match(redacted, /^[A-F0-9]{32}$/); assert.notEqual(redacted, raw); assert.equal(redacted.includes("MTIzNDU2Nzg5"), false);
});

test("trusted exact latency gate excludes only cold first scan and reports fixture-class aggregates", () => {
  const latency = trustedExactLatencyGate([1900, 100, 400, 550]);
  assert.equal(latency.maxPass, true); assert.equal(latency.warmP95Pass, false);
  const classes = summarizeMeasuredLatency([{ code: "a", lookupKey: "nongtin:a" }, { code: "12345678", lookupKey: "00000000000000" }], [1, 2], [3, 4], [2, 2]);
  assert.equal(classes.opaque_nongtin.n, 1); assert.equal(classes.gtin_length_8.n, 1);
});
