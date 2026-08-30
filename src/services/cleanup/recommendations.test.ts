import { describe, it, expect } from "vitest";
import { buildCleanupRecommendations } from "@/services/cleanup/recommendations";
import { sanitizeCatalogEntry } from "@/products/catalog/sanitizeCatalog";
import type { Alias, InventoryCount, Product, Source } from "@/types";

function product(id: string, name: string, opts: Partial<Product> = {}): Product {
  return {
    id, businessId: "b", name, brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "human_review" as Source,
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "x", updatedBy: "x", ...opts,
  };
}
function count(id: string, productId: string, quantity = 1, aliasesSeen: string[] = []): InventoryCount {
  return {
    id, businessId: "b", sessionId: "s", productId, quantity, lastScannedAt: "t", aliasesSeen,
    scanEventIds: [], createdAt: "t", updatedAt: "t", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}
function alias(id: string, productId: string): Alias {
  return {
    id, businessId: "b", productId, rawCodeExample: id, cleanCode: id, normalizedCode: id,
    aliasType: "barcode", source: "human_review", confidence: 1, approved: true, createdAt: "t",
    updatedAt: "t", createdBy: "x", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: id,
  };
}

describe("buildCleanupRecommendations", () => {
  it("classifies junk names by reason, with high-confidence defaults checked", () => {
    const products = [
      product("p-site", "Go-UPC"),
      product("p-nav", "Add to cart"),
      product("p-search", "Search results for 123"),
      product("p-web", "randomshop.com Welcome"),
      product("p-pre", "n/a"),
      product("p-good", "BIC Classic Pocket Lighter", { source: "seed" }),
    ];
    const counts = [
      count("c-site", "p-site"), count("c-nav", "p-nav"), count("c-search", "p-search"),
      count("c-web", "p-web"), count("c-pre", "p-pre"), count("c-good", "p-good", 5),
    ];
    const { recommendations, groups } = buildCleanupRecommendations({ finalCounts: counts, products, aliases: [] });

    const byCount = Object.fromEntries(recommendations.map((r) => [r.id, r.reason]));
    expect(byCount["c-site"]).toBe("barcode_lookup_site");
    expect(byCount["c-nav"]).toBe("store_nav_text");
    expect(byCount["c-search"]).toBe("search_result_title");
    expect(byCount["c-web"]).toBe("website_title");
    expect(byCount["c-pre"]).toBe("pre_firewall_junk");
    expect(byCount["c-good"]).toBeUndefined(); // seed product never flagged
    expect(recommendations.every((r) => r.confidence !== "high" || r.defaultChecked)).toBe(true);
    expect(groups.map((g) => g.reason)).toContain("barcode_lookup_site");
  });

  it("flags an orphaned count (missing product) as high-confidence", () => {
    const { recommendations } = buildCleanupRecommendations({ finalCounts: [count("c-orphan", "p-gone")], products: [], aliases: [] });
    expect(recommendations[0].reason).toBe("orphaned_junk_product");
    expect(recommendations[0].defaultChecked).toBe(true);
  });

  it("flags generic + low-evidence AI names as medium-confidence, unchecked by default", () => {
    const products = [
      product("p-generic", "Item"),
      product("p-ai", "Some Faint Guess", { source: "ai_openai", confidence: 0.4 }),
    ];
    const counts = [count("c-generic", "p-generic"), count("c-ai", "p-ai")];
    const { recommendations } = buildCleanupRecommendations({ finalCounts: counts, products, aliases: [] });
    const map = Object.fromEntries(recommendations.map((r) => [r.id, r]));
    expect(map["c-generic"].reason).toBe("too_generic");
    expect(map["c-generic"].defaultChecked).toBe(false);
    expect(map["c-ai"].reason).toBe("low_evidence_ai");
    expect(map["c-ai"].defaultChecked).toBe(false);
  });

  it("flags a conflict with a verified catalog barcode (low confidence, unchecked)", () => {
    const products = [product("p-wrong", "Wrong Name", { primaryBarcode: "999" })];
    const counts = [count("c-wrong", "p-wrong", 1, ["999"])];
    const catalog = [
      sanitizeCatalogEntry({ barcode: "999", normalizedBarcode: "999", name: "Correct Product" }, { now: "t", verificationStatus: "verified", verifiedBy: "owner", by: "owner" }),
    ];
    const { recommendations } = buildCleanupRecommendations({ finalCounts: counts, products, aliases: [], catalog });
    expect(recommendations[0].reason).toBe("conflicts_verified_barcode");
    expect(recommendations[0].defaultChecked).toBe(false);
  });

  it("computes removesProduct + aliasIds only when no surviving good count references the product", () => {
    const products = [product("p-junk", "EANdata")];
    const counts = [count("c-junk", "p-junk")];
    const aliases = [alias("a-junk", "p-junk")];
    const { recommendations } = buildCleanupRecommendations({ finalCounts: counts, products, aliases });
    expect(recommendations[0].removesProduct).toBe(true);
    expect(recommendations[0].aliasIds).toEqual(["a-junk"]);
  });
});
