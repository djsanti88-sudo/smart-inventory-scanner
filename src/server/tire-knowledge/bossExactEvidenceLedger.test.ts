import { describe, expect, it } from "vitest";

import {
  BOSS_EXACT_EVIDENCE_LEDGER,
  BOSS_SHOP_CODE_REDIRECTS,
  findBossShopCodeRedirect,
  matchesBossShopCodeRedirectTarget,
  matchesBossExactEvidenceLedger,
} from "@/server/tire-knowledge/bossExactEvidenceLedger";

const BOSS_ROW = {
  barcode: "8935341201460",
  canonical_product_uid: "TIRE_68FAA4E35FDBAD43F790",
  manufacturer_part_number: "4120146",
  brand: "Blackhawk",
  size: "255/50R20",
  raw_size_text: "255/50R20",
  model: "Agility SUV BSW",
  model_display: "Agility suv bsw",
};

describe("Boss exact-evidence ledger", () => {
  it("admits only the four frozen workbook-backed identities", () => {
    expect(BOSS_EXACT_EVIDENCE_LEDGER).toHaveLength(4);
    expect(Object.isFrozen(BOSS_EXACT_EVIDENCE_LEDGER)).toBe(true);
    expect(matchesBossExactEvidenceLedger(BOSS_ROW)).toBe(true);
    expect(matchesBossExactEvidenceLedger({
      ...BOSS_ROW,
      barcode: "8935341201521",
      canonical_product_uid: "TIRE_1FA2DBB5139B81DBB6AE",
      manufacturer_part_number: "4120152",
      size: "225/55R18",
    })).toBe(true);
  });

  it.each([
    ["barcode", "8935341201461"],
    ["canonical UID", "TIRE_OTHER"],
    ["canonical MPN", "4120147"],
    ["normalized brand", "other-brand"],
    ["canonical size", "255/55R20"],
  ])("fails closed when the %s differs", (field, value) => {
    const row = field === "canonical UID"
      ? { ...BOSS_ROW, canonical_product_uid: value }
      : field === "canonical MPN"
        ? { ...BOSS_ROW, manufacturer_part_number: value }
        : field === "normalized brand"
          ? { ...BOSS_ROW, brand: value }
          : field === "canonical size"
            ? { ...BOSS_ROW, size: value, raw_size_text: value }
            : { ...BOSS_ROW, barcode: value };

    expect(matchesBossExactEvidenceLedger(row)).toBe(false);
  });

  it("records immutable exact-barcode acceptance evidence for every entry", () => {
    for (const entry of BOSS_EXACT_EVIDENCE_LEDGER) {
      expect(entry.evidenceKind).toBe("boss_workbook_reconciliation_exact_barcode");
      expect(entry.workbookSha256).toBe("AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404");
      expect(entry.disposition).toBe("accepted");
      expect(entry.bossPartNumber).toMatch(/^(BH|TH)\d+$/);
    }
  });
});

const BOSS_SHOP_CODE_CASES = [
  ["3220017209", "003220017209", "TIRE_688C82A02536FEEFBA1C", "BH1600462", "blackhawk", "33X12.50R20", 16],
  ["3220017315", "003220017315", "TIRE_2F2263B3167393AB7EA5", "BH1600467", "blackhawk", "35X12.50R17", 21],
  ["3220017438", "003220017438", "TIRE_D0F7590DC52EB30084BC", "BH1600479", "blackhawk", "275/55R20", 33],
  ["3220017483", "003220017483", "TIRE_C403AC1F3DB3491E7E3B", "BH1600487", "blackhawk", "265/75R16", 41],
  ["3220018367", "003220018367", "TIRE_D207F9B2A5E9E7010EFB", "BH4120851", "blackhawk", "235/70R16", 391],
  ["3220018381", "003220018381", "TIRE_751C135054BD4468225F", "BH4120857", "blackhawk", "245/75R16", 397],
  ["3220018411", "003220018411", "TIRE_DC7B51A10E3EEF677592", "BH4120867", "blackhawk", "245/75R17", 407],
  ["3220018428", "003220018428", "TIRE_544F4F079893176C1521", "BH4120879", "blackhawk", "35X12.50R18", 419],
  ["3220018435", "003220018435", "TIRE_A76115D4AC263F54A952", "BH4120886", "blackhawk", "285/60R20", 426],
  ["77676020526", "077676020526", "TIRE_8FF5C1A475EFB383981F", "NX10557", "nexen", "245/50R20", 1734],
] as const;

