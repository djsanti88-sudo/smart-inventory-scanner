// src/services/ai/tireSpecs.countable.test.ts
import { describe, it, expect } from "vitest";
import { hasCountableTireIdentity, hasTireModel, hasTireSize, tireModelToken, tireSizeToken } from "./tireSpecs";

describe("countable tire identity (brand+size+model)", () => {
  it("accepts a tire with a model and size", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin Defender T+H 245/55R19 103H", brand: "Michelin" })).toBe(true);
    expect(hasCountableTireIdentity({ productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper" })).toBe(true);
  });
  it("rejects brand+size with NO model", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin 245/55R19", brand: "Michelin" })).toBe(false);
    expect(hasTireModel({ productName: "Michelin 245/55R19", brand: "Michelin" })).toBe(false);
  });
  it("rejects when there is no size", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin Defender", brand: "Michelin" })).toBe(false);
  });

  it("recognizes directly attached LT slash-flotation sizes as countable tire identity", () => {
    for (const [productName, token] of [
      ["Falken Wildpeak LT37/12.50R22", "LT37X12.50R22"],
      ["Cooper Discoverer LT35/12.50R17", "LT35X12.50R17"],
      ["Nitto Ridge Grappler LT35/11.50R20", "LT35X11.50R20"],
    ]) {
      const tire = { productName, brand: productName.split(" ")[0] };
      expect(hasTireSize(tire), productName).toBe(true);
      expect(tireSizeToken(tire), productName).toBe(token);
      expect(hasCountableTireIdentity(tire), productName).toBe(true);
    }
  });

  it("does not recognize unprefixed, implausible, or separated-prefix slash flotation as tire sizes", () => {
    for (const productName of [
      "Falken Wildpeak 37/12.50R22",
      "Falken Wildpeak LT16/2.125R25",
      "Falken Wildpeak LT35/12.50R99",
      "Falken Wildpeak LT 37/12.50R22",
      "Falken Wildpeak LT37/12.50R22ZZ",
      "Falken Wildpeak LT37/12.50R221",
      "Falken Wildpeak LT37/12.50R22/123",
    ]) {
      expect(hasTireSize({ productName }), productName).toBe(false);
    }
  });

  it("recognizes agricultural and implement dash sizes without consuming the model", () => {
    const cases = [
      ["BKT TR 135 6.00-19", "135"],
      ["BKT TR 459 14.5-20", "459"],
      ["BKT TR 315 16.9-26", "315"],
      ["BKT Skid Power HD 12-16.5", "Skid Power"],
      ["BKT TR 171 9.5L-14", "171"],
      ["BKT TR 171 30.5L-32", "171"],
      ["BKT Farm Implement 6-14", "Farm Implement"],
    ] as const;

    for (const [productName, model] of cases) {
      const tire = { productName, brand: "BKT", category: "Tire" };
      expect(hasTireSize(tire), productName).toBe(true);
      expect(tireModelToken(tire), productName).toBe(model);
      expect(hasCountableTireIdentity(tire), productName).toBe(true);
    }
  });

  it("does not treat dates or part-number-like dash pairs as agricultural tire sizes", () => {
    for (const productName of [
      "Service bulletin dated 2026-07-30",
      "Replacement part 12-345 for farm equipment",
      "Dorman hardware kit 14-200",
      "Invoice 6-2024",
      "Gear ratio 20-30",
      "Part 12-16",
      "Tire repair kit 12-16",
      "Tire pressure gauge 20-30",
    ]) {
      expect(hasTireSize({ productName }), productName).toBe(false);
    }
  });
});
