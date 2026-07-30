import { describe, it, expect, beforeEach, vi } from "vitest";

// RC4 (owner-ratified pilot PN recall rule): "if only the distributor affix differs and the digits
// are identical, approve" - a part-number match is high-trust identity. resolveExactPartNumber used
// to return confidence 0.6 unconditionally; it must now grade the tier by WHICH candidate key hit:
// 0.85 when the plain (unaffixed) key hit, 0.8 when only the affix-core variant hit. Status must stay
// "suggested" and exactCodeEvidenceVerifiedByApp must stay false in both cases - a PN match never
// mints "verified" or an alias (no barcode evidence). The >=0.8 auto-apply-suggestion gate elsewhere
// (scanGates.ts) is what turns a high-confidence suggestion into a displayed, approve/decline row -
// this module only ever returns an honest suggestion.

const mockLookupByExactPartNumber = vi.fn();
const mockLookupByExactBarcode = vi.fn();
const mockLookupByExactBarcodeLocal = vi.fn();
vi.mock("@/server/tire-knowledge/tireKnowledgeIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tire-knowledge/tireKnowledgeIndex")>();
  return {
    ...actual,
    lookupByExactPartNumber: (pn: string) => mockLookupByExactPartNumber(pn),
    lookupByExactBarcode: (code: string) => mockLookupByExactBarcode(code),
    lookupByExactBarcodeLocal: (code: string) => mockLookupByExactBarcodeLocal(code),
  };
});

import { resolveExactPartNumber, resolveExactBarcode, resolveExactBarcodeLocal } from "@/server/tire-knowledge/TireKnowledgeProvider";

const CORPUS_ROW = {
  canonical_product_uid: "uid-1",
  brand: "hankook",
  brand_normalized: "hankook",
  model: "Dynapro",
  model_normalized: "dynapro",
  model_display: "Dynapro AT2 Xtreme",
  size: "265/70R17",
  raw_size_text: "P265/70R17",
  load_index: "113",
  speed_rating: "S",
  load_range: "SL",
  type: "all_season",
  season: "all_season",
  manufacturer_part_number: "2265992",
  barcode: "029142869880",
  barcode_type: "upc_a",
  confidence: "verified_2src",
  current_status: "active",
  usable_for: "sale",
  field_completeness_score: "1.0",
  missing_fields: "",
  source_count: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveExactPartNumber - confidence tiers (RC4)", () => {
  it("returns null on a corpus miss", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(null);
    const result = await resolveExactPartNumber("BH4120176");
    expect(result).toBeNull();
  });

  it("plain (unaffixed) PN match: confidence 0.85, status suggested, exactCodeEvidenceVerifiedByApp false", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("2265992");

    expect(result).not.toBeNull();
    expect(result!.decision.status).toBe("suggested");
    expect(result!.decision.confidence).toBe(0.85);
    expect(result!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
    expect(result!.results[0].trustedStructuredModel).toBeUndefined();
  });

  it("distributor-affix PN match (e.g. KH2265992): confidence 0.8, status suggested, exactCodeEvidenceVerifiedByApp false", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");

    expect(result).not.toBeNull();
    expect(result!.decision.status).toBe("suggested");
    expect(result!.decision.confidence).toBe(0.8);
    expect(result!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("never returns status verified, regardless of tier", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const plain = await resolveExactPartNumber("2265992");
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const affixed = await resolveExactPartNumber("F-2265992");

    expect(plain!.decision.status).not.toBe("verified");
    expect(affixed!.decision.status).not.toBe("verified");
  });

  it("reason text is honest and customer-safe: no internal rung/module names leaked", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");

    const reason = result!.decision.reason.toLowerCase();
    expect(reason).toContain("part number");
    expect(reason).not.toMatch(/rung|ladder|tirekn|gpt|goupc|fetchv2/i);
  });

  it("distributor-affix reason mentions the prefix was stripped", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");
    expect(result!.decision.reason.toLowerCase()).toContain("prefix");
  });

  // MINOR PIN (review finding): an affix-core-tier hit is the WEAKEST PN tier this module ever returns
  // (0.8, the exact floor of the store's >=0.8 auto-apply-suggestion gate in scanGates.ts). Pin the
  // ceiling explicitly so a future change to this module cannot accidentally let a core-only match
  // escalate past a suggestion - it must stay exactly {status: "suggested", confidence: 0.8,
  // exactCodeEvidenceVerifiedByApp: false}, never "verified", never a higher confidence, and never an
  // app-verified exact-code claim (a PN match has no barcode evidence to verify).
  it("MINOR PIN: an affix-core-tier match can never escalate beyond a suggestion (status/confidence/verified-flag ceiling)", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992"); // affix-core hit: "KH2265992" -> core "2265992"

    expect(result).not.toBeNull();
    expect(result!.decision).toMatchObject({
      status: "suggested",
      confidence: 0.8,
      exactCodeEvidenceVerifiedByApp: false,
    });
    // Explicit ceiling: never verified, never above the affix-core tier's own confidence.
    expect(result!.decision.status).not.toBe("verified");
    expect(result!.decision.confidence).toBeLessThanOrEqual(0.8);
  });
});

