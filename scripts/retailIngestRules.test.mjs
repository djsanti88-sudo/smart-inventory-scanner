import { describe, it, expect } from "vitest";
import {
  firstBrandTag,
  isDummyBarcode,
  isGarbledText,
  sanitizeRetailEntry,
} from "./retailIngestRules.mjs";

// These rules guard what reaches the server-only retail knowledge index / SQLite DB.
// The Open Food Facts `brands` field is a community-editable comma-separated tag list, so a barcode
// reused across unrelated OFF placeholder submissions produced poisoned rows like:
//   0123456789012 -> ["Peanut Butter Crunch", "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti", ...]
// The ingest MUST keep only the first brand tag, cap absurd lengths, and drop dummy/placeholder barcodes.

describe("firstBrandTag - only the first OFF brand tag survives (never the run-on tag list)", () => {
  it("keeps only the first comma-separated brand tag, trimmed", () => {
    expect(firstBrandTag("Fleischer, Selbst gemacht, The Wholesome Bar, Uberti")).toBe("Fleischer");
    expect(firstBrandTag("Kirkland,Kirkland Signature,Ocean Spray")).toBe("Kirkland");
  });
  it("passes a clean single brand through unchanged", () => {
    expect(firstBrandTag("Michelin")).toBe("Michelin");
  });
  it("returns empty string for empty / nullish input", () => {
    expect(firstBrandTag("")).toBe("");
    expect(firstBrandTag(null)).toBe("");
    expect(firstBrandTag(undefined)).toBe("");
  });
});

describe("isDummyBarcode - GS1 placeholder / test barcodes are blocklisted", () => {
  it("flags the 0-9 sequential placeholder family (padded + unpadded)", () => {
    expect(isDummyBarcode("123456789012")).toBe(true);
    expect(isDummyBarcode("0123456789012")).toBe(true); // zero-padded EAN-13 form (the poisoned row)
    expect(isDummyBarcode("00123456789012")).toBe(true); // GTIN-14 form
  });
  it("flags all-zero and all-nine placeholders", () => {
    expect(isDummyBarcode("000000000000")).toBe(true);
    expect(isDummyBarcode("0000000000000")).toBe(true);
    expect(isDummyBarcode("9999999999999")).toBe(true);
    expect(isDummyBarcode("999999999999")).toBe(true);
  });
  it("does NOT flag a real barcode", () => {
    expect(isDummyBarcode("049000028911")).toBe(false); // Diet Coke UPC-A
    expect(isDummyBarcode("086699087829")).toBe(false);
    expect(isDummyBarcode("10000007")).toBe(false);
  });
});

describe("isGarbledText - run-on / over-length names are garbling signals", () => {
  it("flags an over-length brand (>80 chars = never a real brand name)", () => {
    const runOn =
      "Bio, Nutella, Ferrero, ingredients: sugar palm oil hazelnuts, storage keep cool dry place, made in italy address";
    expect(isGarbledText(runOn)).toBe(true);
  });
  it("does NOT flag a normal product name or brand", () => {
    expect(isGarbledText("Peanut Butter Crunch")).toBe(false);
    expect(isGarbledText("Michelin")).toBe(false);
    expect(isGarbledText("Diet Coke 12 fl oz")).toBe(false);
  });
});

describe("sanitizeRetailEntry - end-to-end row cleaning", () => {
  it("cleans the exact poisoned live row 0123456789012 -> dropped (dummy barcode)", () => {
    const out = sanitizeRetailEntry("0123456789012", [
      "Peanut Butter Crunch",
      "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti",
      "Dried fruits",
    ]);
    expect(out).toBeNull(); // dummy placeholder barcode -> never indexed
  });
  it("keeps only the first brand tag on a real barcode", () => {
    const out = sanitizeRetailEntry("3017620422003", [
      "Nutella",
      "Ferrero, Nutella, Bio",
      "Spreads",
    ]);
    expect(out).not.toBeNull();
    expect(out[0]).toBe("Nutella");
    expect(out[1]).toBe("Ferrero"); // first tag only
    expect(out[2]).toBe("Spreads");
  });
  it("drops a row whose name is garbled run-on text", () => {
    const out = sanitizeRetailEntry("21630590", [
      "Ingredients sugar palm oil hazelnuts cocoa skimmed milk powder storage keep cool and dry manufacturer address street",
      "Somebrand",
      "Spreads",
    ]);
    expect(out).toBeNull();
  });
});
