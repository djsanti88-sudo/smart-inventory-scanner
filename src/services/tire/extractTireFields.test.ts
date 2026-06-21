import { describe, it, expect } from "vitest";
import { extractTireFields } from "@/services/tire/extractTireFields";

describe("extractTireFields", () => {
  it("extracts size, brand, part number, and a clean description from a messy name", () => {
    const out = extractTireFields({
      productName: "Michelin Agility SUV 225/60R18 103H BSW",
      brand: "Michelin",
      primarySku: "MICH-12345",
    });
    expect(out.size).toBe("225/60R18 103H");
    expect(out.brand).toBe("Michelin");
    expect(out.partNumber).toBe("MICH-12345");
    expect(out.description).toBe("Agility SUV BSW"); // brand + size + load/speed stripped
  });

  it("uses a declared known brand even when it is absent from the name", () => {
    const out = extractTireFields({ productName: "Wildpeak A/T 275/55R20 111T", brand: "Falken" });
    expect(out.brand).toBe("Falken");
    expect(out.size).toBe("275/55R20 111T");
    expect(out.description).toBe("Wildpeak A/T"); // size + load/speed stripped, A/T kept
  });

  it("accepts a stored Product's `name` field and a commercial size", () => {
    const out = extractTireFields({ name: "Bridgestone R250 11R22.5", primarySku: "001234" });
    expect(out.size).toBe("11R22.5");
    expect(out.brand).toBe("Bridgestone");
    expect(out.partNumber).toBe("001234");
    expect(out.description).toBe("R250");
  });

  it("does NOT fabricate: unknown size/brand/part stay blank and the raw text is kept in description", () => {
    const out = extractTireFields({ productName: "Mystery Closeout Item 7755 Lot", brand: "" });
    expect(out.size).toBeNull();
    expect(out.brand).toBeNull();
    expect(out.partNumber).toBeNull();
    expect(out.description).toBe("Mystery Closeout Item 7755 Lot"); // raw kept, not a wrong guess
  });

  it("part number is null when no SKU/MPN is present (never invented)", () => {
    const out = extractTireFields({ productName: "Goodyear Eagle 245/40R19 98Y" });
    expect(out.partNumber).toBeNull();
    expect(out.size).toBe("245/40R19 98Y");
    expect(out.brand).toBe("Goodyear");
  });

  it("pulls the size from specsShort when the name has none, without crashing", () => {
    const out = extractTireFields({ productName: "Falken Wildpeak", specsShort: "275/55R20 111T", primarySku: "X1" });
    expect(out.size).toBe("275/55R20 111T");
    expect(out.brand).toBe("Falken");
    expect(out.description).toBe("Wildpeak");
  });

  it("null/undefined identity -> all blank", () => {
    const out = extractTireFields(null);
    expect(out).toEqual({ size: null, brand: null, partNumber: null, description: "" });
  });
});
