import { describe, it, expect } from "vitest";
import { candidateKnownUpcSet, shopReverseUpcConflict, type UpcRecord } from "@/services/catalog/candidateUpcSet";

// Reverse known-UPC guard input: given an AI-proposed product, build its known UPC SET from OUR OWN
// catalog/corpus (no live lookup). UPC SETS (not a single UPC) because one product family legitimately
// has many UPCs (pack size, region, bundle, retailer/color/size variant, packaging update, old vs new).

const RECORDS: UpcRecord[] = [
  { name: "5 Gal Orange Homer Bucket", brand: "The Home Depot", primaryBarcode: "084305355546" },
  { name: "5 Gal Homer Bucket 6-Pack", brand: "The Home Depot", barcode: "684305355548" },
  { name: "Hugger 52 in Ceiling Fan", brand: "Hampton Bay", model: "AL383LED-BN", upc: "792145369783" },
];

describe("candidateKnownUpcSet (reverse guard, UPC sets from our own data)", () => {
  it("collects ALL known UPCs for a matched product family (not just one)", () => {
    const set = candidateKnownUpcSet({ brand: "The Home Depot", name: "Homer Bucket" }, RECORDS);
    expect(set).toContain("084305355546");
    expect(set).toContain("684305355548");
    expect(set).not.toContain("792145369783"); // the fan is a different product
  });

  it("matches by brand + model for the fan", () => {
    const set = candidateKnownUpcSet({ brand: "Hampton Bay", name: "Hugger ceiling fan", model: "AL383LED-BN" }, RECORDS);
    expect(set).toContain("792145369783");
    expect(set).not.toContain("084305355546");
  });

  it("returns an empty set when nothing in our data matches (so the guard stays inert)", () => {
    expect(candidateKnownUpcSet({ brand: "Acme", name: "Mystery Widget" }, RECORDS)).toEqual([]);
  });

  it("returns an empty set for an empty candidate", () => {
    expect(candidateKnownUpcSet({}, RECORDS)).toEqual([]);
  });
});

describe("shopReverseUpcConflict (shop-catalog reverse-UPC guard, brought from WIP backup)", () => {
  it("flags when the candidate is already in our catalog under a DIFFERENT code", () => {
    const r = shopReverseUpcConflict({ brand: "The Home Depot", name: "Homer Bucket" }, "051596320812", RECORDS);
    expect(r.conflict).toBe(true);
    expect(r.knownUpcs).toContain("084305355546");
  });

  it("no conflict when the scanned code IS one of the candidate's known codes", () => {
    const r = shopReverseUpcConflict({ brand: "The Home Depot", name: "Homer Bucket" }, "084305355546", RECORDS);
    expect(r.conflict).toBe(false);
  });

  it("no conflict when the candidate is not in our catalog (guard stays inert)", () => {
    const r = shopReverseUpcConflict({ brand: "Acme", name: "Mystery Widget" }, "051596320812", RECORDS);
    expect(r.conflict).toBe(false);
    expect(r.knownUpcs).toEqual([]);
  });
});
