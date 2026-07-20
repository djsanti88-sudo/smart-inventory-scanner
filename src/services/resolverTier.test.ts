import { describe, it, expect } from "vitest";
import { resolveScanToProductTiered, resolveScanToProduct } from "./aliasMatcher";
import { cleanScanCode } from "@/services/scanCleaner";
import type { Product, Alias } from "@/types";

const BID = "b1";
const products: Product[] = [];
const aliases: Alias[] = [];

describe("resolveScanToProductTiered", () => {
  it("matches today's resolveScanToProduct output when no master candidates are supplied", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(cleaned, { products, aliases }, BID);
    const legacy = resolveScanToProduct(cleaned, products, aliases, BID);
    expect(tiered).toEqual(legacy);
  });

  it("accepts master candidates without changing the outcome in P2 (interface only)", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(
      cleaned,
      { products, aliases, masterCandidates: [{ productId: "m1", matchedOn: "0123456789012", provenanceTier: "corpus_verified" }] },
      BID,
    );
    expect(tiered.matchType).toBe("unknown"); // no tenant match; master slot carried, not yet compared (P5)
  });
});
