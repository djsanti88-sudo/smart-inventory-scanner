import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getKnowledgeDb: vi.fn(), getTursoClient: vi.fn(), readFileSync: vi.fn() }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: mocks.getKnowledgeDb }));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({ getTursoClient: mocks.getTursoClient }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()), readFileSync: mocks.readFileSync }));

import { __resetTireKnowledgeCacheForTests, lookupByExactBarcodeLocal } from "./tireKnowledgeIndex";

const row = { barcode: "848983007933", canonical_product_uid: "uid", brand: "Brand", brand_normalized: "brand", model: "Model", model_normalized: "model", size: "225/65R17", raw_size_text: "", load_index: "", speed_rating: "", load_range: "", type: "", season: "", manufacturer_part_number: "", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "93", missing_fields: "", source_count: 2 };

const bossTwinPairs = [
  { upc: "191563023534", ean: "0191563023534", uid: "TIRE_55254237B5B4A3EDBA4F", rawMpn: "15506", twinMpn: "NX15506", twinSources: 0 },
  { upc: "840139632891", ean: "0840139632891", uid: "TIRE_A7CF1E969FD89D80A1CC", rawMpn: "3262030504", twinMpn: "3262030504", twinSources: 1 },
  { upc: "840139634185", ean: "0840139634185", uid: "TIRE_74188C2ACA0A222D8828", rawMpn: "9315030041", twinMpn: "9315030041", twinSources: 1 },
  { upc: "840139634192", ean: "0840139634192", uid: "TIRE_9CD235EB74EC55EC1067", rawMpn: "9315030141", twinMpn: "9315030141", twinSources: 1 },
  { upc: "840139644412", ean: "0840139644412", uid: "TIRE_2F26F0539C8A2465C811", rawMpn: "9285030333", twinMpn: "9285030333", twinSources: 1 },
  { upc: "191563020021", ean: "0191563020021", uid: "TIRE_3C17C832ED7A76BE3065", rawMpn: "14079", twinMpn: "NX14079", twinSources: 0 },
  { upc: "191563001082", ean: "0191563001082", uid: "TIRE_960542DC8D8B39DD8B30", rawMpn: "16040", twinMpn: "NX16040", twinSources: 0 },
  { upc: "840139634222", ean: "0840139634222", uid: "TIRE_701E5F9AF71438E18357", rawMpn: "9315030641", twinMpn: "9315030641", twinSources: 1 },
] as const;

function demoRow(overrides: Partial<typeof row> = {}) {
  return {
    ...row,
    barcode: "191563023534",
    canonical_product_uid: "TIRE_SHARED",
    manufacturer_part_number: "15506",
    confidence: "chatgpt_1src_pattern",
    usable_for: "review_candidate",
    source_count: 1,
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); __resetTireKnowledgeCacheForTests(); });

