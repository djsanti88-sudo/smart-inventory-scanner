import { describe, expect, test } from "vitest";
import { makeResult, type FetchV2Outcome } from "./types";
import { classifyIdentifier } from "./classify";
import { normalizeVariants } from "./normalize";

// ---------------------------------------------------------------- contract (count-first invariants)
describe("makeResult count-first contract", () => {
  const OUTCOMES: FetchV2Outcome[] = ["verified", "suggested", "needs_review", "unknown", "unsupported", "rejected"];

  test.each(OUTCOMES)("outcome %s ALWAYS persists and increments the scan", (outcome) => {
    const r = makeResult({ rawValue: "051596320812", outcome });
    expect(r.countBehavior.mustPersistScan).toBe(true);
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
  });

  test("productAssignmentAllowed ONLY for verified", () => {
    for (const outcome of OUTCOMES) {
      const r = makeResult({ rawValue: "051596320812", outcome });
      expect(r.countBehavior.productAssignmentAllowed).toBe(outcome === "verified");
    }
  });

  test("count flags cannot be overridden to false by a caller", () => {
    const r = makeResult({
      rawValue: "garbage!!!",
      outcome: "rejected",
      countBehavior: { mustPersistScan: false, mustIncrementQuantity: false, groupingKey: "", productAssignmentAllowed: true },
    });
    expect(r.countBehavior.mustPersistScan).toBe(true);
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
    expect(r.countBehavior.productAssignmentAllowed).toBe(false); // rejected can never assign
  });

  test("groupingKey defaults to the normalized primary so repeat scans of junk group together", () => {
    const a = makeResult({ rawValue: " 051596320812 ", outcome: "unknown" });
    const b = makeResult({ rawValue: "051596320812", outcome: "unknown" });
    expect(a.countBehavior.groupingKey).toBe(b.countBehavior.groupingKey);
    expect(a.countBehavior.groupingKey.length).toBeGreaterThan(0);
  });

  test("fills identifier + normalizedValues + version for a bare rawValue", () => {
    const r = makeResult({ rawValue: "051596320812", outcome: "unknown" });
    expect(r.version).toBe("fetch_v2");
    expect(r.identifier.type).toBe("upc_a");
    expect(r.normalizedValues.primary).toBe("051596320812");
    expect(r.debug.mode).toBe("balanced");
  });
});

// ---------------------------------------------------------------- classification
describe("classifyIdentifier", () => {
  test("valid UPC-A is public with valid check digit", () => {
    const id = classifyIdentifier("051596320812");
    expect(id.type).toBe("upc_a");
    expect(id.isPublicBarcode).toBe(true);
    expect(id.checkDigitValid).toBe(true);
  });

  test("12 digits with WRONG check digit stays upc_a but checkDigitValid false", () => {
    const id = classifyIdentifier("051596320813");
    expect(id.type).toBe("upc_a");
    expect(id.checkDigitValid).toBe(false);
  });

  test("EAN-13 and GTIN-14", () => {
    expect(classifyIdentifier("4981910515661").type).toBe("ean_13");
    expect(classifyIdentifier("00070470001272").type).toBe("gtin_14");
    expect(classifyIdentifier("4981910515661").isPublicBarcode).toBe(true);
  });

  test("ASIN vs FNSKU-like are distinguished and never public", () => {
    expect(classifyIdentifier("B09B8V1LZ3").type).toBe("asin");
    expect(classifyIdentifier("X004DY7YUT").type).toBe("fnsku_like");
    expect(classifyIdentifier("B09B8V1LZ3").isPublicBarcode).toBe(false);
    expect(classifyIdentifier("X004DY7YUT").isPublicBarcode).toBe(false);
  });

  test("lowercase asin is classified after uppercasing", () => {
    expect(classifyIdentifier("b09b8v1lz3").type).toBe("asin");
  });

  test("URLs classify as url", () => {
    expect(classifyIdentifier("https://www.example.com/products/acme-widget").type).toBe("url");
    expect(classifyIdentifier("http://shop.example.com/p/1").type).toBe("url");
  });

  test("tire codes with size patterns classify as tire_code", () => {
    expect(classifyIdentifier("PROXES R888R 255/40ZR17").type).toBe("tire_code");
  });

  test("plain alpha SKUs are vendor_sku; garbage is raw_text; empty is unknown", () => {
    expect(classifyIdentifier("KMD-40521").type).toBe("vendor_sku");
    expect(classifyIdentifier("%$#@! total garbage").type).toBe("raw_text");
    expect(classifyIdentifier("").type).toBe("unknown");
  });

  test("public barcode carries a gs1 prefix hint slice", () => {
    const id = classifyIdentifier("051596320812");
    expect(id.gs1PrefixHint.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- normalization
describe("normalizeVariants", () => {
  test("UPC-A yields zero-padded EAN-13 and GTIN-14 variants", () => {
    const n = normalizeVariants("051596320812", "upc_a");
    expect(n.primary).toBe("051596320812");
    expect(n.upcA).toBe("051596320812");
    expect(n.ean13).toBe("0051596320812");
    expect(n.gtin14).toBe("00051596320812");
    expect(n.all[0]).toBe("051596320812");
    expect(new Set(n.all).size).toBe(n.all.length); // no duplicate variants
  });

  test("separators and spaces are stripped without losing the code", () => {
    const n = normalizeVariants(" 00 78742-05822 1 ", "ean_13");
    expect(n.withoutSeparators).toBe("0078742058221");
    expect(n.primary).toBe("0078742058221");
  });

  test("EAN-13 with leading zero exposes the embedded UPC-A", () => {
    const n = normalizeVariants("0078742058221", "ean_13");
    expect(n.upcA).toBe("078742058221");
  });

  test("ASIN/vendor labels are uppercased, no numeric padding invented", () => {
    const n = normalizeVariants("b09b8v1lz3", "asin");
    expect(n.primary).toBe("B09B8V1LZ3");
    expect(n.upcA).toBe("");
    expect(n.ean13).toBe("");
  });

  test("URLs group by normalized form (tracking params + fragments dropped, host lowercased)", () => {
    const a = normalizeVariants("HTTPS://WWW.Example.com/products/x?utm_source=chatgpt.com#frag", "url");
    const b = normalizeVariants("https://www.example.com/products/x", "url");
    expect(a.primary).toBe(b.primary);
  });

  test("URL meaningful query params are KEPT (different products never merge)", () => {
    const a = normalizeVariants("https://shop.example.com/item?id=111", "url");
    const b = normalizeVariants("https://shop.example.com/item?id=222", "url");
    expect(a.primary).not.toBe(b.primary);
  });

  test("no over-merge: different digit strings never share a primary", () => {
    const a = normalizeVariants("12345678", "vendor_sku");
    const b = normalizeVariants("123456780", "vendor_sku");
    expect(a.primary).not.toBe(b.primary);
  });
});
