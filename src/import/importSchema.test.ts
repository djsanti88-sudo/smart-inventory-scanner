// src/import/importSchema.test.ts
import { describe, expect, it } from "vitest";
import {
  IMPORT_FIELD_ORDER,
  buildSourceSignature,
  emptyColumnMapping,
} from "@/import/importSchema";

describe("importSchema", () => {
  it("keeps the nine supported mapping fields in a stable order", () => {
    expect(IMPORT_FIELD_ORDER).toEqual([
      "partNumber",
      "brand",
      "model",
      "size",
      "quantity",
      "uom",
      "barcode",
      "name",
      "category",
    ]);
  });

  it("builds the same source signature for case and whitespace variants", () => {
    expect(buildSourceSignature([" PN ", "Make", "QOH"])).toBe(
      buildSourceSignature(["pn", " make ", "qoh"]),
    );
  });

  it("returns a fresh empty mapping", () => {
    const a = emptyColumnMapping();
    const b = emptyColumnMapping();
    expect(a).toEqual({});
    expect(b).toEqual({});
    expect(a).not.toBe(b);
  });
});
