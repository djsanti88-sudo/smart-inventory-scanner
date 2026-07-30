import { normalizeTrustedCorpusTireSize } from "@/services/tire/tireSizeNormalizer";

export type BossExactEvidenceLedgerEntry = Readonly<{
  barcode: string;
  canonicalProductUid: string;
  canonicalManufacturerPartNumber: string;
  normalizedBrand: string;
  canonicalSize: string;
  bossPartNumber: string;
  sourceSheet: "Sheet1";
  sourceRow: number;
  sourceSize: string;
  evidenceKind: "boss_workbook_reconciliation_exact_barcode";
  workbookSha256: "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404";
  disposition: "accepted";
}>;

export type BossLedgerCandidate = {
  barcode?: string;
  canonical_product_uid?: string;
  manufacturer_part_number?: string;
  brand?: string;
  size?: string;
  raw_size_text?: string;
  model?: string;
  model_display?: string;
};

const WORKBOOK_SHA256 = "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404" as const;

function entry(entry: BossExactEvidenceLedgerEntry): BossExactEvidenceLedgerEntry {
  return Object.freeze(entry);
}

/** Exact accepted evidence only; this is not a source-class promotion list. */
export const BOSS_EXACT_EVIDENCE_LEDGER = Object.freeze([
  entry({ barcode: "8935341201460", canonicalProductUid: "TIRE_68FAA4E35FDBAD43F790", canonicalManufacturerPartNumber: "4120146", normalizedBrand: "blackhawk", canonicalSize: "255/50R20", bossPartNumber: "BH4120146", sourceSheet: "Sheet1", sourceRow: 336, sourceSize: "2555020", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8935341201521", canonicalProductUid: "TIRE_1FA2DBB5139B81DBB6AE", canonicalManufacturerPartNumber: "4120152", normalizedBrand: "blackhawk", canonicalSize: "225/55R18", bossPartNumber: "BH4120152", sourceSheet: "Sheet1", sourceRow: 342, sourceSize: "2255518", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8935341201668", canonicalProductUid: "TIRE_68997FE49D8595B9DCFE", canonicalManufacturerPartNumber: "4120166", normalizedBrand: "blackhawk", canonicalSize: "235/60R17", bossPartNumber: "BH4120166", sourceSheet: "Sheet1", sourceRow: 356, sourceSize: "2356017", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8859305540856", canonicalProductUid: "TIRE_87E088822962EF0503C6", canonicalManufacturerPartNumber: "40856", normalizedBrand: "arisun", canonicalSize: "285/45R22", bossPartNumber: "TH40856", sourceSheet: "Sheet1", sourceRow: 2946, sourceSize: "2854522", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
] as const);

function normalizeBrand(brand: string | undefined): string {
  return (brand ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchesBossExactEvidenceLedger(row: BossLedgerCandidate): boolean {
  const match = BOSS_EXACT_EVIDENCE_LEDGER.find((entry) => entry.barcode === row.barcode);
  if (!match) return false;
  const canonicalSize = normalizeTrustedCorpusTireSize({
    size: row.size,
    rawSizeText: row.raw_size_text,
    model: row.model,
    modelDisplay: row.model_display,
  });
  return row.canonical_product_uid === match.canonicalProductUid
    && row.manufacturer_part_number === match.canonicalManufacturerPartNumber
    && normalizeBrand(row.brand) === match.normalizedBrand
    && canonicalSize === match.canonicalSize;
}
