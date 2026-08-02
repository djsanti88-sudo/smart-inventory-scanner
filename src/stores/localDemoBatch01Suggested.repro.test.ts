import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTireKnowledgeDbFixture } from "@/test/createTireKnowledgeDbFixture";
import { __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { detectCodeType } from "@/services/codeTypeDetector";
import { runDecodePipeline } from "@/server/decode/pipeline";

// Active local-demo manifest, batch-01 ordinals 1 through 9. The ninth scan is
// the owner-reported Fortune Viento FSR702 UPC. Keeping its real predecessors is
// essential: an earlier Fortune Viento FSR702 differs only by tire size.
const BATCH_01_PREFIX = [
  "758823190407",
  "840139632266",
  "840139633249",
  "758823173424",
  "758823141713",
  "758823159756",
  "0758823162664",
  "0758823173844",
  "840139633485",
] as const;
const TARGET_CODE = "840139633485";
const TARGET_NAME = "Fortune Viento FSR702";
const TARGET_SPECS = "275/40R19 105Y";
const DISTINCT_EARLIER_CODE = "840139633249";
const DISTINCT_EARLIER_SPECS = "225/50R18 95Y";
const fixture = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => fixture.db }));

const rows = [
  { barcode: "758823190407", canonical_product_uid: "westlake_sa07_sport_245_55r18_103_w_758823190407", brand: "westlake", brand_normalized: "westlake", model: "sa07_sport", model_normalized: "sa07 sport", model_display: "", size: "245/55R18", raw_size_text: "245/55R18", load_index: "103", speed_rating: "W", load_range: "", type: "", season: "", manufacturer_part_number: "24374502", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "840139632266", canonical_product_uid: "fortune_perfectus_fsr602_215_55r16_97_v_840139632266", brand: "fortune", brand_normalized: "fortune", model: "perfectus_fsr602", model_normalized: "perfectus fsr602", model_display: "", size: "215/55R16", raw_size_text: "215/55R16", load_index: "97", speed_rating: "V", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR602", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
  { barcode: "840139633249", canonical_product_uid: "fortune_viento_fsr702_225_50r18_95_y_840139633249", brand: "fortune", brand_normalized: "fortune", model: "viento_fsr702", model_normalized: "viento fsr702", model_display: "Viento FSR702", size: "225/50R18", raw_size_text: "225/50R18", load_index: "95", speed_rating: "Y", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR702", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
  { barcode: "758823173424", canonical_product_uid: "westlake_rp18_185_70r14_88_t_758823173424", brand: "westlake", brand_normalized: "westlake", model: "rp18", model_normalized: "rp18", model_display: "", size: "185/70R14", raw_size_text: "185/70R14", load_index: "88", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "24235025", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "758823141713", canonical_product_uid: "westlake_sl309_265_75r16_123120_q_758823141713", brand: "westlake", brand_normalized: "westlake", model: "sl309", model_normalized: "sl309", model_display: "", size: "265/75R16", raw_size_text: "265/75R16", load_index: "123/120", speed_rating: "Q", load_range: "", type: "", season: "", manufacturer_part_number: "", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "758823159756", canonical_product_uid: "westlake_su318_h_t_255_70r16_111_t_758823159756", brand: "westlake", brand_normalized: "westlake", model: "su318_h_t", model_normalized: "su318 h t", model_display: "", size: "255/70R16", raw_size_text: "255/70R16", load_index: "111", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "758823162664", canonical_product_uid: "westlake_su318_h_t_255_65r16_109_t_758823162664", brand: "westlake", brand_normalized: "westlake", model: "su318_h_t", model_normalized: "su318 h t", model_display: "", size: "255/65R16", raw_size_text: "255/65R16", load_index: "109", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "758823173844", canonical_product_uid: "westlake_rp18_215_65r16_98_h_758823173844", brand: "westlake", brand_normalized: "westlake", model: "rp18", model_normalized: "rp18", model_display: "", size: "215/65R16", raw_size_text: "215/65R16", load_index: "98", speed_rating: "H", load_range: "", type: "", season: "", manufacturer_part_number: "24560018", barcode_type: "upc", confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season,manufacturer_part_number", source_count: 3 },
  { barcode: "840139633485", canonical_product_uid: "fortune_viento_fsr702_275_40r19_105_y_840139633485", brand: "fortune", brand_normalized: "fortune", model: "viento_fsr702", model_normalized: "viento fsr702", model_display: "Viento FSR702", size: "275/40R19", raw_size_text: "275/40R19", load_index: "105", speed_rating: "Y", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR702", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
];

beforeEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db = createTireKnowledgeDbFixture(rows);
});

afterEach(() => {
  __resetTireKnowledgeCacheForTests();
  fixture.db?.close();
  fixture.db = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("local-demo batch-01 prefix regression", () => {
  it("keeps distinct Fortune Viento FSR702 GTIN sizes verified and separately counted", async () => {
    vi.stubEnv("SCANBIN_LOCAL_DEMO", "1");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: true, scanContext: "tire" });
    store.getState().setAiStatus({
      liveEnabled: false,
      freeDecodeAvailable: true,
      autoDecodeOnScan: true,
      geminiConfigured: false,
      openaiConfigured: false,
      missingKeys: [],
    });

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const code = String(body.cleanCode);
      const outcome = await runDecodePipeline({
        code,
        codeType: detectCodeType(code),
        rawCodeSanitized: code,
        cleanCodeSanitized: code,
        threshold: 0.8,
        allowNonPublicAutoCount: false,
        forceRetry: false,
      });
      if (outcome.kind !== "computed") throw new Error("local corpus did not compute");
      return { ok: true, json: async () => outcome.payload };
    }) as unknown as typeof fetch);

    for (const code of BATCH_01_PREFIX) {
      store.getState().processScan(code);
      await vi.waitFor(() => {
        expect(store.getState().needsReviewQueue.some((review) => review.cleanCode === code && review.decodeStatus !== "decoding")).toBe(true);
      });
    }

    const earlier = store.getState().scanFeed.find((event) => event.cleanCode === DISTINCT_EARLIER_CODE);
    const target = store.getState().scanFeed.find((event) => event.cleanCode === TARGET_CODE);
    const earlierReview = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === DISTINCT_EARLIER_CODE);
    const review = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === TARGET_CODE);
    // The real corpus identity and the physical count are both present before
    // the display-status assertion. A wrong product is not accepted as a fix.
    expect(store.getState().scanFeed.filter((event) => BATCH_01_PREFIX.includes(event.cleanCode as typeof BATCH_01_PREFIX[number]))).toHaveLength(BATCH_01_PREFIX.length);
    expect(store.getState().scanFeed.filter((event) => BATCH_01_PREFIX.includes(event.cleanCode as typeof BATCH_01_PREFIX[number])).every((event) => event.decodeStatus === "verified")).toBe(true);
    expect(earlierReview?.suggestedProductName).toBe(TARGET_NAME);
    expect(earlierReview?.suggestedSpecsShort).toBe(DISTINCT_EARLIER_SPECS);
    expect(earlier?.decodeStatus).toBe("verified");
    expect(review?.suggestedProductName).toBe(TARGET_NAME);
    expect(review?.suggestedSpecsShort).toBe(TARGET_SPECS);
    expect(target?.decodeStatus).toBe("verified");
    expect(earlier?.matchedProductId).not.toBe(target?.matchedProductId);
    expect(store.getState().finalCounts.find((count) => count.productId === earlier?.matchedProductId)?.quantity).toBe(1);
    expect(store.getState().finalCounts.find((count) => count.productId === target?.matchedProductId)?.quantity).toBe(1);
  });
});
