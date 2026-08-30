import { describe, it, expect } from "vitest";
import { sanitizeCatalogEntry, safeHttpUrl, isCatalogWritable, toMasterAwareStoreEntry } from "@/products/catalog/sanitizeCatalog";
import type { CatalogCandidate, CatalogEntryMeta } from "@/products/catalog/catalogTypes";

const META: CatalogEntryMeta = { now: "2026-06-14T00:00:00.000Z", verificationStatus: "verified", verifiedBy: "owner", by: "owner" };

describe("sanitizeCatalogEntry (global catalog stays clean + non-private)", () => {
  it("drops any private/extra fields, keeping only allowed catalog content", () => {
    const candidate = {
      barcode: "070330611016", normalizedBarcode: "070330611016", barcodeType: "upc_a",
      name: "BIC Classic Pocket Lighter", brand: "BIC", category: "Lighters",
      // private/sensitive fields that must NEVER reach the global catalog:
      businessId: "shop-123", price: 4.99, cost: 1.2, margin: 0.7, note: "customer John Doe asked",
      ownerEmail: "djsanti88@gmail.com",
    } as unknown as CatalogCandidate;

    const entry = sanitizeCatalogEntry(candidate, META) as unknown as Record<string, unknown>;

    for (const banned of ["businessId", "price", "cost", "margin", "note", "ownerEmail"]) {
      expect(entry[banned], banned).toBeUndefined();
    }
    expect(entry.name).toBe("BIC Classic Pocket Lighter");
    expect(entry.verificationStatus).toBe("verified");
    expect(entry.timesConfirmed).toBe(1);
    expect(entry.aliases).toContain("070330611016");
  });

  it("restricts URLs to http(s); drops javascript:/file:/malformed", () => {
    expect(safeHttpUrl("https://go-upc.com/x")).toBe("https://go-upc.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();

    const entry = sanitizeCatalogEntry(
      {
        barcode: "1", normalizedBarcode: "1", name: "Real Product",
        imageUrl: "javascript:alert(1)",
        sourceUrls: ["https://ok.example/x", "file:///secret", "ftp://nope"],
      },
      META,
    );
    expect(entry.imageUrl).toBe("");
    expect(entry.sourceUrls).toEqual(["https://ok.example/x"]);
  });

  it("isCatalogWritable rejects junk titles, accepts real names", () => {
    expect(isCatalogWritable("UPC Barcode Search — Look up any UPC, EAN, or ISBN")).toBe(false);
    expect(isCatalogWritable("EANdata")).toBe(false);
    expect(isCatalogWritable("BIC Classic Pocket Lighter")).toBe(true);
  });

  it("a pending (AI) entry starts unconfirmed", () => {
    const entry = sanitizeCatalogEntry(
      { barcode: "9", normalizedBarcode: "9", name: "Maybe Product" },
      { ...META, verificationStatus: "pending", verifiedBy: null, by: "ai" },
    );
    expect(entry.verificationStatus).toBe("pending");
    expect(entry.timesConfirmed).toBe(0);
    expect(entry.auditLog[0]).toMatchObject({ action: "created", by: "ai" });
  });
});

// FIX 1 (review HIGH, retail provenance): toMasterAwareStoreEntry must tag masterId/masterProvenanceTier
// ONLY when the caller marks the hit as coming from the TIRE master catalog. A retail (Open Food Facts)
// hit must never carry a masterId - doing so would run it through the tire-master cross-tier conflict
// machinery under a defaulted "corpus_verified" tier it never earned.
describe("toMasterAwareStoreEntry (Phase 5b GC4 - master provenance tagging)", () => {
  const raw = {
    id: "gtin_012345678905",
    normalizedBarcode: "012345678905",
    name: "Some Product",
    brand: "SomeBrand",
    category: "",
    verificationStatus: "verified",
    provenanceTier: "ladder_verified_strong" as const,
  };

  it("tire-master hit (isMaster:true) carries masterId + masterProvenanceTier", () => {
    const entry = toMasterAwareStoreEntry(raw, true, "2026-07-20T00:00:00.000Z");
    expect(entry.masterId).toBe("gtin_012345678905");
    expect(entry.masterProvenanceTier).toBe("ladder_verified_strong");
  });

  it("retail hit (isMaster:false) never carries masterId or masterProvenanceTier", () => {
    const entry = toMasterAwareStoreEntry(raw, false, "2026-07-20T00:00:00.000Z") as unknown as Record<string, unknown>;
    expect(entry.masterId).toBeUndefined();
    expect(entry.masterProvenanceTier).toBeUndefined();
  });
});