// BUG FIX (PN-resolved suggestion's barcode never carries through, owner-reported live on preview):
// 78,201 of 78,223 real corpus rows store barcode_type as "upc"/"ean"/"gtin14" (the generator's actual
// output convention), NOT "upc_a"/"ean_13"/"gtin_14" as the mapper's switch previously assumed. Every
// one of those rows silently dropped its barcode into no field at all. Root-caused via a direct count
// over tireKnowledge.generated.json (see pn-barcode-carry-report.md). Both conventions must map, and
// primaryBarcode must ALWAYS carry the row's barcode when present, regardless of which type string.
const KUMHO_ROW_REAL_CONVENTION = {
  canonical_product_uid: "kumho_crugen_hp71_245_60r18_105_h_2265992",
  brand: "kumho",
  brand_normalized: "kumho",
  model: "crugen_hp71",
  model_normalized: "crugen hp71",
  model_display: "Crugen HP71",
  size: "245/60R18",
  raw_size_text: "245/60R18",
  load_index: "105",
  speed_rating: "H",
  load_range: "",
  type: "touring",
  season: "",
  manufacturer_part_number: "2265992",
  barcode: "8808956277338",
  barcode_type: "ean", // real-world convention, NOT "ean_13"
  confidence: "verified_1src_strong",
  current_status: "active_retail",
  usable_for: "auto_count_candidate",
  field_completeness_score: "93",
  missing_fields: "season",
  source_count: 0,
};

describe("toResult barcode_type convention mismatch (real corpus uses upc/ean/gtin14, not upc_a/ean_13/gtin_14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PN lookup for KH2265992-class row with barcode_type 'ean' carries the barcode into result.ean AND result.primaryBarcode", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(KUMHO_ROW_REAL_CONVENTION);
    const result = await resolveExactPartNumber("KH2265992");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("8808956277338");
    expect(decoded.ean).toBe("8808956277338");
    expect(decoded.upc).toBe("");
    expect(decoded.gtin).toBe("");
  });

  it("barcode_type 'upc' (real convention) carries into result.upc AND result.primaryBarcode", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "848983006257", barcode_type: "upc" });
    const result = await resolveExactBarcode("848983006257");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("848983006257");
    expect(decoded.upc).toBe("848983006257");
    expect(decoded.ean).toBe("");
    expect(decoded.gtin).toBe("");
    expect(decoded.productName).toContain("Crugen HP71");
    expect(decoded.trustedStructuredModel).toBe("Crugen HP71");
  });

  it("uses model_display for the customer name and exact corpus-only structured model", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({
      ...KUMHO_ROW_REAL_CONVENTION,
      model: "SU318_H_T",
      model_display: "SU318 H T",
    });

    const result = await resolveExactBarcode("848983006257");

    expect(result!.results[0]).toMatchObject({
      productName: expect.stringContaining("SU318 H T"),
      trustedStructuredModel: "SU318 H T",
    });
  });

  it("uses the exact trimmed raw model when model_display is blank", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({
      ...KUMHO_ROW_REAL_CONVENTION,
      model: "SU318_H_T",
      model_display: "   ",
    });

    const result = await resolveExactBarcode("848983006257");

    expect(result!.results[0].productName).toContain("SU318 H T");
    expect(result!.results[0].trustedStructuredModel).toBe("SU318_H_T");
  });

  it("barcode_type 'gtin14' (real convention) carries into result.gtin AND result.primaryBarcode", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "10848983006254", barcode_type: "gtin14" });
    const result = await resolveExactBarcode("10848983006254");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("10848983006254");
    expect(decoded.gtin).toBe("10848983006254");
    expect(decoded.upc).toBe("");
    expect(decoded.ean).toBe("");
  });

  it("legacy 'upc_a' convention still works (backward compat)", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "029142869880", barcode_type: "upc_a" });
    const result = await resolveExactBarcode("029142869880");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("029142869880");
    expect(decoded.upc).toBe("029142869880");
  });

  it("legacy 'ean_13' convention still works (backward compat)", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "8808956277338", barcode_type: "ean_13" });
    const result = await resolveExactBarcode("8808956277338");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("8808956277338");
    expect(decoded.ean).toBe("8808956277338");
  });

  it("legacy 'gtin_14' convention still works (backward compat)", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "10848983006254", barcode_type: "gtin_14" });
    const result = await resolveExactBarcode("10848983006254");

    expect(result).not.toBeNull();
    const decoded = result!.results[0];
    expect(decoded.primaryBarcode).toBe("10848983006254");
    expect(decoded.gtin).toBe("10848983006254");
  });

  it("primaryBarcode is ALWAYS set from the row's barcode even for an unrecognized barcode_type string", async () => {
    mockLookupByExactBarcode.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "8808956277338", barcode_type: "something_new" });
    const result = await resolveExactBarcode("8808956277338");

    expect(result).not.toBeNull();
    expect(result!.results[0].primaryBarcode).toBe("8808956277338");
  });
});

describe("resolveExactBarcodeLocal", () => {
  it("accepts only the conservative local SQLite row and exposes its canonical id", async () => {
    mockLookupByExactBarcodeLocal.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "848983006257", barcode_type: "upc", source_count: 2 });
    const result = await resolveExactBarcodeLocal("848983006257");
    expect(result).toMatchObject({ providerNames: ["local-tire-corpus"], canonicalProductUid: KUMHO_ROW_REAL_CONVENTION.canonical_product_uid, decision: { status: "verified" } });
  });

  it("fails closed for source-one and GTIN-14 rows", async () => {
    mockLookupByExactBarcodeLocal.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "848983006257", barcode_type: "upc", source_count: 1 });
    await expect(resolveExactBarcodeLocal("848983006257")).resolves.toBeNull();
    mockLookupByExactBarcodeLocal.mockResolvedValueOnce({ ...KUMHO_ROW_REAL_CONVENTION, barcode: "10012345678902", barcode_type: "gtin14", source_count: 2 });
    await expect(resolveExactBarcodeLocal("10012345678902")).resolves.toBeNull();
  });
});
