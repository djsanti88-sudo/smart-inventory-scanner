import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getKnowledgeDb: vi.fn(), getTursoClient: vi.fn(), readFileSync: vi.fn() }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: mocks.getKnowledgeDb }));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({ getTursoClient: mocks.getTursoClient }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()), readFileSync: mocks.readFileSync }));

import { __resetTireKnowledgeCacheForTests, lookupByExactBarcodeLocal } from "./tireKnowledgeIndex";

const row = { barcode: "848983007933", canonical_product_uid: "uid", brand: "Brand", brand_normalized: "brand", model: "Model", model_normalized: "model", size: "225/65R17", raw_size_text: "", load_index: "", speed_rating: "", load_range: "", type: "", season: "", manufacturer_part_number: "", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "93", missing_fields: "", source_count: 2 };

beforeEach(() => { vi.clearAllMocks(); __resetTireKnowledgeCacheForTests(); });

describe("lookupByExactBarcodeLocal", () => {
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
