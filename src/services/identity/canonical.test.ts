import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  createImportIds,
  normalizeIdentifier,
  validateIdentityInput,
} from "./canonical";
import type { AggregateImportEvent, IdentityInput, ScopedIdentifier } from "./types";

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

const aggregateImportEvent = {
  kind: "aggregate_import",
  eventId: "event-1",
  idempotencyKey: "key-1",
  fingerprint: "fingerprint-1",
  importId: "import-1",
  rowId: "row-1",
  businessId: "business-1",
  productId: "product-1",
  sessionId: "session-1",
  quantity: 4,
  unitOfMeasure: "each",
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 2,
  createdAt: "2026-07-31T00:00:00.000Z",
} satisfies AggregateImportEvent;

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

  it("returns validation errors instead of throwing for unknown malformed inputs", () => {
    expect(validateIdentityInput(null)).toEqual(["input must be a plain object"]);
    expect(validateIdentityInput({ businessId: 7 })).toEqual(
      expect.arrayContaining([
        "businessId is required",
        "sourceSystem is required",
        "identifiers must be an array",
      ]),
    );
    expect(validateIdentityInput({ ...validInput(), identifiers: [null] })).toContain(
      "identifiers[0] is malformed",
    );
  });

  it.each([
    ["sourceFileFingerprint", "", "sourceFileFingerprint is required"],
    ["sourceFileOrdinal", -1, "sourceFileOrdinal must be a non-negative integer"],
    ["sourceFileOrdinal", 1.5, "sourceFileOrdinal must be a non-negative integer"],
    ["sheetName", " ", "sheetName is required"],
    ["sourceRowNumber", 0, "sourceRowNumber must be a positive integer"],
    ["sourceRowNumber", 1.5, "sourceRowNumber must be a positive integer"],
    ["attributes", [], "attributes must be a plain object"],
    ["rawRecordFingerprint", "", "rawRecordFingerprint is required"],
    ["identifiers", {}, "identifiers must be an array"],
  ] as const)("validates required row-shape field %s", (field, value, expectedError) => {
    expect(validateIdentityInput({ ...validInput(), [field]: value })).toContain(expectedError);
  });

  it.each(["vendor_sku", "source_alias", "internal_code", "shelf_code"] as const)(
    "requires namespace for local identifier type %s",
    (type) => {
      expect(
        validateIdentityInput({
          ...validInput(),
          identifiers: [{ ...validIdentifier, type, namespace: undefined }],
        }),
      ).toContain(`identifiers[0] requires a namespace for ${type}`);
    },
  );

  it("allows globally scoped GTIN identifiers without a namespace", () => {
    expect(
      validateIdentityInput({
        ...validInput(),
        identifiers: [
          {
            ...validIdentifier,
            type: "gtin",
            raw: "4006381333931",
            normalized: "4006381333931",
            namespace: undefined,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps barcode identifiers namespaced while UPC remains globally scoped", () => {
    expect(validateIdentityInput({ ...validInput(), identifiers: [{ ...validIdentifier, type: "barcode", namespace: undefined }] })).toContain("identifiers[0] requires a namespace for barcode");
    expect(validateIdentityInput({ ...validInput(), identifiers: [{ ...validIdentifier, type: "barcode", namespace: "vendor-a" }] })).toEqual([]);
    expect(validateIdentityInput({ ...validInput(), identifiers: [{ ...validIdentifier, type: "upc", raw: "012345678905", normalized: "012345678905", namespace: undefined }] })).toEqual([]);
  });

  it("hashes equivalent objects identically regardless of object key order", async () => {
    await expect(canonicalSha256({ z: 1, nested: { b: 2, a: 1 } })).resolves.toBe(
      await canonicalSha256({ nested: { a: 1, b: 2 }, z: 1 }),
    );
  });

  it("preserves array order in canonical hashes", async () => {
    await expect(canonicalSha256(["first", "second"])).resolves.not.toBe(
      await canonicalSha256(["second", "first"]),
    );
  });

  it("hashes canonical strings as UTF-8", async () => {
    await expect(canonicalSha256("café")).resolves.toBe(
      "ac4f4435bd68fb8e1bb02f586889ff9bd2f4e40a82529d243425b867e929e3ae",
    );
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    () => undefined,
    Symbol("unsupported"),
    { nested: undefined },
    ["valid", Number.NEGATIVE_INFINITY],
  ])("rejects unsupported canonical hash input %#", async (value) => {
    await expect(canonicalSha256(value)).rejects.toThrow("Unsupported canonical JSON value");
  });

  it("defines aggregate imports as a distinct event kind", () => {
    expect(aggregateImportEvent.kind).toBe("aggregate_import");
  });
});
