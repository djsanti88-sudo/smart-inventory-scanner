import assert from "node:assert/strict";
import test from "node:test";

let retailQuality;
try {
  retailQuality = await import("./retail-quality.mjs");
} catch {
  retailQuality = null;
}

test("exports the retail row projection boundary", () => {
  assert.equal(typeof retailQuality?.projectRetailRow, "function");
});

const { projectRetailRow } = retailQuality;
const NORMAL_GTIN = "049000006346";

test("uses only the primary product name and exact source precedence without mutating raw evidence", () => {
  const row = {
    code: NORMAL_GTIN,
    product_name: "  Fish   &amp; Chips  ",
    abbreviated_product_name: "  F&amp;C  ",
    generic_name: "  Prepared   meal  ",
    brands: "  Primary   Brand  ",
    brands_en: "English Brand",
    brand_owner: "Owner Brand",
    main_category_en: " Undefined ",
    categories_en: " Snacks ,Chips",
    categories: "  fr:snacks  ",
  };
  const before = structuredClone(row);

  const result = projectRetailRow(row);

  assert.deepEqual(result, {
    barcode: NORMAL_GTIN,
    status: "known",
    productName: "Fish & Chips",
    alternateName: "F&C",
    genericName: "Prepared meal",
    brand: "Primary Brand",
    brandBasis: "brands",
    category: "Snacks",
    categoryBasis: "categories_en",
    categoryRawLocal: "  fr:snacks  ",
    qualityFlags: [
      "normalized_whitespace:product_name",
      "decoded_html_entity:product_name",
      "normalized_whitespace:abbreviated_product_name",
      "decoded_html_entity:abbreviated_product_name",
      "normalized_whitespace:generic_name",
      "normalized_whitespace:brands",
      "normalized_whitespace:main_category_en",
      "category_sentinel:main_category_en",
      "normalized_whitespace:categories_en",
    ],
    quarantineReason: "",
  });
  assert.deepEqual(row, before, "projection must not alter retained raw evidence");
});

test("never promotes alternate or generic names into the known serving name", () => {
  const result = projectRetailRow({
    code: NORMAL_GTIN,
    product_name: "",
    abbreviated_product_name: "Coke 12 pack",
    generic_name: "Cola",
    brands: "Coca-Cola",
  });

  assert.equal(result.status, "review");
  assert.equal(result.productName, "");
  assert.equal(result.alternateName, "Coke 12 pack");
  assert.equal(result.genericName, "Cola");
  assert.ok(result.qualityFlags.includes("review_reason:partial_evidence"));
});

test("applies brand and English category precedence after treating exact category sentinels as missing", () => {
  const brandCases = [
    [{ brands: "Brand A", brands_en: "Brand B", brand_owner: "Brand C" }, ["Brand A", "brands"]],
    [{ brands: "", brands_en: "Brand B", brand_owner: "Brand C" }, ["Brand B", "brands_en"]],
    [{ brands: "", brands_en: "", brand_owner: "Brand C" }, ["Brand C", "brand_owner"]],
  ];
  for (const [fields, expected] of brandCases) {
    const result = projectRetailRow({ code: NORMAL_GTIN, product_name: "Product", ...fields });
    assert.deepEqual([result.brand, result.brandBasis], expected);
  }

  for (const sentinel of ["unknown", "N/A", "na", "NULL", "none", "undefined", "-", "?", "not found", "not available", "other", "miscellaneous"]) {
    const result = projectRetailRow({
      code: NORMAL_GTIN,
      product_name: "Product",
      main_category_en: ` ${sentinel} `,
      categories_en: "Fallback category,Second assertion",
    });
    assert.equal(result.category, "Fallback category", sentinel);
    assert.equal(result.categoryBasis, "categories_en", sentinel);
    assert.ok(result.qualityFlags.includes("category_sentinel:main_category_en"), sentinel);
  }
});