describe("Boss shop-code redirect evidence ledger", () => {
  it.each(BOSS_SHOP_CODE_CASES)("maps approved shop code %s only to its frozen canonical identity", (scannedCode, canonicalBarcode, canonicalProductUid, canonicalManufacturerPartNumber, normalizedBrand, canonicalSize, sourceRow) => {
    const redirect = findBossShopCodeRedirect(scannedCode);

    expect(redirect).toEqual({
      scannedCode,
      canonicalBarcode,
      canonicalProductUid,
      canonicalManufacturerPartNumber,
      normalizedBrand,
      canonicalSize,
      sourceSheet: "Sheet1",
      sourceRow,
      evidenceKind: "boss_workbook_reconciliation_shop_code_redirect",
      workbookSha256: "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404",
      disposition: "accepted",
    });
  });

  it("is immutable, unique, and rejects a neighboring non-evidence key", () => {
    expect(BOSS_SHOP_CODE_REDIRECTS).toHaveLength(10);
    expect(Object.isFrozen(BOSS_SHOP_CODE_REDIRECTS)).toBe(true);
    expect(new Set(BOSS_SHOP_CODE_REDIRECTS.map(({ scannedCode }) => scannedCode)).size).toBe(10);
    expect(findBossShopCodeRedirect("3220017210")).toBeUndefined();
  });

  it("normalizes scanner spaces and dashes only, without altering leading zeroes or accepting suffixes", () => {
    expect(findBossShopCodeRedirect("3220-017-209")?.canonicalBarcode).toBe("003220017209");
    expect(findBossShopCodeRedirect(" 3220 017 209 ")?.canonicalBarcode).toBe("003220017209");
    expect(findBossShopCodeRedirect("03220017209")).toBeUndefined();
    expect(findBossShopCodeRedirect("32200172090")).toBeUndefined();
    expect(findBossShopCodeRedirect("220017209")).toBeUndefined();
  });

  it("requires the entire canonical target fingerprint", () => {
    const redirect = findBossShopCodeRedirect("3220017209");
    expect(redirect).toBeDefined();
    if (!redirect) throw new Error("approved redirect missing");

    const row = {
      barcode: redirect.canonicalBarcode,
      canonical_product_uid: redirect.canonicalProductUid,
      manufacturer_part_number: redirect.canonicalManufacturerPartNumber,
      brand: "Blackhawk",
      size: redirect.canonicalSize,
      raw_size_text: redirect.canonicalSize,
    };
    expect(matchesBossShopCodeRedirectTarget(redirect, row)).toBe(true);
    expect(matchesBossShopCodeRedirectTarget(redirect, { ...row, barcode: "003220017210" })).toBe(false);
    expect(matchesBossShopCodeRedirectTarget(redirect, { ...row, canonical_product_uid: "TIRE_OTHER" })).toBe(false);
    expect(matchesBossShopCodeRedirectTarget(redirect, { ...row, manufacturer_part_number: "BH_OTHER" })).toBe(false);
    expect(matchesBossShopCodeRedirectTarget(redirect, { ...row, brand: "Nexen" })).toBe(false);
    expect(matchesBossShopCodeRedirectTarget(redirect, { ...row, size: "35X12.50R20", raw_size_text: "35X12.50R20" })).toBe(false);
  });

  it.each([
    ["35X12.50R17", "35125017", "3220017315"],
    ["275/55R20", "2755520", "3220017438"],
    ["245/50R20", "2455020", "77676020526"],
  ])("accepts Turso's compact %s representation %s only for frozen redirect %s", (canonicalSize, compactSize, scannedCode) => {
    const redirect = findBossShopCodeRedirect(scannedCode);
    expect(redirect).toBeDefined();
    if (!redirect) throw new Error("approved redirect missing");

    expect(matchesBossShopCodeRedirectTarget(redirect, {
      barcode: redirect.canonicalBarcode,
      canonical_product_uid: redirect.canonicalProductUid,
      manufacturer_part_number: redirect.canonicalManufacturerPartNumber,
      brand: redirect.normalizedBrand,
      size: compactSize,
      raw_size_text: compactSize,
    })).toBe(true);
    expect(redirect.canonicalSize).toBe(canonicalSize);
  });

  it("rejects a compact size belonging to another frozen redirect", () => {
    const redirect = findBossShopCodeRedirect("3220017315");
    expect(redirect).toBeDefined();
    if (!redirect) throw new Error("approved redirect missing");

    expect(matchesBossShopCodeRedirectTarget(redirect, {
      barcode: redirect.canonicalBarcode,
      canonical_product_uid: redirect.canonicalProductUid,
      manufacturer_part_number: redirect.canonicalManufacturerPartNumber,
      brand: redirect.normalizedBrand,
      size: "35125018",
      raw_size_text: "35125018",
    })).toBe(false);
  });
});
