#!/usr/bin/env node
/** Rebuilds the persisted, synthetic-only 5,000-row fixture. No network or provider imports. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(root, "src/eval/identity/fixtures/frozen-5000.v1.json");
const domainSeparator = "identity-import-v1";

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function canonicalSha256(value) {
  return createHash("sha256").update(`${domainSeparator}:${canonicalJson(value)}`).digest("hex");
}

const catalogVersion = "frozen-local-v1";
const rows = Array.from({ length: 5_000 }, (_, index) => {
  const bucket = index % 5;
  const raw = bucket === 4 ? "" : `SYN-${index}`;
  return {
    businessId: "local-perf-shop", sourceSystem: "synthetic", sourceSignature: "scanbin-local-identity-5000",
    vendorId: "synthetic-vendor", sourceFileFingerprint: "persisted-fixture-v1", sourceFileOrdinal: 1,
    sheetName: "Frozen", sourceRowNumber: index + 2,
    ...(bucket === 3 ? { recordType: "service" } : {}),
    ...(bucket < 2 ? { categoryHint: "tire", brand: "Acme", title: "Acme Road 225/65R17" } : {}),
    identifiers: [{ type: "barcode", raw, normalized: raw, namespace: "synthetic-vendor", source: "fixture", evidenceAuthority: "vendor_import", evidenceId: `fixture-${index}`, evidenceVersion: "v1" }],
    attributes: bucket < 2 ? { size: "225/65R17" } : {}, quantity: bucket + 1,
    unitOfMeasure: "each", rawRecordFingerprint: `frozen-${index}`,
  };
});

const barcodeCandidatesWithoutHash = rows.flatMap((row, index) => {
  const bucket = index % 5;
  if (bucket > 1) return [];
  const automatic = bucket === 0;
  const identifier = row.identifiers[0];
  const candidate = {
    productId: `product-${index}`, category: "tire", businessScope: "master",
    verificationTier: automatic ? "exact_code_verified" : "suggested", automaticEligible: automatic,
    evidenceId: `candidate-${index}`, evidenceVersion: "v1", exactCodeEvidence: automatic,
    identifiers: [{ ...identifier, evidenceAuthority: automatic ? "verified_exact_code_corpus" : "unverified_master" }],
    brand: "Acme", title: "Acme Road 225/65R17", attributes: { size: "225/65R17" }, catalogVersion,
  };
  return [[identifier.normalized, [candidate]]];
});
const catalogSnapshotHash = canonicalSha256({
  catalogVersion,
  barcodeCandidates: barcodeCandidatesWithoutHash,
  partNumberCandidates: [],
});
const snapshot = {
  catalogVersion,
  catalogSnapshotHash,
  barcodeCandidates: barcodeCandidatesWithoutHash.map(([key, candidates]) => [key, candidates.map((candidate) => ({ ...candidate, catalogSnapshotHash }))]),
  partNumberCandidates: [],
};
const fixture = {
  fixtureVersion: "identity-frozen-5000-v1", syntheticOnly: true, rowCount: rows.length,
  seed: "scanbin-local-identity-5000", expectedQuantity: 15_000,
  sourceHash: canonicalSha256(rows),
  buckets: [
    { kind: "automatic", rows: 1_000, quantity: 1_000 },
    { kind: "review", rows: 1_000, quantity: 2_000 },
    { kind: "abstain", rows: 1_000, quantity: 3_000 },
    { kind: "non_product", rows: 1_000, quantity: 4_000 },
    { kind: "invalid", rows: 1_000, quantity: 5_000 },
  ],
  rows,
  snapshot,
};
fixture.contentSha256 = canonicalSha256({ rows: fixture.rows, snapshot: fixture.snapshot });
await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ fixturePath, rows: rows.length, candidates: snapshot.barcodeCandidates.length, sourceHash: fixture.sourceHash, catalogSnapshotHash, contentSha256: fixture.contentSha256 })}\n`);
