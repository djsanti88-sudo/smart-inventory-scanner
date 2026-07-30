import "server-only";

import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isValidLocalDemoGtin } from "@/server/tire-knowledge/localDemoTrust.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

export type LocalDemoBatchRow = {
  ordinal: number;
  batch: number;
  agent: number;
  barcode: string;
  barcodeType: string;
  canonicalProductUid: string;
  brand: string;
  model: string;
  size: string;
  loadIndex: string;
  speedRating: string;
  manufacturerPartNumber: string;
  type: string;
  season: string;
  sourceCount: number;
  confidence: string;
  currentStatus: string;
  usableFor: string;
  fieldCompletenessScore: number;
  angle: string;
  stratum: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeLocalDemoManifestHash(
  manifest: Record<string, unknown>,
): string {
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  return sha256(JSON.stringify(unsigned));
}

export function computeLocalDemoBatchHashes(rows: LocalDemoBatchRow[]) {
  return {
    batchSha256: sha256(JSON.stringify(rows)),
    expectedBarcodesSha256: sha256(
      JSON.stringify(rows.map((row) => row.barcode)),
    ),
    expectedCanonicalProductUidsSha256: sha256(
      JSON.stringify(rows.map((row) => row.canonicalProductUid)),
    ),
  };
}

export function localDemoPaddingEquivalenceKey(value: string): string {
  const barcode = String(value ?? "").trim();
  if (!isValidLocalDemoGtin(barcode)) return barcode;
  if (
    barcode.length === 13 &&
    barcode.startsWith("0") &&
    isValidLocalDemoGtin(barcode.slice(1))
  ) {
    return barcode.slice(1);
  }
  if (
    barcode.length === 14 &&
    barcode.startsWith("00") &&
    isValidLocalDemoGtin(barcode.slice(2))
  ) {
    return barcode.slice(2);
  }
  return barcode;
}

export function hasExactLocalDemoManifestAllocation(
  rows: LocalDemoBatchRow[],
): boolean {
  if (rows.length !== 3_000) return false;
  const barcodes = new Set<string>();
  const canonicalIds = new Set<string>();
  const equivalenceKeys = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedBatch = Math.floor(index / 100) + 1;
    const expectedAgent = Math.floor(index / 300) + 1;
    const equivalenceKey = localDemoPaddingEquivalenceKey(row.barcode);
    if (
      row.ordinal !== index + 1 ||
      row.batch !== expectedBatch ||
      row.agent !== expectedAgent ||
      barcodes.has(row.barcode) ||
      canonicalIds.has(row.canonicalProductUid) ||
      equivalenceKeys.has(equivalenceKey)
    ) {
      return false;
    }
    barcodes.add(row.barcode);
    canonicalIds.add(row.canonicalProductUid);
    equivalenceKeys.add(equivalenceKey);
  }
  return barcodes.size === 3_000 &&
    canonicalIds.size === 3_000 &&
    equivalenceKeys.size === 3_000;
}

export function readContainedJson(
  rootPath: string,
  candidatePath: string,
  maximumBytes: number,
): unknown {
  const root = realpathSync(rootPath);
  const candidate = resolve(candidatePath);
  if (!isAbsolute(candidate)) throw new Error("Path must be absolute");
  const canonical = realpathSync(candidate);
  const relativePath = relative(root, canonical);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Path escapes evidence root");
  }
  const size = statSync(canonical).size;
  if (size > maximumBytes) throw new Error("Evidence file is too large");
  return JSON.parse(readFileSync(canonical, "utf8"));
}

export function readContainedText(
  rootPath: string,
  candidatePath: string,
  maximumBytes: number,
): string {
  const root = realpathSync(rootPath);
  const candidate = realpathSync(resolve(candidatePath));
  const relativePath = relative(root, candidate);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Path escapes evidence root");
  }
  const size = statSync(candidate).size;
  if (size > maximumBytes) throw new Error("Evidence file is too large");
  return readFileSync(candidate, "utf8");
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
