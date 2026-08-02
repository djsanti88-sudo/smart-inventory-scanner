import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTireKnowledgeDbFixture } from "@/test/createTireKnowledgeDbFixture";
import { lookupByExactBarcode, lookupByExactPartNumber, getTireKnowledgeMeta, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { resolveExactBarcode, resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { isTireContext, hasRequiredTireSpecs } from "@/services/ai/tireSpecs";

// Server-only tire knowledge: EXACT trusted-barcode hits resolve a verified tire WITHOUT AI; misses + the
// poison + near-matches return null (fall through to the existing AI path). Runs against the REAL committed
// generated index (Cooper 029142869870 + Falken 848983006165 from the bootstrap seed).

const fixture = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => fixture.db }));

const rows = [
  { canonical_product_uid: "TIRE_2A3B66D9145A3CA4988B", brand: "cooper", brand_normalized: "cooper", model: "discoverer_srx", model_normalized: "discoverer srx", model_display: "Discoverer SRX", size: "265/70R17", raw_size_text: "265/70R17", load_index: "115", speed_rating: "T", type: "passenger", season: "highway", manufacturer_part_number: "90000027117", barcode: "029142869870", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", source_count: 0 },
  { canonical_product_uid: "TIRE_519C1EBA8A0D68DF4287", brand: "falken", brand_normalized: "falken", model: "wildpeak_a_t3w", model_normalized: "wildpeak a t3w", model_display: "Wildpeak A/T3W", size: "245/75R17", manufacturer_part_number: "28034764", barcode: "848983006165", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "73", source_count: 0 },
  { canonical_product_uid: "TIRE_91AA4F4FBCB614BE62A9", brand: "cooper", brand_normalized: "cooper", model: "zeon_crossrange", model_normalized: "zeon crossrange", model_display: "ZEON Crossrange", size: "255/45R20", raw_size_text: "255/45R20", load_index: "105", speed_rating: "H", season: "all_season", manufacturer_part_number: "160085014", barcode: "029142980407", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "93", source_count: 0 },
  { canonical_product_uid: "TIRE_AMBIGUOUS", brand: "cooper", brand_normalized: "cooper", model: "ambiguous", model_normalized: "ambiguous", size: "255/45R20", manufacturer_part_number: "90000027117", barcode: "029142980408", barcode_type: "upc", confidence: "verified_1src_strong", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "93", source_count: 0 },
];

beforeEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db = createTireKnowledgeDbFixture(rows);
});
afterEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db?.close();
  fixture.db = undefined;
});

describe("tireKnowledgeIndex - exact lookup", () => {
  it("creates an owned in-memory tires table from explicitly supplied rows", () => {
    const db = createTireKnowledgeDbFixture([{
      canonical_product_uid: "fixture:cooper:1", brand: "Cooper", brand_normalized: "cooper", model: "Discoverer AT3", model_normalized: "discovererat3", size: "245/75R16", barcode: "029142712886", barcode_type: "upc", confidence: "verified", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", source_count: 2,
    }]);
    try {
      expect(db.prepare("SELECT brand FROM tires WHERE barcode = ?").get("029142712886")).toEqual({ brand: "Cooper" });
    } finally {
      db.close();
    }
  });
  it("resolves an exact trusted barcode (leading-zero UPC preserved as string)", async () => {
    const row = await lookupByExactBarcode("029142869870");
    expect(row?.brand).toBe("cooper");
    expect(row?.barcode).toBe("029142869870"); // leading zero intact
  });

  it("normalizes scanner separators but never numeric-converts", async () => {
    expect((await lookupByExactBarcode("0 29142-869870"))?.brand).toBe("cooper");
  });

  it("MISS for an unknown barcode -> null (falls through to AI)", async () => {
    expect(await lookupByExactBarcode("012345678905")).toBeNull();
  });

  it("POISON 745125495781 is NOT in the corpus -> null (never a corpus hit)", async () => {
    expect(await lookupByExactBarcode("745125495781")).toBeNull();
  });

  it("NEAR-MATCH 7451254957818 is not in the corpus, and never equates to 745125495781", async () => {
    expect(await lookupByExactBarcode("7451254957818")).toBeNull();
    expect(await lookupByExactBarcode("745125495781")).toBeNull();
  });

  it("ambiguous part-number lookup fails closed while a unique part number resolves", async () => {
    expect(await lookupByExactPartNumber("90000027117")).toBeNull();
    expect((await lookupByExactPartNumber("160085014"))?.brand).toBe("cooper");
    expect(await lookupByExactPartNumber("NOT-A-PART")).toBeNull();
  });

  it("exposes metadata for diagnostics", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta?.barcode_index_count).toBeGreaterThanOrEqual(2);
  });
});

describe("TireKnowledgeProvider - decode result + safety", () => {
  it("exact barcode -> VERIFIED, app-verified, conf>=0.9, path=corpus_exact_barcode, full tire specs", async () => {
    const r = await resolveExactBarcode("029142869870");
    expect(r).not.toBeNull();
    expect(r!.decision.status).toBe("verified");
    expect(r!.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r!.decision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r!.decision.corroborationPath).toBe("corpus_exact_barcode");
    const product = r!.results[0];
    expect(isTireContext(product)).toBe(true);
    expect(hasRequiredTireSpecs(product)).toBe(true); // size + load + speed grounded by the corpus
  });

  it("PRIVACY: the corpus result carries NO source URLs (no global-corpus leak to the decode response)", async () => {
    const r = await resolveExactBarcode("029142869870");
    expect(r!.results[0].sourceUrls).toEqual([]);
  });

  it("NO network call: resolving an exact barcode never calls fetch (no AI, no page fetch)", async () => {
    const orig = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await resolveExactBarcode("848983006165");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("MISS -> null so the existing AI path runs unchanged", async () => {
    expect(await resolveExactBarcode("012345678905")).toBeNull();
  });

  it("POISON -> null (never a corpus auto-count); never near-matches", async () => {
    expect(await resolveExactBarcode("745125495781")).toBeNull();
  });

  it("ambiguous part number stays unresolved while a unique part number is SUGGESTED", async () => {
    expect(await resolveExactPartNumber("90000027117")).toBeNull();

    const r = await resolveExactPartNumber("160085014");
    expect(r!.decision.status).toBe("suggested");
    expect(r!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("lazy load: works after a cache reset (re-reads the generated index)", async () => {
    __resetTireKnowledgeCacheForTests();
    expect((await resolveExactBarcode("029142869870"))!.decision.status).toBe("verified");
  });
});
