import { describe, it, expect } from "vitest";
import { sameBrandFamily, familyLabelFor } from "@/services/catalog/brandFamilies";

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

  it("Goodyear family covers Kelly", () => {
    expect(sameBrandFamily("Goodyear", "Kelly")).toBe(true);
  });

  it("Dunlop is deliberately unfamilied (2025 Sumitomo trademark repurchase from Goodyear)", () => {
    // Sumitomo Rubber Industries bought back the Dunlop trademark for NA/Europe/Oceania in a deal
    // that closed May 2025. Ownership is mid-transition (Goodyear-era stock still on shelves), so
    // Dunlop must not be grouped with either owner - a real conflict must reach Needs Review.
    expect(sameBrandFamily("Dunlop", "Goodyear")).toBe(false);
    expect(sameBrandFamily("Dunlop", "Sumitomo")).toBe(false);
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

describe("michelin family (086699998538 false-conflict class)", () => {
  it("treats Michelin and BFGoodrich as the same company", () => {
    expect(sameBrandFamily("Michelin", "bfgoodrich")).toBe(true);
    expect(sameBrandFamily("BFGoodrich Tires", "michelin")).toBe(true);
  });
  it("treats Michelin and Uniroyal as the same company", () => {
    expect(sameBrandFamily("Uniroyal", "Michelin")).toBe(true);
  });
  it("does NOT relate Michelin to Goodyear or Bridgestone", () => {
    expect(sameBrandFamily("Michelin", "Goodyear")).toBe(false);
    expect(sameBrandFamily("bfgoodrich", "Bridgestone")).toBe(false);
  });
});

describe("other evidenced corporate families", () => {
  it("Continental owns General Tire", () => {
    expect(sameBrandFamily("General", "Continental")).toBe(true);
  });
  it("Goodyear owns Cooper (2021) and Cooper's house brands", () => {
    expect(sameBrandFamily("Cooper", "Goodyear")).toBe(true);
    expect(sameBrandFamily("Mastercraft", "goodyear")).toBe(true);
  });
  it("Toyo owns Nitto", () => {
    expect(sameBrandFamily("Nitto", "Toyo")).toBe(true);
  });
  it("unrelated pairs still never match", () => {
    expect(sameBrandFamily("Cooper", "Michelin")).toBe(false);
    expect(sameBrandFamily("Nitto", "Hankook")).toBe(false);
  });
});

describe("familyLabelFor (P5: family annotation for the prefix floor)", () => {
  it("maps a non-leader MEMBER brand to its family leader label", () => {
    // Leader is the FIRST entry of each FAMILIES group: Michelin group -> michelin;
    // Goodyear group -> goodyear; Continental group -> continental.
    expect(familyLabelFor("BFGoodrich")).toBe("Michelin family");
    expect(familyLabelFor("Cooper")).toBe("Goodyear family"); // Cooper is a member of the Goodyear group
    expect(familyLabelFor("General")).toBe("Continental family");
    expect(familyLabelFor("Firestone")).toBe("Bridgestone family");
  });

  it("returns null for a family LEADER (the leader carries no label)", () => {
    expect(familyLabelFor("Michelin")).toBeNull();
    expect(familyLabelFor("Goodyear")).toBeNull();
    expect(familyLabelFor("Continental")).toBeNull();
  });

  it("returns null for an INDEPENDENT brand (in no family) and for empty input", () => {
    expect(familyLabelFor("Nokian")).toBeNull(); // not in any curated group
    expect(familyLabelFor("Westlake")).toBeNull();
    expect(familyLabelFor("")).toBeNull();
  });

  it("is case / punctuation / noise insensitive (reuses the module norm)", () => {
    expect(familyLabelFor("BFGoodrich Tires")).toBe("Michelin family");
    expect(familyLabelFor("  cooper  ")).toBe("Goodyear family");
  });
});
