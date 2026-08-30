// src/decoding/tireSpecs.countable.test.ts
import { describe, it, expect } from "vitest";
import { hasCountableTireIdentity, hasTireModel } from "./tireSpecs";

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
});
