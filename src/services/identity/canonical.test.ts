import { describe, expect, it } from "vitest";

import {
  createImportIds,
  normalizeIdentifier,
  validateIdentityInput,
} from "./canonical";
import type { IdentityInput, ScopedIdentifier } from "./types";

const validIdentifier: ScopedIdentifier = {
  type: "vendor_sku",
  raw: "000-7",
  normalized: "000-7",
  namespace: "acme",
  source: "vendor-export",
  evidenceAuthority: "vendor_import",
  evidenceId: "row-1",
  evidenceVersion: "v1",
};

function validInput(overrides: Partial<IdentityInput> = {}): IdentityInput {
  return {
    businessId: "business-1",
    sourceSystem: "vendor-export",
    sourceSignature: "columns-v1",
    vendorId: "acme",
    sourceFileFingerprint: "original-file-a",
    sourceFileOrdinal: 0,
    sheetName: "Inventory",
    sourceRowNumber: 2,
    identifiers: [validIdentifier],
    attributes: {},
    quantity: 1,
    unitOfMeasure: "each",
    rawRecordFingerprint: "raw-row-1",
    ...overrides,
  };
}

const importInput = {
  sanitizedContentRootHash: "sanitized-root-a",
  orderedMappings: [{ sheetName: "Inventory", mapping: { sku: "SKU", quantity: "Qty" } }],
  businessId: "business-1",
  sourceSystem: "vendor-export",
  vendorId: "acme",
  importerVersion: "1",
};

describe("identity canonical contracts", () => {
  it("rejects malformed GTIN identifiers and negative quantities", () => {
    const malformedGtin = validInput({
      identifiers: [{ ...validIdentifier, type: "gtin", raw: "123", normalized: "123" }],
    });

    expect(validateIdentityInput(malformedGtin)).toContain("identifiers[0] has an invalid GTIN");
    expect(validateIdentityInput(validInput({ quantity: -1 }))).toContain(
      "quantity must be a finite non-negative number",
    );
  });

  it("retains leading zeros for vendor SKU normalization", () => {
    expect(normalizeIdentifier("vendor_sku", "000-7")).toBe("000-7");
  });

  it("changes import identity when sanitized content or ordered mappings change", async () => {
    const baseline = await createImportIds(importInput);
    const changedContent = await createImportIds({ ...importInput, sanitizedContentRootHash: "sanitized-root-b" });
    const changedMapping = await createImportIds({
      ...importInput,
      orderedMappings: [{ sheetName: "Inventory", mapping: { sku: "Part #", quantity: "Qty" } }],
    });

    expect(changedContent.importId).not.toBe(baseline.importId);
    expect(changedMapping.importId).not.toBe(baseline.importId);
  });

  it("ignores original-file provenance when deriving import identity", async () => {
    const baseline = await createImportIds(importInput);
    const withChangedProvenance = await createImportIds({
      ...importInput,
      originalFileHashes: ["different-original-file-hash"],
      issuedAt: "2026-07-31T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });

    expect(withChangedProvenance.importId).toBe(baseline.importId);
  });
});
