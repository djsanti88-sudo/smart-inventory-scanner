import { describe, expect, it } from "vitest";
import { isValidCheckDigit } from "@/services/upc/gtin";
import {
  isTrustedLocalDemoTireRow,
  isValidLocalDemoGtin,
} from "./localDemoTrust.mjs";

const eligible = {
  barcode: "012345678905",
  canonical_product_uid: "tire-1",
  brand: "Example",
  model: "Road",
  model_display: "Road",
  size: "225/65R17",
  current_status: "active_retail",
  usable_for: "auto_count_candidate",
  source_count: 2,
  barcode_type: "upc",
};

describe("local demo tire trust", () => {
  it.each([
    "012345678905",
    "0012345678905",
    "10012345678902",
    "012345678904",
    "abc",
    "",
  ])("matches the shared GTIN checksum implementation for %s", (barcode) => {
    expect(isValidLocalDemoGtin(barcode)).toBe(isValidCheckDigit(barcode));
  });

  it("accepts only complete, conservative UPC/EAN rows and rejects every GTIN-14", () => {
    expect(isTrustedLocalDemoTireRow(eligible)).toBe(true);
    for (const patch of [
      { barcode: "012345678904" },
      { canonical_product_uid: "" },
      { brand: "" },
      { model: "", model_display: "" },
      { size: "" },
      { current_status: "hold" },
      { usable_for: "review_candidate" },
      { source_count: 1 },
      { barcode_type: "gtin14", barcode: "10012345678902" },
    ]) {
      expect(isTrustedLocalDemoTireRow({ ...eligible, ...patch })).toBe(false);
    }
  });

  it("keeps the ordinary two-source gate unless the index marked an already-validated twin", () => {
    const sourceOne = { ...eligible, source_count: 1 };
    expect(isTrustedLocalDemoTireRow(sourceOne)).toBe(false);
    expect(isTrustedLocalDemoTireRow({ ...sourceOne, localDemoTwinSelected: true })).toBe(false);
    expect(isTrustedLocalDemoTireRow({ ...sourceOne, localDemoTwinSelected: true }, true)).toBe(true);
    expect(isTrustedLocalDemoTireRow({ ...sourceOne, localDemoTwinSelected: true, model: "", model_display: "" }, true)).toBe(false);
  });
});
