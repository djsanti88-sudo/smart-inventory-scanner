import { describe, it, expect } from "vitest";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";

describe("sameBrandFamily (curated same-company groups)", () => {
  it("identical brands match trivially (case / punctuation insensitive)", () => {
    expect(sameBrandFamily("Bridgestone", "bridgestone")).toBe(true);
    expect(sameBrandFamily("Carlisle Tire", "carlisle")).toBe(true);
  });

  it("Carlstar and Carlisle are the same company (the eval false-positive class)", () => {
    expect(sameBrandFamily("carlstar", "Carlisle")).toBe(true);
    expect(sameBrandFamily("Carlisle Tire", "Carlstar")).toBe(true);
  });

  it("Bridgestone family covers Firestone and Dayton", () => {
    expect(sameBrandFamily("Bridgestone", "Firestone")).toBe(true);
    expect(sameBrandFamily("bridgestone", "Dayton")).toBe(true);
    expect(sameBrandFamily("firestone", "dayton")).toBe(true);
  });

  it("Goodyear family covers Kelly and Dunlop", () => {
    expect(sameBrandFamily("Goodyear", "Kelly")).toBe(true);
    expect(sameBrandFamily("goodyear", "Dunlop")).toBe(true);
  });

  it("Argus and Advanta are the same house family", () => {
    expect(sameBrandFamily("Argus", "Advanta")).toBe(true);
  });

  it("brands in DIFFERENT families are not the same company", () => {
    expect(sameBrandFamily("Bridgestone", "Westlake")).toBe(false);
    expect(sameBrandFamily("Bridgestone", "Goodyear")).toBe(false);
    expect(sameBrandFamily("Carlisle", "Firestone")).toBe(false);
  });

  it("unknown brands never match unless they normalize identically", () => {
    expect(sameBrandFamily("Westlake", "Nitto")).toBe(false);
    expect(sameBrandFamily("Falken", "Falken Tire")).toBe(true); // same brand, noise stripped
  });

  it("empty brands never match", () => {
    expect(sameBrandFamily("", "Bridgestone")).toBe(false);
    expect(sameBrandFamily("Bridgestone", "")).toBe(false);
    expect(sameBrandFamily("", "")).toBe(false);
  });
});