test("preserves the frozen exact and degenerate barcode quarantine across zero-padding variants", () => {
  for (const code of [
    "012345678905",
    "0012345678905",
    "4006381333931",
    "5901234123457",
    "0012345670121",
    "0012345674020",
    "0012345674037",
  ]) {
    const result = projectRetailRow({ code, product_name: "Ordinary Product", brands: "Ordinary Brand" });
    assert.equal(result.status, "quarantined", code);
    assert.equal(result.quarantineReason, "example_barcode", code);
  }

  for (const code of ["00000000", "11111111", "0123456789012", "1234567890128"]) {
    const result = projectRetailRow({ code, product_name: "Ordinary Product" });
    assert.equal(result.status, "quarantined", code);
    assert.equal(result.quarantineReason, "degenerate_barcode", code);
  }
});

test("keeps contextual poison canaries excluded while distinguishing them from harmless substrings", () => {
  for (const productName of ["COVID Test", "Test Kitchen Korean BBQ", "Dummy item", "Sample Product", "Fakewine Reserve"]) {
    const result = projectRetailRow({ code: NORMAL_GTIN, product_name: productName, brands: "Real Brand" });
    assert.equal(result.status, "quarantined", productName);
    assert.equal(result.quarantineReason, "contextual_poison_marker", productName);
    assert.ok(result.qualityFlags.includes("contextual_poison_marker:name"), productName);
  }

  const brandMarker = projectRetailRow({ code: NORMAL_GTIN, product_name: "Ordinary Product", brands: "BrandTest" });
  assert.equal(brandMarker.status, "quarantined");
  assert.ok(brandMarker.qualityFlags.includes("contextual_poison_marker:brand"));

  for (const productName of ["Latest Edition", "Contest Winner", "Testarossa Wine", "Attesting Stamp"]) {
    assert.equal(projectRetailRow({ code: NORMAL_GTIN, product_name: productName }).status, "known", productName);
  }
});

test("routes duplicate and zero-padding-family conflicts to review before serving", () => {
  const row = { code: NORMAL_GTIN, product_name: "Ordinary Product", brands: "Ordinary Brand" };

  const duplicate = projectRetailRow(row, { duplicateConflict: true });
  assert.equal(duplicate.status, "review");
  assert.ok(duplicate.qualityFlags.includes("review_reason:duplicate_conflict"));

  const variant = projectRetailRow(row, { variantConflict: true });
  assert.equal(variant.status, "review");
  assert.ok(variant.qualityFlags.includes("review_reason:variant_conflict"));
});

test("classifies every non-quarantined non-known row as review", () => {
  const partial = projectRetailRow({ code: NORMAL_GTIN, product_name: "", categories_en: "Beverages" });
  assert.equal(partial.status, "review");
  assert.ok(partial.qualityFlags.includes("review_reason:partial_evidence"));

  const unidentified = projectRetailRow({ code: NORMAL_GTIN, product_name: "" });
  assert.equal(unidentified.status, "review");
  assert.ok(unidentified.qualityFlags.includes("review_reason:unidentified"));

  const invalid = projectRetailRow({ code: "12345678", product_name: "Ordinary Product" });
  assert.equal(invalid.status, "review");
  assert.ok(invalid.qualityFlags.includes("review_reason:invalid_gtin"));
});

test("reads immutable enriched *_raw source fields while retaining legacy input compatibility", () => {
  const enriched = {
    code: "049000006346",
    product_name_raw: "Enriched Name",
    brands_raw: "Enriched Brand",
    main_category_en_raw: "Beverages",
    product_name: "Legacy Name",
    brands: "Legacy Brand",
  };
  const projection = projectRetailRow(enriched);
  assert.equal(projection.status, "known");
  assert.equal(projection.productName, "Enriched Name");
  assert.equal(projection.brand, "Enriched Brand");
  assert.equal(projection.category, "Beverages");

  const legacy = projectRetailRow({ code: "049000006346", product_name: "Legacy Name" });
  assert.equal(legacy.productName, "Legacy Name");
});
