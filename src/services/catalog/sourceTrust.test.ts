import { describe, it, expect } from "vitest";
import { classifySource, bestTier, isJunkSourceUrl, isTrustedTier } from "@/services/catalog/sourceTrust";

describe("classifySource (configurable tiers)", () => {
  it("classifies registries as authoritative", () => {
    expect(classifySource("https://gs1.org/123")).toBe("authoritative");
    expect(classifySource("https://gtin.info/00012345600012")).toBe("authoritative");
  });

  it("classifies major retailers/marketplaces as strong_commercial", () => {
    expect(classifySource("https://www.amazon.com/dp/B000")).toBe("strong_commercial");
    expect(classifySource("https://www.walmart.com/ip/123")).toBe("strong_commercial");
    expect(classifySource("https://www.target.com/p/x")).toBe("strong_commercial");
  });

  it("classifies barcode databases as supporting (incl. their /search?q= product URLs)", () => {
    // go-upc exposes products at /search?q=<code> - a known barcode DB must NOT be demoted to junk.
    expect(classifySource("https://go-upc.com/search?q=1")).toBe("supporting");
    expect(classifySource("https://www.upcitemdb.com/upc/070330611016")).toBe("supporting");
    expect(classifySource("https://eandata.com/070330611016")).toBe("supporting");
  });

  it("treats unknown hosts as supporting (never authoritative)", () => {
    expect(classifySource("https://some-random-shop.example/product/123")).toBe("supporting");
  });

  it("flags junk pages (search/cart/login/category) as weak", () => {
    expect(isJunkSourceUrl("https://store.com/cart")).toBe(true);
    expect(isJunkSourceUrl("https://store.com/login")).toBe(true);
    expect(isJunkSourceUrl("https://store.com/category/lighters")).toBe(true);
    expect(isJunkSourceUrl("https://store.com/search?q=bic")).toBe(true);
    expect(classifySource("https://www.amazon.com/s?k=bic+lighter")).toBe("weak"); // retailer search = weak
    expect(classifySource("not a url")).toBe("weak");
  });

  it("bestTier picks the most trusted source", () => {
    expect(bestTier(["https://upcitemdb.com/upc/1", "https://gs1.org/1"])).toBe("authoritative");
    expect(bestTier(["https://upcitemdb.com/upc/1", "https://amazon.com/dp/1"])).toBe("strong_commercial");
    expect(bestTier([])).toBe("weak");
  });

  it("isTrustedTier is true only for tier 1/2", () => {
    expect(isTrustedTier("authoritative")).toBe(true);
    expect(isTrustedTier("strong_commercial")).toBe(true);
    expect(isTrustedTier("supporting")).toBe(false);
    expect(isTrustedTier("weak")).toBe(false);
  });
});
