import { describe, it, expect } from "vitest";
import { customerDisplayName } from "@/services/displayName";

describe("customerDisplayName (P5 render-only customer name cleaner)", () => {
  it("strips a leading UPC/GTIN/EAN code prefix", () => {
    expect(customerDisplayName("UPC 086699205636 - Defender LTX M/S 275/70R18")).toBe("Defender LTX M/S 275/70R18");
    expect(customerDisplayName("GTIN: 00029142712886 - Cooper Discoverer A/T3")).toBe("Cooper Discoverer A/T3");
  });

  it("strips a trailing Fits fitment clause", () => {
    expect(customerDisplayName("Defender LTX M/S 275/70R18 Fits 2004 Chevrolet Silverado")).toBe("Defender LTX M/S 275/70R18");
    expect(customerDisplayName("Wildpeak A/T3W LT275/70R18 - Fits: Ford F-150")).toBe("Wildpeak A/T3W LT275/70R18");
  });

  it("strips both prefix and fitment together (brand+model+size preserved)", () => {
    expect(customerDisplayName("UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet"))
      .toBe("Defender LTX M/S 275/70R18");
  });

  it("leaves ordinary names untouched", () => {
    expect(customerDisplayName("Cooper Discoverer A/T3 LT245/75R16 120R")).toBe("Cooper Discoverer A/T3 LT245/75R16 120R");
    expect(customerDisplayName("Coca-Cola 12oz Can")).toBe("Coca-Cola 12oz Can");
    expect(customerDisplayName("Benefits Plus Multivitamin")).toBe("Benefits Plus Multivitamin"); // not a "Fits" clause
  });

  it("never returns empty (falls back to the raw name)", () => {
    expect(customerDisplayName("UPC 123456789012 -")).toBe("UPC 123456789012 -"); // nothing after prefix -> keep raw
    expect(customerDisplayName("")).toBe("");
  });
});