describe("lookupByExactBarcodeLocal", () => {
  it.each(bossTwinPairs)("selects the verified EAN twin for real Boss UPC $upc", async ({ upc, ean, uid, rawMpn, twinMpn, twinSources }) => {
    const weak = demoRow({ barcode: upc, canonical_product_uid: uid, manufacturer_part_number: rawMpn });
    const trusted = demoRow({
      barcode: ean,
      canonical_product_uid: uid,
      barcode_type: "ean",
      manufacturer_part_number: twinMpn,
      confidence: "process_verified_green",
      usable_for: "auto_count_candidate",
      source_count: twinSources,
      model: "Trusted model",
      size: "235/55R19",
    });
    const get = vi.fn((code: string) => code === upc ? weak : code === ean ? trusted : undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });

    await expect(lookupByExactBarcodeLocal(upc)).resolves.toMatchObject({ ...trusted, localDemoTwinSelected: true });
  });

  it.each([
    ["different uid", { canonical_product_uid: "OTHER" }],
    ["incompatible MPN", { manufacturer_part_number: "ZZ99999" }],
    ["review companion", { usable_for: "review_candidate" }],
    ["non-green companion", { confidence: "verified_1src_strong" }],
    ["inactive companion", { current_status: "retired" }],
    ["missing model", { model: "", model_display: "" }],
    ["missing size", { size: "" }],
    ["GTIN-14 companion", { barcode: "10012345678902", barcode_type: "gtin14" }],
  ])("does not borrow a companion with %s", async (_label, patch) => {
    const weak = demoRow({ barcode: "191563023534", canonical_product_uid: "TIRE_SHARED", manufacturer_part_number: "15506" });
    const companion = demoRow({ barcode: "0191563023534", canonical_product_uid: "TIRE_SHARED", barcode_type: "ean", manufacturer_part_number: "NX15506", confidence: "process_verified_green", usable_for: "auto_count_candidate", source_count: 0, ...patch });
    const get = vi.fn((code: string) => code === weak.barcode ? weak : code === "0191563023534" ? companion : undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });
    await expect(lookupByExactBarcodeLocal(weak.barcode)).resolves.toBe(weak);
  });

  it("keeps a globally trusted raw row ahead of its twin", async () => {
    const trustedRaw = demoRow({ barcode: "191563023534", canonical_product_uid: "TIRE_SHARED", confidence: "process_verified_green", usable_for: "auto_count_candidate", source_count: 2 });
    const companion = demoRow({ barcode: "0191563023534", canonical_product_uid: "TIRE_SHARED", barcode_type: "ean", confidence: "process_verified_green", usable_for: "auto_count_candidate", source_count: 0 });
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get: (code: string) => code === trustedRaw.barcode ? trustedRaw : code === companion.barcode ? companion : undefined })) });
    await expect(lookupByExactBarcodeLocal(trustedRaw.barcode)).resolves.toBe(trustedRaw);
  });

  it("falls back to an independently trusted padded candidate when the raw encoding is absent", async () => {
    const trusted = demoRow({ barcode: "0191563023534", canonical_product_uid: "TIRE_SHARED", barcode_type: "ean", confidence: "process_verified_green", usable_for: "auto_count_candidate", source_count: 2 });
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get: (code: string) => code === trusted.barcode ? trusted : undefined })) });
    await expect(lookupByExactBarcodeLocal("191563023534")).resolves.toBe(trusted);
  });

  it("does not use a weak padded candidate when the raw encoding is absent", async () => {
    const weak = demoRow({ barcode: "0191563023534", barcode_type: "ean", source_count: 1 });
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get: (code: string) => code === weak.barcode ? weak : undefined })) });
    await expect(lookupByExactBarcodeLocal("191563023534")).resolves.toBeNull();
  });

  it.each([
    ["invalid raw checksum", { barcode: "191563023535" }, { barcode: "0191563023535" }],
    ["invalid companion checksum", {}, { barcode: "0191563023535" }],
    ["valid but non-padding barcode", {}, { barcode: "0840139632891" }],
    ["empty canonical uid", { canonical_product_uid: "" }, { canonical_product_uid: "" }],
    ["empty raw MPN", { manufacturer_part_number: "" }, {}],
    ["empty companion MPN", {}, { manufacturer_part_number: "" }],
  ])("fails closed for a %s twin pair", async (_label, rawPatch, companionPatch) => {
    const raw = demoRow({ barcode: "191563023534", canonical_product_uid: "TIRE_SHARED", manufacturer_part_number: "15506", ...rawPatch });
    const companion = demoRow({ barcode: "0191563023534", canonical_product_uid: "TIRE_SHARED", barcode_type: "ean", manufacturer_part_number: "NX15506", confidence: "process_verified_green", usable_for: "auto_count_candidate", source_count: 0, ...companionPatch });
    const expectedCompanionLookupKey = raw.barcode.length === 12 ? `0${raw.barcode}` : "0191563023534";
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get: (code: string) => code === raw.barcode ? raw : code === expectedCompanionLookupKey ? companion : undefined })) });
    await expect(lookupByExactBarcodeLocal(raw.barcode)).resolves.toBe(raw);
  });

  it("uses only SQLite for an exact hit and miss", async () => {
    const get = vi.fn((code: string) => code === row.barcode ? row : undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });
    await expect(lookupByExactBarcodeLocal(row.barcode)).resolves.toMatchObject({ barcode: row.barcode });
    await expect(lookupByExactBarcodeLocal("000000000000")).resolves.toBeNull();
    expect(mocks.getTursoClient).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it("fails closed when the SQLite statement is unavailable", async () => {
    mocks.getKnowledgeDb.mockReturnValue(null);
    await expect(lookupByExactBarcodeLocal(row.barcode)).rejects.toThrow(/local SQLite tire database is unavailable/i);
    expect(mocks.getTursoClient).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });
});
