import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
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
