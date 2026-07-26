#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const generatedJsonPath = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

const beforeRaw = readFileSync(generatedJsonPath, "utf8");
const before = JSON.parse(beforeRaw);
const beforeRecordCount = Object.keys(before.barcodeIndex).length;

let namedContradictions = 0;
let invariantContradictions = 0;
for (const row of Object.values(before.barcodeIndex)) {
  const confidence = row.confidence || "";
  if (confidence.startsWith("verified_") && row.source_count === 0) {
    invariantContradictions++;
    if (confidence === "verified_1src_strong" && row.source === "discounttire") {
      namedContradictions++;
    }
  }
}

if (namedContradictions !== 2223) {
  throw new Error(`Expected 2223 named Discount Tire contradictions, found ${namedContradictions}`);
}

let changed = 0;
const fixedRaw = beforeRaw.replace(
  /("[^"]+"\s*:\s*\{[^{}]*"confidence"\s*:\s*"verified_[^"]*"[^{}]*"source_count"\s*:\s*)0([^{}]*\})/g,
  (_match, prefix, suffix) => {
    changed++;
    return `${prefix}1${suffix}`;
  },
);

if (changed !== invariantContradictions) {
  throw new Error(`Replacement count ${changed} did not match invariant contradiction count ${invariantContradictions}`);
}

const after = JSON.parse(fixedRaw);
const afterRecordCount = Object.keys(after.barcodeIndex).length;
if (afterRecordCount !== beforeRecordCount) {
  throw new Error(`Record count changed from ${beforeRecordCount} to ${afterRecordCount}`);
}

let remainingInvariantContradictions = 0;
for (const row of Object.values(after.barcodeIndex)) {
  if ((row.confidence || "").startsWith("verified_") && (row.source_count ?? 0) < 1) {
    remainingInvariantContradictions++;
  }
}
if (remainingInvariantContradictions !== 0) {
  throw new Error(`Remaining verified source_count contradictions: ${remainingInvariantContradictions}`);
}

writeFileSync(generatedJsonPath, fixedRaw);

console.log(`Named Discount Tire contradictions: ${namedContradictions}`);
console.log(`Verified source_count records patched: ${changed}`);
console.log(`Record count before: ${beforeRecordCount}`);
console.log(`Record count after: ${afterRecordCount}`);
