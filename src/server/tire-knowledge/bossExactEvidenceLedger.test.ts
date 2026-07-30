import { describe, expect, it } from "vitest";

import {
  BOSS_EXACT_EVIDENCE_LEDGER,
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
