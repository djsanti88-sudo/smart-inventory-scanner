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

export type BossShopCodeRedirect = Readonly<{
  scannedCode: string;
  canonicalBarcode: string;
  canonicalProductUid: string;
  canonicalManufacturerPartNumber: string;
  normalizedBrand: string;
  canonicalSize: string;
  sourceSheet: "Sheet1";
  sourceRow: number;
  evidenceKind: "boss_workbook_reconciliation_shop_code_redirect";
  workbookSha256: "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404";
  disposition: "accepted";
}>;

const WORKBOOK_SHA256 = "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404" as const;

function entry(entry: BossExactEvidenceLedgerEntry): BossExactEvidenceLedgerEntry {
  return Object.freeze(entry);
}

function shopCodeRedirect(redirect: BossShopCodeRedirect): BossShopCodeRedirect {
  return Object.freeze(redirect);
}

/** Exact accepted evidence only; this is not a source-class promotion list. */
export const BOSS_EXACT_EVIDENCE_LEDGER = Object.freeze([
  entry({ barcode: "8935341201460", canonicalProductUid: "TIRE_68FAA4E35FDBAD43F790", canonicalManufacturerPartNumber: "4120146", normalizedBrand: "blackhawk", canonicalSize: "255/50R20", bossPartNumber: "BH4120146", sourceSheet: "Sheet1", sourceRow: 336, sourceSize: "2555020", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8935341201521", canonicalProductUid: "TIRE_1FA2DBB5139B81DBB6AE", canonicalManufacturerPartNumber: "4120152", normalizedBrand: "blackhawk", canonicalSize: "225/55R18", bossPartNumber: "BH4120152", sourceSheet: "Sheet1", sourceRow: 342, sourceSize: "2255518", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8935341201668", canonicalProductUid: "TIRE_68997FE49D8595B9DCFE", canonicalManufacturerPartNumber: "4120166", normalizedBrand: "blackhawk", canonicalSize: "235/60R17", bossPartNumber: "BH4120166", sourceSheet: "Sheet1", sourceRow: 356, sourceSize: "2356017", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  entry({ barcode: "8859305540856", canonicalProductUid: "TIRE_87E088822962EF0503C6", canonicalManufacturerPartNumber: "40856", normalizedBrand: "arisun", canonicalSize: "285/45R22", bossPartNumber: "TH40856", sourceSheet: "Sheet1", sourceRow: 2946, sourceSize: "2854522", evidenceKind: "boss_workbook_reconciliation_exact_barcode", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
] as const);

/** Frozen shop-code redirects backed by the same workbook reconciliation evidence. */
export const BOSS_SHOP_CODE_REDIRECTS: readonly BossShopCodeRedirect[] = Object.freeze([
  shopCodeRedirect({ scannedCode: "3220017209", canonicalBarcode: "003220017209", canonicalProductUid: "TIRE_688C82A02536FEEFBA1C", canonicalManufacturerPartNumber: "BH1600462", normalizedBrand: "blackhawk", canonicalSize: "33X12.50R20", sourceSheet: "Sheet1", sourceRow: 16, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220017315", canonicalBarcode: "003220017315", canonicalProductUid: "TIRE_2F2263B3167393AB7EA5", canonicalManufacturerPartNumber: "BH1600467", normalizedBrand: "blackhawk", canonicalSize: "35X12.50R17", sourceSheet: "Sheet1", sourceRow: 21, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220017438", canonicalBarcode: "003220017438", canonicalProductUid: "TIRE_D0F7590DC52EB30084BC", canonicalManufacturerPartNumber: "BH1600479", normalizedBrand: "blackhawk", canonicalSize: "275/55R20", sourceSheet: "Sheet1", sourceRow: 33, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220017483", canonicalBarcode: "003220017483", canonicalProductUid: "TIRE_C403AC1F3DB3491E7E3B", canonicalManufacturerPartNumber: "BH1600487", normalizedBrand: "blackhawk", canonicalSize: "265/75R16", sourceSheet: "Sheet1", sourceRow: 41, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220018367", canonicalBarcode: "003220018367", canonicalProductUid: "TIRE_D207F9B2A5E9E7010EFB", canonicalManufacturerPartNumber: "BH4120851", normalizedBrand: "blackhawk", canonicalSize: "235/70R16", sourceSheet: "Sheet1", sourceRow: 391, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220018381", canonicalBarcode: "003220018381", canonicalProductUid: "TIRE_751C135054BD4468225F", canonicalManufacturerPartNumber: "BH4120857", normalizedBrand: "blackhawk", canonicalSize: "245/75R16", sourceSheet: "Sheet1", sourceRow: 397, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220018411", canonicalBarcode: "003220018411", canonicalProductUid: "TIRE_DC7B51A10E3EEF677592", canonicalManufacturerPartNumber: "BH4120867", normalizedBrand: "blackhawk", canonicalSize: "245/75R17", sourceSheet: "Sheet1", sourceRow: 407, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220018428", canonicalBarcode: "003220018428", canonicalProductUid: "TIRE_544F4F079893176C1521", canonicalManufacturerPartNumber: "BH4120879", normalizedBrand: "blackhawk", canonicalSize: "35X12.50R18", sourceSheet: "Sheet1", sourceRow: 419, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "3220018435", canonicalBarcode: "003220018435", canonicalProductUid: "TIRE_A76115D4AC263F54A952", canonicalManufacturerPartNumber: "BH4120886", normalizedBrand: "blackhawk", canonicalSize: "285/60R20", sourceSheet: "Sheet1", sourceRow: 426, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
  shopCodeRedirect({ scannedCode: "77676020526", canonicalBarcode: "077676020526", canonicalProductUid: "TIRE_8FF5C1A475EFB383981F", canonicalManufacturerPartNumber: "NX10557", normalizedBrand: "nexen", canonicalSize: "245/50R20", sourceSheet: "Sheet1", sourceRow: 1734, evidenceKind: "boss_workbook_reconciliation_shop_code_redirect", workbookSha256: WORKBOOK_SHA256, disposition: "accepted" }),
]);

function normalizeShopCode(scannedCode: string): string {
  return scannedCode.replaceAll(" ", "").replaceAll("-", "");
}

const BOSS_SHOP_CODE_REDIRECTS_BY_NORMALIZED_CODE: ReadonlyMap<string, BossShopCodeRedirect> = (() => {
  const redirects = new Map<string, BossShopCodeRedirect>();
  for (const redirect of BOSS_SHOP_CODE_REDIRECTS) {
    const normalizedCode = normalizeShopCode(redirect.scannedCode);
    const existing = redirects.get(normalizedCode);
    if (existing && existing.canonicalProductUid !== redirect.canonicalProductUid) {
      throw new Error(`Conflicting Boss shop-code redirect for ${normalizedCode}`);
    }
    redirects.set(normalizedCode, redirect);
  }
  return redirects;
})();

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

/** Looks up only a frozen exact shop-code redirect after scanner separator normalization. */
export function findBossShopCodeRedirect(scannedCode: string): BossShopCodeRedirect | undefined {
  return BOSS_SHOP_CODE_REDIRECTS_BY_NORMALIZED_CODE.get(normalizeShopCode(scannedCode));
}

export function matchesBossShopCodeRedirectTarget(redirect: BossShopCodeRedirect, row: BossLedgerCandidate): boolean {
  const canonicalSize = normalizeTrustedCorpusTireSize({
    size: row.size,
    rawSizeText: row.raw_size_text,
    model: row.model,
    modelDisplay: row.model_display,
  });
  // Turso's trusted tire rows occasionally retain a size as compact digits. This fallback is
  // intentionally usable only after an exact frozen redirect lookup and only against that
  // redirect's own canonical size; it does not widen corpus or scanner matching.
  const hasExactCompactRedirectSize = canonicalSize === null && [row.size, row.raw_size_text]
    .some((value) => value?.trim() === redirect.canonicalSize.replace(/\D/g, ""));
  return row.barcode === redirect.canonicalBarcode
    && row.canonical_product_uid === redirect.canonicalProductUid
    && row.manufacturer_part_number === redirect.canonicalManufacturerPartNumber
    && normalizeBrand(row.brand) === redirect.normalizedBrand
    && (canonicalSize === redirect.canonicalSize || hasExactCompactRedirectSize);
}
