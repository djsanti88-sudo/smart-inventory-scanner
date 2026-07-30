import { describe, it, expect } from "vitest";
import { prettifyProductName, prettifyBrand } from "@/services/format/productDisplay";

// Task 5: corpus rows store model slugs ("wrangler_workhorse_at") and lowercase brands. These pure
// helpers prettify at DISPLAY time only - matching/normalized fields stay untouched. v2 trap: naive
// per-token mapping breaks "energy_saver_a_s" style names, so the algorithm must merge grouped
// letter-pair tokens (a+s -> A/S, m+s -> M/S) BEFORE per-token casing.

describe("prettifyProductName", () => {
  it("title-cases plain slug tokens", () => {
    expect(prettifyProductName("wrangler_workhorse_at")).toBe("Wrangler Workhorse AT");
  });

  it("merges a trailing a/s letter-pair into A/S", () => {
    expect(prettifyProductName("energy_saver_a_s")).toBe("Energy Saver A/S");
  });

  it("merges a/s after other per-token-mapped words (f1)", () => {
    expect(prettifyProductName("eagle_f1_asymmetric_a_s")).toBe("Eagle F1 Asymmetric A/S");
  });

  it("merges a trailing m/s letter-pair into M/S, and maps ltx", () => {
    expect(prettifyProductName("defender_ltx_m_s")).toBe("Defender LTX M/S");
  });

  it("uppercases a digit-led token (cs5)", () => {
    expect(prettifyProductName("cs5_ultra_touring")).toBe("CS5 Ultra Touring");
  });

  it("preserves the trusted corpus SU318 H T model code tokens", () => {
    expect(prettifyProductName("su318_h_t")).toBe("SU318 H T");
  });

  it("title-cases each part of a hyphenated token", () => {
    expect(prettifyProductName("eagle_sport_all-season")).toBe("Eagle Sport All-Season");
  });

  it("title-cases a hyphen part with a long digit suffix, not wholesale-uppercase (regression)", () => {
    expect(prettifyProductName("wrangler_all-season2")).toBe("Wrangler All-Season2");
  });

  it("uppercases a short digit-containing hyphen part as a model code", () => {
    expect(prettifyProductName("terrain_g2")).toBe("Terrain G2");
  });

  it("title-cases a long digit-suffixed word outside a hyphen (regression)", () => {
    expect(prettifyProductName("season2_touring")).toBe("Season2 Touring");
  });

  it("passes through an already-clean input unchanged (no underscore + has uppercase)", () => {
    expect(prettifyProductName("Michelin Premier A/S 215/60R16 95H")).toBe("Michelin Premier A/S 215/60R16 95H");
  });

  it("passes through a spec string with no underscore and uppercase letters (never mangled)", () => {
    expect(prettifyProductName("245/70R16 107T")).toBe("245/70R16 107T");
  });

  it("maps ht per-token", () => {
    expect(prettifyProductName("terrain_ht")).toBe("Terrain HT");
  });

  it("handles an empty string without throwing", () => {
    expect(prettifyProductName("")).toBe("");
  });
});

describe("prettifyBrand", () => {
  it("maps known multi-cap brands", () => {
    expect(prettifyBrand("goodyear")).toBe("Goodyear");
    expect(prettifyBrand("bfgoodrich")).toBe("BFGoodrich");
    expect(prettifyBrand("michelin")).toBe("Michelin");
    expect(prettifyBrand("cooper")).toBe("Cooper");
    expect(prettifyBrand("firestone")).toBe("Firestone");
    expect(prettifyBrand("bridgestone")).toBe("Bridgestone");
  });

  it("title-cases an unknown brand by default", () => {
    expect(prettifyBrand("hankook")).toBe("Hankook");
  });

  it("handles an empty string without throwing", () => {
    expect(prettifyBrand("")).toBe("");
  });
});
