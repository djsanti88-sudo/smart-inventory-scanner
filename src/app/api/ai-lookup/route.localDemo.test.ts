import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTireKnowledgeDbFixture } from "@/test/createTireKnowledgeDbFixture";
import { __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ append: vi.fn(), build: vi.fn(), adminDb: vi.fn(), master: vi.fn() }));
const fixture = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => fixture.db }));
vi.mock("@/server/catalog/masterAppend", () => ({ buildMasterCatalogEntry: mocks.build, appendMasterCatalogEntry: mocks.append }));
vi.mock("@/lib/firebaseAdmin", () => ({ getAdminDb: mocks.adminDb, getAdminAuth: vi.fn() }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: mocks.master }));

import { POST } from "./route";

const original = process.env.SCANBIN_LOCAL_DEMO;
beforeEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db = createTireKnowledgeDbFixture([{
    canonical_product_uid: "TIRE_4959A8AD1134FEABF0AC", brand: "falken", brand_normalized: "falken", model: "rubitrek_a_t", model_normalized: "rubitrek a t", model_display: "Rubitrek A T", size: "265/70R17", raw_size_text: "265/70R17", load_index: "115", speed_rating: "T", type: "light_truck", season: "all_terrain", manufacturer_part_number: "28074576", barcode: "848983007933", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", source_count: 2,
  }]);
});
afterEach(() => { __resetTireKnowledgeCacheForTests(); fixture.db?.close(); fixture.db = undefined; vi.clearAllMocks(); if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO; else process.env.SCANBIN_LOCAL_DEMO = original; });
const post = (barcode: string) => POST(new Request("http://localhost/api/ai-lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "decode", rawCode: barcode }) }));

describe("local demo POST has no master/admin side effects", () => {
  it.each(["848983007933", "012345678905"])("settles %s without master append or Admin DB", async (barcode) => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const response = await post(barcode);
    expect(response.status).toBe(200);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.adminDb).not.toHaveBeenCalled();
    expect(mocks.master).not.toHaveBeenCalled();
  });
});
