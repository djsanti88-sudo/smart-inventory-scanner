import { describe, it, expect } from "vitest";
import { toMasterCandidates, type MasterHit } from "./masterCandidates";
import { resolveScanToProductTiered } from "@/services/aliasMatcher";
import { cleanScanCode } from "@/services/scanCleaner";
import type { Product, Alias } from "@/types";

const BID = "b1";

function makeProduct(overrides: Partial<Product>): Product {
  return {
    id: "p",
    businessId: BID,
    name: "",
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: "",
    status: "active",
    source: "manual",
    confidence: 1,
    verified: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    updatedBy: "",
    ...overrides,
  } as Product;
}

function makeAlias(overrides: Partial<Alias>): Alias {
  return {
    id: "a",
    businessId: BID,
    productId: "p",
    rawCodeExample: "",
    cleanCode: "",
    normalizedCode: "",
    aliasType: "barcode",
    source: "manual",
    confidence: 1,
    approved: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    lastSeenAt: "",
    syncStatus: "synced",
    idempotencyKey: "",
    ...overrides,
  } as Alias;
}

describe("toMasterCandidates", () => {
  it("(a) no tenant candidate for this code -> []", () => {
    const code = "MC-A-0001";
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-a", name: "Wrangler HT", brand: "Goodyear" };
    const out = toMasterCandidates(hit, [], [], cleaned, BID);
    expect(out).toEqual([]);
  });

  it("(b) same brand + same name -> tenant-id candidate, tiered resolve returns the SAME product, no conflict", () => {
    const code = "MC-B-0002";
    const tenantProduct = makeProduct({ id: "prod-tenant-b", primaryBarcode: code, brand: "Goodyear", name: "Wrangler HT" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-b", name: "Wrangler HT", brand: "Goodyear", masterProvenanceTier: "ladder_verified_strong" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);

    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("prod-tenant-b");
    expect(out[0].matchedOn).toBe(code);
    expect(out[0].provenanceTier).toBe("ladder_verified_strong");

    const res = resolveScanToProductTiered(cleaned, { products: [tenantProduct], aliases: [], masterCandidates: out }, BID);
    expect(res.matchType).not.toBe("conflict");
    expect(res.productId).toBe("prod-tenant-b");
  });

  it("(c) different, non-family brand -> master: id candidate, tiered resolve returns conflict", () => {
    const code = "MC-C-0003";
    const tenantProduct = makeProduct({ id: "prod-tenant-c", primaryBarcode: code, brand: "Yokohama", name: "Geolandar" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-c", name: "Wrangler HT", brand: "Goodyear", masterProvenanceTier: "corpus_verified" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);

    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("master:master-c");
    expect(out[0].matchedOn).toBe(code);
    expect(out[0].provenanceTier).toBe("corpus_verified");

    const res = resolveScanToProductTiered(cleaned, { products: [tenantProduct], aliases: [], masterCandidates: out }, BID);
    expect(res.matchType).toBe("conflict");
    expect(res.conflictProductIds?.slice().sort()).toEqual(["master:master-c", "prod-tenant-c"]);
  });

  it("(d) Michelin/BFGoodrich family sibling -> NOT a conflict (brandFamilies)", () => {
    const code = "MC-D-0004";
    const tenantProduct = makeProduct({ id: "prod-tenant-d", primaryBarcode: code, brand: "BFGoodrich", name: "All-Terrain T/A KO2" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-d", name: "All-Terrain T/A KO2", brand: "Michelin", masterProvenanceTier: "corpus_verified" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);

    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("prod-tenant-d");

    const res = resolveScanToProductTiered(cleaned, { products: [tenantProduct], aliases: [], masterCandidates: out }, BID);
    expect(res.matchType).not.toBe("conflict");
    expect(res.productId).toBe("prod-tenant-d");
  });

  it("(e) REGRESSION LOCK (GC1 trap): raw masterId never appears as a productId when a tenant product agrees", () => {
    const code = "MC-E-0005";
    const tenantProduct = makeProduct({ id: "prod-tenant-e", primaryBarcode: code, brand: "Goodyear", name: "Wrangler HT" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "raw-master-id-should-never-leak", name: "Wrangler HT", brand: "Goodyear" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);

    for (const c of out) {
      expect(c.productId).not.toBe("raw-master-id-should-never-leak");
      expect(c.productId).not.toBe(hit.masterId);
    }
  });

  it("(f) REGRESSION LOCK (review F3): zero tenant candidates -> [], and demonstrates the phantom-known failure mode this guard prevents", () => {
    const code = "MC-F-0006";
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-f", name: "Phantom Product", brand: "NoOneOwnsThis" };

    // No tenant products/aliases resolve this code at all.
    const out = toMasterCandidates(hit, [], [], cleaned, BID);
    expect(out).toEqual([]);

    // Negative-shape demonstration: if a caller ignored this guard and fed a LONE "master:"
    // candidate straight into the tiered resolver with zero tenant products, the resolver would
    // mint a phantom "known" result pointing at a product id that does not exist in this
    // account's product list at all. This is exactly the bug GC1/review-F3 requires callers to
    // avoid by using toMasterCandidates's empty-tenant guard instead of hand-building candidates.
    const phantom = resolveScanToProductTiered(
      cleaned,
      { products: [], aliases: [], masterCandidates: [{ productId: "master:master-f", matchedOn: code, provenanceTier: "corpus_verified" }] },
      BID,
    );
    expect(phantom.matchType).not.toBe("unknown");
    expect(phantom.productId).toBe("master:master-f");
    // Proof this is a phantom: that id is not present in any real tenant product.
    expect([].some((p: Product) => p.id === phantom.productId)).toBe(false);
  });

  it("no brand on either side but names agree exactly -> tenant candidate (brand-empty agreement path)", () => {
    const code = "MC-G-0007";
    const tenantProduct = makeProduct({ id: "prod-tenant-g", primaryBarcode: code, brand: "", name: "Generic Widget" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-g", name: "Generic Widget", brand: "" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("prod-tenant-g");
  });

  it("defaults provenanceTier to corpus_verified when the hit carries none", () => {
    const code = "MC-H-0008";
    const tenantProduct = makeProduct({ id: "prod-tenant-h", primaryBarcode: code, brand: "Hankook", name: "Kinergy" });
    const cleaned = cleanScanCode(code);
    const hit: MasterHit = { masterId: "master-h", name: "Kinergy", brand: "Hankook" };

    const out = toMasterCandidates(hit, [tenantProduct], [], cleaned, BID);
    expect(out[0].provenanceTier).toBe("corpus_verified");
  });
});
