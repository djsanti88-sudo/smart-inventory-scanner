// scripts/dt-harvest/lib/brandFamilies.drift.test.mjs
// DRIFT GUARD (mandatory): scripts/dt-harvest/lib/brandFamilies.mjs is a hand-maintained
// reimplementation of src/services/catalog/brandFamilies.ts (the .mjs harvest pipeline cannot
// import the server-only TS module). Wrong or duplicated family data would cause a FALSE
// product-identity merge - worse than leaving codes unrecovered. This test imports BOTH the .mjs
// and the .ts source and asserts they agree on family membership for EVERY brand pair, so the two
// can never silently diverge. If someone edits one family table without the other, this fails.
//
// Runs in the "unit" vitest project (scripts/**/*.test.mjs, node env). The "@/" alias resolves the
// TS source exactly as app code imports it.

import { describe, it, expect } from "vitest";
import {
  sameBrandFamily as sameBrandFamilyMjs,
  FAMILIES as FAMILIES_MJS,
} from "./brandFamilies.mjs";
import { sameBrandFamily as sameBrandFamilyTs } from "@/services/catalog/brandFamilies";

// Same normalization both sources use (kept local so this test does not depend on either export).
function norm(b) {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Every distinct normalized brand mentioned in the .mjs family table, plus a few brands that must
// NOT be related to anything (independents) to catch an accidental over-broad merge on either side.
const MJS_BRANDS = Array.from(new Set(FAMILIES_MJS.flat().map(norm)));
const INDEPENDENTS = ["nokian", "pirelli", "yokohama", "kumho", "nexen"].map(norm);
const ALL_BRANDS = Array.from(new Set([...MJS_BRANDS, ...INDEPENDENTS]));

describe("brandFamilies.mjs <-> brandFamilies.ts drift guard", () => {
  it("the two sources agree on sameBrandFamily for EVERY brand pair (no drift)", () => {
    const disagreements = [];
    for (const a of ALL_BRANDS) {
      for (const b of ALL_BRANDS) {
        const mjs = sameBrandFamilyMjs(a, b);
        const ts = sameBrandFamilyTs(a, b);
        if (mjs !== ts) disagreements.push(`${a} <> ${b}: mjs=${mjs} ts=${ts}`);
      }
    }
    // Any disagreement means the .mjs family table drifted from the .ts source.
    expect(disagreements).toEqual([]);
  });

  it("every brand in the .mjs table is recognized as same-family with itself in BOTH sources", () => {
    for (const b of MJS_BRANDS) {
      expect(sameBrandFamilyMjs(b, b), `mjs self-match ${b}`).toBe(true);
      expect(sameBrandFamilyTs(b, b), `ts self-match ${b}`).toBe(true);
    }
  });

  it("spot-checks the recovery families match in both sources", () => {
    for (const [a, b] of [
      ["westlake", "milestar"],
      ["atlas", "green max"],
      ["taskmaster", "diamondback"],
      ["provider", "diamondback"],
    ]) {
      expect(sameBrandFamilyMjs(a, b)).toBe(true);
      expect(sameBrandFamilyTs(a, b)).toBe(true);
    }
  });

  it("independents relate to nothing in either source (no over-broad merge)", () => {
    for (const ind of INDEPENDENTS) {
      for (const b of MJS_BRANDS) {
        expect(sameBrandFamilyMjs(ind, b), `mjs ${ind}<>${b}`).toBe(false);
        expect(sameBrandFamilyTs(ind, b), `ts ${ind}<>${b}`).toBe(false);
      }
    }
  });
});
