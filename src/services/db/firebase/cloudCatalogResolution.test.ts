import { describe, it, expect } from "vitest";
import { toStoreProduct, toStoreAlias } from "./storeMappers";
import { resolveRawScan } from "@/services/resolver";

// Regression for the live "everything Needs Review" failure: when the cloud business catalog is loaded
// (Firestore docs -> storeMappers -> resolver), known seed codes MUST resolve to Known, and an EMPTY
// catalog is the only thing that should send a known code to Needs Review (which is what an unseeded
// business produced live).

const BIZ = "test-biz";

// Firestore-shaped docs as written by the seed/sync, mapped through the cloud-load mappers.
const products = [
  toStoreProduct("prod-nokian", { name: "Nokian Outpost APT", primarySku: "T432119", primaryBarcode: "6419440485331", gtin: "6419440485331", verified: true, status: "active" }, BIZ),
  toStoreProduct("prod-falken", { name: "Falken Sincera ST80 A/S", primarySku: "28816861", primaryBarcode: "848983012906", verified: true, status: "active" }, BIZ),
];
const aliases = [
  toStoreAlias("a-nokian", { productId: "prod-nokian", cleanCode: "6419440485331", normalizedCode: "6419440485331", aliasType: "barcode", approved: true }, BIZ),
  toStoreAlias("a-falken", { productId: "prod-falken", cleanCode: "28816861", normalizedCode: "28816861", aliasType: "sku", approved: true }, BIZ),
];
const nameOf = (productId: string | null) => products.find((p) => p.id === productId)?.name;

describe("cloud-backend catalog resolution (storeMappers -> resolver)", () => {
  it("resolves the Nokian seed barcode 6419440485331 to Known (not needs_review)", () => {
    const r = resolveRawScan("6419440485331", products, aliases, BIZ);
    expect(r.resolverStatus).toBe("known");
    expect(nameOf(r.productId)).toBe("Nokian Outpost APT");
  });

  it("resolves Falken part-number variants to Falken, never Camel", () => {
    for (const code of ["2881-6861", "28816861", "2881 6861", "2881/6861", "2881.6861"]) {
      const r = resolveRawScan(code, products, aliases, BIZ);
      expect(r.resolverStatus, code).toBe("known");
      expect(nameOf(r.productId), code).toBe("Falken Sincera ST80 A/S");
      expect(nameOf(r.productId), code).not.toMatch(/camel/i);
    }
  });

  it("EMPTY catalog sends a known seed code to needs_review (the live unseeded-business failure)", () => {
    const r = resolveRawScan("6419440485331", [], [], BIZ);
    expect(r.resolverStatus).toBe("needs_review");
  });
});
