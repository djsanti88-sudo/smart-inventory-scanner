const EXAMPLE_BARCODE_BLOCKLIST = new Set([
  "012345678905",
  "4006381333931",
  "5901234123457",
  "0012345670121",
  "0012345674020",
  "0012345674037",
]);

const CATEGORY_SENTINELS = new Set([
  "unknown",
  "n/a",
  "na",
  "null",
  "none",
  "undefined",
  "-",
  "?",
  "not found",
  "not available",
  "other",
  "miscellaneous",
]);

// Frozen serving behavior. These are review signals too, but remain excluded
// until a separately reviewed barcode allowlist explicitly relaxes the gate.
const CONTEXTUAL_POISON_PATTERN =
  /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;

/** @param {unknown} value */
function sourceString(value) {
  return value == null ? "" : String(value);
}

/** Prefer immutable enriched evidence while accepting the legacy retained schema. */
function sourceField(row, field) {
  const rawField = `${field}_raw`;
  return Object.prototype.hasOwnProperty.call(row, rawField) ? row[rawField] : row[field];
}

/** Decode only deterministic HTML character references; unknown entities stay untouched. */
function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, name) => {
    if (name) return named[name.toLowerCase()] ?? match;
    const point = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      return match;
    }
    return String.fromCodePoint(point);
  });
}

/**
 * Normalize a serving display value and record reversible transformations.
 * The caller retains the source row unchanged as the raw evidence store.
 *
 * @param {unknown} rawValue
 * @param {string} field
 * @param {string[]} flags
 */
function normalizeDisplay(rawValue, field, flags) {
  const raw = sourceString(rawValue);
  const whitespaceNormalized = raw.trim().replace(/\s+/g, " ");
  if (whitespaceNormalized !== raw) flags.push(`normalized_whitespace:${field}`);
  const decoded = decodeHtmlEntities(whitespaceNormalized);
  if (decoded !== whitespaceNormalized) flags.push(`decoded_html_entity:${field}`);
  return decoded.replace(/\s+/g, " ").trim();
}

/** @param {string} code */
function barcodeVariants(code) {
  const digits = code.replace(/\D/g, "");
  if (!digits) return [];
  const stripped = digits.replace(/^0+/, "") || "0";
  const variants = new Set([digits, stripped]);
  for (const base of [digits, stripped]) {
    if (base.length <= 14) variants.add(base.padStart(14, "0"));
    if (base.length <= 13) variants.add(base.padStart(13, "0"));
    if (base.length <= 12) variants.add(base.padStart(12, "0"));
  }
  return [...variants];
}

/** @param {string} digits */
function isDegenerateBarcode(digits) {
  if (!digits) return false;
  if (/^0+$/.test(digits) || /^(\d)\1+$/.test(digits)) return true;
  return digits === "0123456789012" || digits === "1234567890128";
}

/** @param {string} code */
function isValidGtin(code) {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += digits[index] * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * @typedef {"known" | "review" | "quarantined"} RetailStatus
 *
 * @typedef RetailProjection
 * @property {string} barcode
 * @property {RetailStatus} status
 * @property {string} productName
 * @property {string} alternateName
 * @property {string} genericName
 * @property {string} brand
 * @property {"brands" | "brands_en" | "brand_owner" | ""} brandBasis
 * @property {string} category
 * @property {"main_category_en" | "categories_en" | ""} categoryBasis
 * @property {string} categoryRawLocal
 * @property {string[]} qualityFlags
 * @property {string} quarantineReason
 */

/**
 * Project one retained retail source row into the build-time serving contract.
 * This function is pure: raw evidence remains exclusively in the input row.
 *
 * @param {Record<string, unknown>} row
 * @param {{ duplicateConflict?: boolean, variantConflict?: boolean }} [conflicts]
 * @returns {RetailProjection}
 */
export function projectRetailRow(row, conflicts = {}) {
  const qualityFlags = [];
  const barcode = sourceString(row.code).trim();
  const productName = normalizeDisplay(sourceField(row, "product_name"), "product_name", qualityFlags);
  const alternateName = normalizeDisplay(sourceField(row, "abbreviated_product_name"), "abbreviated_product_name", qualityFlags);
  const genericName = normalizeDisplay(sourceField(row, "generic_name"), "generic_name", qualityFlags);

  let brand = "";
  /** @type {RetailProjection["brandBasis"]} */
  let brandBasis = "";
  for (const field of ["brands", "brands_en", "brand_owner"]) {
    const candidate = normalizeDisplay(sourceField(row, field), field, qualityFlags);
    if (candidate) {
      brand = candidate;
      brandBasis = /** @type {RetailProjection["brandBasis"]} */ (field);
      break;
    }
  }

  let category = "";
  /** @type {RetailProjection["categoryBasis"]} */
  let categoryBasis = "";
  for (const field of ["main_category_en", "categories_en"]) {
    const rawCandidate = normalizeDisplay(sourceField(row, field), field, qualityFlags);
    const candidate = rawCandidate.split(",", 1)[0].trim();
    if (!candidate) continue;
    if (CATEGORY_SENTINELS.has(candidate.toLowerCase())) {
      qualityFlags.push(`category_sentinel:${field}`);
      continue;
    }
    category = candidate;
    categoryBasis = /** @type {RetailProjection["categoryBasis"]} */ (field);
    break;
  }

  const categoryRawLocal = sourceString(sourceField(row, "categories"));
  const digits = barcode.replace(/\D/g, "");
  let status = /** @type {RetailStatus} */ ("review");
  let quarantineReason = "";

  if (isDegenerateBarcode(digits)) {
    status = "quarantined";
    quarantineReason = "degenerate_barcode";
  } else if (barcodeVariants(barcode).some((variant) => EXAMPLE_BARCODE_BLOCKLIST.has(variant))) {
    status = "quarantined";
    quarantineReason = "example_barcode";
  } else {
    const poisonInName = CONTEXTUAL_POISON_PATTERN.test(productName);
    const poisonInBrand = CONTEXTUAL_POISON_PATTERN.test(brand);
    if (poisonInName) qualityFlags.push("contextual_poison_marker:name");
    if (poisonInBrand) qualityFlags.push("contextual_poison_marker:brand");

    if (poisonInName || poisonInBrand) {
      status = "quarantined";
      quarantineReason = "contextual_poison_marker";
    } else if (conflicts.duplicateConflict || conflicts.variantConflict) {
      if (conflicts.duplicateConflict) qualityFlags.push("review_reason:duplicate_conflict");
      if (conflicts.variantConflict) qualityFlags.push("review_reason:variant_conflict");
    } else if (!isValidGtin(barcode)) {
      qualityFlags.push("review_reason:invalid_gtin");
    } else if (productName.length >= 3) {
      status = "known";
    } else if (alternateName || genericName || brand || category || categoryRawLocal.trim()) {
      qualityFlags.push("review_reason:partial_evidence");
    } else {
      qualityFlags.push("review_reason:unidentified");
    }
  }

  return {
    barcode,
    status,
    productName: productName.length >= 3 ? productName : "",
    alternateName,
    genericName,
    brand,
    brandBasis,
    category,
    categoryBasis,
    categoryRawLocal,
    qualityFlags,
    quarantineReason,
  };
}
