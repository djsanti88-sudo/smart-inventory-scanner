import { describe, it, expect } from "vitest";
import {
  decideLookup,
  upsertVerified,
  applyAiCandidate,
  observeScan,
} from "@/products/catalog/localCatalogProvider";
import { sanitizeCatalogEntry } from "@/products/catalog/sanitizeCatalog";
import type { CatalogEntry, ShopOverride } from "@/products/catalog/catalogTypes";

const NOW = "2026-06-14T00:00:00.000Z";

function verifiedEntry(code: string, name: string): CatalogEntry {
  return sanitizeCatalogEntry(
    { barcode: code, normalizedBarcode: code, name },
    { now: NOW, verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
  );
}
function override(businessId: string, code: string, name: string, verified = true): ShopOverride {
  return {
    businessId, normalizedBarcode: code, name, brand: "", category: "", size: "", imageUrl: "",
    productUrl: "", note: "", verified, createdAt: NOW, updatedAt: NOW, createdBy: "human",
  };
}

describe("decideLookup precedence (override BEFORE catalog)", () => {
  it("a verified shop override wins over the global catalog and skips AI", () => {
    const catalog = [verifiedEntry("123", "Global Catalog Name")];
    const overrides = [override("shop-1", "123", "Shop Override Name")];
    const d = decideLookup(catalog, overrides, ["123"], "shop-1");
    expect(d.source).toBe("shop_override");
    expect(d.hit?.name).toBe("Shop Override Name");
    expect(d.shouldResolveWithoutAi).toBe(true);
    expect(d.shouldTryAi).toBe(false);
  });

  it("an override for a DIFFERENT shop does not apply; global verified catalog is used", () => {
    const catalog = [verifiedEntry("123", "Global Catalog Name")];
    const overrides = [override("shop-OTHER", "123", "Other Shop Name")];
    const d = decideLookup(catalog, overrides, ["123"], "shop-1");
    expect(d.source).toBe("verified_catalog");
    expect(d.hit?.name).toBe("Global Catalog Name");
    expect(d.shouldResolveWithoutAi).toBe(true);
  });

  it("a verified catalog entry resolves without AI", () => {
    const d = decideLookup([verifiedEntry("123", "Coke")], [], ["123"], "shop-1");
    expect(d.source).toBe("verified_catalog");
    expect(d.shouldResolveWithoutAi).toBe(true);
    expect(d.shouldTryAi).toBe(false);
  });

  it("a pending/weak catalog entry suggests but still allows AI", () => {
    const pending = sanitizeCatalogEntry(
      { barcode: "9", normalizedBarcode: "9", name: "Maybe", confidence: 0.4 },
      { now: NOW, verificationStatus: "pending", verifiedBy: null, by: "ai" },
    );
    const d = decideLookup([pending], [], ["9"], "shop-1");
    expect(d.source).toBe("weak_catalog");
    expect(d.shouldResolveWithoutAi).toBe(false);
    expect(d.shouldTryAi).toBe(true);
  });

  it("a miss falls through to AI", () => {
    const d = decideLookup([], [], ["nope"], "shop-1");
    expect(d.source).toBe("none");
    expect(d.shouldResolveWithoutAi).toBe(false);
    expect(d.shouldTryAi).toBe(true);
  });
});

describe("catalog writes", () => {
  it("upsertVerified creates then strengthens a verified entry", () => {
    let catalog = upsertVerified([], { barcode: "123", normalizedBarcode: "123", name: "Coke" }, NOW, "owner");
    expect(catalog).toHaveLength(1);
    expect(catalog[0].verificationStatus).toBe("verified");
    catalog = upsertVerified(catalog, { barcode: "123", normalizedBarcode: "123", name: "Coke" }, NOW, "owner");
    expect(catalog).toHaveLength(1);
    expect(catalog[0].timesConfirmed).toBe(2);
  });

  it("AI can NEVER overwrite a verified entry's identity or status", () => {
    const catalog = upsertVerified([], { barcode: "123", normalizedBarcode: "123", name: "Real Coke" }, NOW, "owner");
    const after = applyAiCandidate(
      catalog,
      { barcode: "123", normalizedBarcode: "123", name: "WRONG AI Guess", confidence: 0.99 },
      NOW,
    );
    expect(after[0].name).toBe("Real Coke"); // identity preserved
    expect(after[0].verificationStatus).toBe("verified"); // status preserved
    expect(after[0].auditLog.some((a) => a.action === "ai_observed")).toBe(true);
  });

  it("AI creates a pending entry when none exists", () => {
    const after = applyAiCandidate([], { barcode: "9", normalizedBarcode: "9", name: "New Guess" }, NOW);
    expect(after[0].verificationStatus).toBe("pending");
    expect(after[0].verifiedBy).toBeNull();
  });

  it("observeScan bumps usage without changing identity", () => {
    const catalog = upsertVerified([], { barcode: "123", normalizedBarcode: "123", name: "Coke" }, NOW, "owner");
    const after = observeScan(catalog, ["123"], NOW);
    expect(after[0].timesScanned).toBe(2);
    expect(after[0].timesConfirmed).toBe(2);
    expect(after[0].name).toBe("Coke");
  });
});
