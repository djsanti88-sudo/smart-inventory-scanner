// scripts/dt-harvest/lib/reguardPrefixConflict.test.mjs
// TDD for the Westlake mechanism: jsonlLinesToRows must RE-EVALUATE guardRow LIVE for rows whose
// STALE static `guard` stamp is "prefix_conflict", admitting them if they now pass the CURRENT
// rules (corrected brand families), while:
//   - invalid_check_digit-stamped rows STAY dropped (a bad GS1 check digit is always bad).
//   - prefix_conflict-stamped rows that STILL conflict (genuinely different brand) STAY dropped.
//   - clean (guard "ok") rows are unaffected (no regression).
//
// Uses a SYNTHETIC/FIXTURE family + prefix map only. Does NOT depend on the real corpus, real
// harvest .jsonl, or the real brandFamilies.ts data. The family check is injected so the mechanism
// can be proven before any real family data is added by the integration step.

import { describe, it, expect } from "vitest";
import { jsonlLinesToRows } from "./applyTransform.mjs";
import { guardRow } from "./merge.mjs";

// A valid GS1 UPC-A whose 7-digit prefix we register to a "leader" brand in a synthetic family.
// 848983006257 is a real corpus UPC with a VALID mod-10 check digit; prefix = "8489830".
const VALID_UPC = "848983006257";
const PREFIX = VALID_UPC.slice(0, 7); // "8489830"

// A DIFFERENT valid UPC-A with a genuinely-different brand, sharing the SAME registered prefix.
// 036000291452 is a well-known valid UPC-A check digit; we re-point its prefix to the same brand
// leader below to simulate the shared distributor prefix. We instead reuse VALID_UPC's prefix by
// keeping the same prefix in the map and varying only the brand, which is what the real defect is.
const SECOND_VALID_UPC = "036000291452";

// Synthetic prefix map: this prefix is registered to brand "leaderbrand".
const PREFIX_MAP = { [PREFIX]: ["leaderbrand"], [SECOND_VALID_UPC.slice(0, 7)]: ["leaderbrand"] };

// Synthetic family function: "leaderbrand" and "siblingbrand" are the SAME company (fixture only).
// "outsiderbrand" is a genuinely DIFFERENT company. This mirrors sameBrandFamily's contract:
// identical brands trivially match; unknown brands never match unless identical.
function fixtureSameBrandFamily(a, b) {
  const norm = (s) => (s || "").toString().trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const family = new Set(["leaderbrand", "siblingbrand"]);
  return family.has(na) && family.has(nb);
}

function line(overrides = {}) {
  return JSON.stringify({
    gtin: VALID_UPC,
    brand: "leaderbrand",
    model: "foray rp218",
    size: "265/70R17",
    loadIndex: "115",
    speedRating: "T",
    partNumber: "28034300",
    imageUrl: "https://www.discounttire.com/img.jpg",
    sourceUrl: "https://www.discounttire.com/tires/x/p1",
    fetchedAt: "2026-07-08T00:00:00.000Z",
    guard: "ok",
    ...overrides,
  });
}

describe("guardRow honors sameBrandFamily on the prefix-conflict check", () => {
  it("clears a prefix conflict when the row's brand is in the SAME family as the registered brand", () => {
    // prefix registered to leaderbrand; row brand siblingbrand -> raw check would conflict,
    // but the injected family function clears it.
    const result = guardRow(
      { gtin: VALID_UPC, brand: "siblingbrand" },
      PREFIX_MAP,
      fixtureSameBrandFamily
    );
    expect(result).toEqual({ ok: true });
  });

  it("STILL rejects a prefix conflict when the brand is a genuinely different family", () => {
    const result = guardRow(
      { gtin: VALID_UPC, brand: "outsiderbrand" },
      PREFIX_MAP,
      fixtureSameBrandFamily
    );
    expect(result).toEqual({ ok: false, reason: "prefix_conflict" });
  });

  it("without a family function, same-family brands still conflict (backward compatible)", () => {
    const result = guardRow({ gtin: VALID_UPC, brand: "siblingbrand" }, PREFIX_MAP);
    expect(result).toEqual({ ok: false, reason: "prefix_conflict" });
  });
});

describe("jsonlLinesToRows re-guards prefix_conflict-stamped rows live", () => {
  const options = { prefixMap: PREFIX_MAP, sameBrandFamily: fixtureSameBrandFamily };

  it("ADMITS a prefix_conflict-stamped row whose brand is now in the same family (recovery)", () => {
    // Stale stamp says prefix_conflict, but under corrected (fixture) family rules siblingbrand
    // is the same company as the registered leaderbrand -> should be recovered.
    const lines = [line({ guard: "prefix_conflict", brand: "siblingbrand" })];
    const rows = jsonlLinesToRows(lines, options);
    expect(rows).toHaveLength(1);
    expect(rows[0].brand).toBe("siblingbrand");
  });

  it("keeps an invalid_check_digit-stamped row DROPPED (bad check digit is always bad)", () => {
    const lines = [
      line({ guard: "invalid_check_digit", gtin: "848983006258", brand: "siblingbrand" }),
    ];
    const rows = jsonlLinesToRows(lines, options);
    expect(rows).toHaveLength(0);
  });

  it("keeps a prefix_conflict-stamped row DROPPED when the brand is a genuinely different family", () => {
    const lines = [line({ guard: "prefix_conflict", brand: "outsiderbrand" })];
    const rows = jsonlLinesToRows(lines, options);
    expect(rows).toHaveLength(0);
  });

  it("still admits a clean guard:ok row (no regression)", () => {
    const lines = [line({ guard: "ok", brand: "leaderbrand" })];
    const rows = jsonlLinesToRows(lines, options);
    expect(rows).toHaveLength(1);
    expect(rows[0].brand).toBe("leaderbrand");
  });

  it("without options, a prefix_conflict-stamped row STAYS dropped (backward compatible)", () => {
    const lines = [line({ guard: "prefix_conflict", brand: "siblingbrand" })];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(0);
  });

  it("a recovered prefix_conflict row still de-dupes against a clean row of the same gtin", () => {
    // Same gtin, one clean and one recovered: the completeness-based dedupe keeps exactly one.
    const clean = line({ guard: "ok", brand: "leaderbrand", partNumber: "AAA111222" });
    const recovered = line({ guard: "prefix_conflict", brand: "siblingbrand", partNumber: "" });
    const rows = jsonlLinesToRows([clean, recovered], options);
    expect(rows).toHaveLength(1);
    expect(rows[0].gtin).toBe(VALID_UPC);
  });
});
