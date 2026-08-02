import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTireKnowledgeDbFixture } from "@/test/createTireKnowledgeDbFixture";
import { __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";

const seams = vi.hoisted(() => ({ ladderStorage: vi.fn(), retail: vi.fn(), learned: vi.fn(), master: vi.fn() }));
const fixture = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => fixture.db }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: seams.ladderStorage }));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({ lookupRetailBarcodeAsync: seams.retail, getLastRetailLookupStatus: () => "not_called" }));
vi.mock("@/server/learnedProducts", async (original) => ({ ...(await original<typeof import("@/server/learnedProducts")>()), getLearnedProduct: seams.learned }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: seams.master }));
import { runDecodePipeline } from "./pipeline";

const original = process.env.SCANBIN_LOCAL_DEMO;

beforeEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db = createTireKnowledgeDbFixture([{
    canonical_product_uid: "TIRE_4959A8AD1134FEABF0AC", brand: "falken", brand_normalized: "falken", model: "rubitrek_a_t", model_normalized: "rubitrek a t", model_display: "Rubitrek A T", size: "265/70R17", raw_size_text: "265/70R17", load_index: "115", speed_rating: "T", type: "light_truck", season: "all_terrain", manufacturer_part_number: "28074576", barcode: "848983007933", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", source_count: 2,
  }]);
});

afterEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db?.close();
  fixture.db = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

describe("local demo decode pipeline", () => {
  it("returns the exact local SQLite identity with a local-only canonical debug id", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const result = await runDecodePipeline({
      code: "848983007933", codeType: "upc_a", rawCodeSanitized: "848983007933", cleanCodeSanitized: "848983007933",
      threshold: 0.8, allowNonPublicAutoCount: false, forceRetry: false,
    });
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.payload.providerNames).toEqual(["local-tire-corpus"]);
    expect(result.payload.decision.status).toBe("verified");
    expect(result.payload.debug.canonicalProductUid).toBe("TIRE_4959A8AD1134FEABF0AC");
    expect(seams.ladderStorage).not.toHaveBeenCalled();
    expect(seams.retail).not.toHaveBeenCalled();
    expect(seams.learned).not.toHaveBeenCalled();
    expect(seams.master).not.toHaveBeenCalled();
  });

  it("returns a storage-free local miss before the normal decode ladder", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runDecodePipeline({
      code: "012345678905",
      codeType: "upc_a",
      rawCodeSanitized: "012345678905",
      cleanCodeSanitized: "012345678905",
      threshold: 0.8,
      allowNonPublicAutoCount: false,
      forceRetry: false,
    });

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.payload.decision.status).toBe("needs_review");
    expect(result.payload.reasonCode).toBe("no_result");
    expect(result.payload.providerNames).toEqual(["local-tire-corpus"]);
    expect(result.payload.debug).toMatchObject({
      corroborationPath: "local_demo_corpus_miss",
      ladderPath: "none",
      aiCalled: false,
      pageFetched: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seams.ladderStorage).not.toHaveBeenCalled();
    expect(seams.retail).not.toHaveBeenCalled();
    expect(seams.learned).not.toHaveBeenCalled();
    expect(seams.master).not.toHaveBeenCalled();
  });
});
