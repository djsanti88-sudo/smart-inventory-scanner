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
const PERFECTUS_CODE = "840139632266";
const PERFECTUS_CANONICAL_UID = "TIRE_9603164D9E59F381C6FF";
const PERFECTUS_DISPLAY = "Fortune Perfectus FSR602";
const PERFECTUS_SPECS = "215/55R16 97V";
const DISTINCT_EARLIER_CODE = "840139633249";
const DISTINCT_EARLIER_SPECS = "225/50R18 95Y";
const EAN_SU318_CODE = "0758823162664";
const EAN_SU318_UPC = "758823162664";
const EAN_SU318_CANONICAL_UID = "TIRE_D419A1A03DB7FEB2FA99";
const EAN_SU318_SPECS = "255/65R16 109T";
const EAN_RP18_CODE = "0758823173844";
const EAN_RP18_UPC = "758823173844";
const EAN_RP18_CANONICAL_UID = "TIRE_6FEC84EF3585D21F491B";
const EAN_RP18_SPECS = "215/65R16 98H";
const fixture = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("@/server/knowledgeDb", () => ({ getKnowledgeDb: () => fixture.db }));

const rows = [
  { barcode: "758823190407", canonical_product_uid: "TIRE_5BAC923891027924DEE7", brand: "westlake", brand_normalized: "westlake", model: "sa07_sport", model_normalized: "sa07 sport", model_display: "SA07 Sport", size: "245/55R18", raw_size_text: "245/55R18", load_index: "103", speed_rating: "W", load_range: "", type: "", season: "", manufacturer_part_number: "24374502", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 3 },
  { barcode: "840139632266", canonical_product_uid: "TIRE_9603164D9E59F381C6FF", brand: "fortune", brand_normalized: "fortune", model: "perfectus_fsr602", model_normalized: "perfectus fsr602", model_display: "Perfectus FSR602", size: "215/55R16", raw_size_text: "215/55R16", load_index: "97", speed_rating: "V", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR602", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
  { barcode: "840139633249", canonical_product_uid: "TIRE_B540116BB71CFE6685A9", brand: "fortune", brand_normalized: "fortune", model: "viento_fsr702", model_normalized: "viento fsr702", model_display: "Viento FSR702", size: "225/50R18", raw_size_text: "225/50R18", load_index: "95", speed_rating: "Y", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR702", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
  { barcode: "758823173424", canonical_product_uid: "TIRE_FB945007547E0B24EF51", brand: "westlake", brand_normalized: "westlake", model: "rp18", model_normalized: "rp18", model_display: "RP18", size: "185/70R14", raw_size_text: "185/70R14", load_index: "88", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "24235025", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 3 },
  { barcode: "758823141713", canonical_product_uid: "TIRE_F5FA5D9E79B5EF581359", brand: "westlake", brand_normalized: "westlake", model: "sl309", model_normalized: "sl309", model_display: "SL309", size: "265/75R16", raw_size_text: "265/75R16", load_index: "123/120", speed_rating: "Q", load_range: "", type: "", season: "", manufacturer_part_number: "22279030", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 3 },
  { barcode: "758823159756", canonical_product_uid: "TIRE_1FC7676888480560C338", brand: "westlake", brand_normalized: "westlake", model: "su318_h_t", model_normalized: "su318 h t", model_display: "SU318 H T", size: "255/70R16", raw_size_text: "255/70R16", load_index: "111", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "24270005", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 3 },
  { barcode: "758823162664", canonical_product_uid: "TIRE_D419A1A03DB7FEB2FA99", brand: "westlake", brand_normalized: "westlake", model: "su318_h_t", model_normalized: "su318 h t", model_display: "SU318 H T", size: "255/65R16", raw_size_text: "255/65R16", load_index: "109", speed_rating: "T", load_range: "", type: "", season: "", manufacturer_part_number: "24585003", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 2 },
  { barcode: "758823173844", canonical_product_uid: "TIRE_6FEC84EF3585D21F491B", brand: "westlake", brand_normalized: "westlake", model: "rp18", model_normalized: "rp18", model_display: "RP18", size: "215/65R16", raw_size_text: "215/65R16", load_index: "98", speed_rating: "H", load_range: "", type: "", season: "", manufacturer_part_number: "24560018", barcode_type: "upc", confidence: "process_verified_green", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "80", missing_fields: "tire_type,season", source_count: 3 },
  { barcode: "840139633485", canonical_product_uid: "TIRE_B4242A4704C1EF6A2FA3", brand: "fortune", brand_normalized: "fortune", model: "viento_fsr702", model_normalized: "viento fsr702", model_display: "Viento FSR702", size: "275/40R19", raw_size_text: "275/40R19", load_index: "105", speed_rating: "Y", load_range: "", type: "passenger", season: "all_season", manufacturer_part_number: "FSR702", barcode_type: "upc", confidence: "verified_db", current_status: "active_retail", usable_for: "auto_count_candidate", field_completeness_score: "100", missing_fields: "", source_count: 3 },
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
    const perfectus = store.getState().scanFeed.find((event) => event.cleanCode === PERFECTUS_CODE);
    const perfectusReview = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === PERFECTUS_CODE);
    const eanSu318 = store.getState().scanFeed.find((event) => event.cleanCode === EAN_SU318_CODE);
    const eanSu318Review = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === EAN_SU318_CODE);
    const eanRp18 = store.getState().scanFeed.find((event) => event.cleanCode === EAN_RP18_CODE);
    const eanRp18Review = store.getState().needsReviewQueue.find((entry) => entry.cleanCode === EAN_RP18_CODE);
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
    expect(perfectus?.decodeStatus).toBe("verified");
    expect(perfectus?.localDemoCanonicalProductUid).toBe(PERFECTUS_CANONICAL_UID);
    expect(store.getState().products.find((product) => product.id === perfectus?.matchedProductId)?.name).toBe(PERFECTUS_DISPLAY);
    expect(perfectusReview?.suggestedSpecsShort).toBe(PERFECTUS_SPECS);
    expect(store.getState().finalCounts.find((count) => count.productId === perfectus?.matchedProductId)?.quantity).toBe(1);
    expect(eanSu318?.decodeStatus).toBe("verified");
    expect(eanSu318?.localDemoCanonicalProductUid).toBe(EAN_SU318_CANONICAL_UID);
    expect(eanSu318Review?.suggestedPrimaryBarcode).toBe(EAN_SU318_UPC);
    expect(eanSu318Review?.suggestedSpecsShort).toBe(EAN_SU318_SPECS);
    expect(store.getState().finalCounts.find((count) => count.productId === eanSu318?.matchedProductId)?.quantity).toBe(1);
    expect(eanRp18?.decodeStatus).toBe("verified");
    expect(eanRp18?.localDemoCanonicalProductUid).toBe(EAN_RP18_CANONICAL_UID);
    expect(eanRp18Review?.suggestedPrimaryBarcode).toBe(EAN_RP18_UPC);
    expect(eanRp18Review?.suggestedSpecsShort).toBe(EAN_RP18_SPECS);
    expect(store.getState().finalCounts.find((count) => count.productId === eanRp18?.matchedProductId)?.quantity).toBe(1);
  });
});
