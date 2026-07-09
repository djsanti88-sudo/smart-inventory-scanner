// parseProduct.mjs (dt-harvest Task 2) - deterministic, AI-free JSON-LD tire parser.
//
// Scraped HTML is UNTRUSTED DATA: this module only ever extracts and maps fields out of it. It never
// executes, evaluates, or obeys any text found inside the page (see AGENTS.md / CLAUDE.md semantic
// firewall). A description field that contains something like "ignore previous instructions" is just a
// string we copy a substring out of - it is never treated as a command.

// Tire-size regex, copied verbatim from src/services/ai/tireSpecs.ts (METRIC_SIZE / COMMERCIAL_SIZE) so
// this pure script does not import app/service code. Source: src/services/ai/tireSpecs.ts lines 27-32.
// Metric / P-metric / LT sizes: 275/55R20, LT265/70R17, P225/60R17, 225/60ZR17. Also accepts the dash
// notation some barcode DBs use (245/65-17) - same size, different separator.
const METRIC_SIZE = /\b(LT|P|ST)?\d{3}\/\d{2}\s?(Z?R|-)\s?\d{2}\b/i;
// Commercial / flotation: 11R22.5, 295/75R22.5, 35X12.5R20.
const COMMERCIAL_SIZE = /\b\d{2}(\.\d)?(X\d{2}(\.\d)?)?R\d{2}(\.\d)?\b/i;
// Load index (2-3 digits, optional dual) + speed-rating letter as a standalone token: 111T, 111/110T, 116 S.
const LOAD_SPEED = /\b\d{2,3}(\/\d{2,3})?\s?[A-Z]\b/;

/**
 * @typedef {{
 *   gtin: string,
 *   brand: string,
 *   model: string,
 *   size: string,
 *   loadIndex: string,
 *   speedRating: string,
 *   partNumber: string,
 *   imageUrl: string,
 *   sourceUrl: string,
 *   fetchedAt: string,
 * }} TireRow
 */

/** Extract the raw text content of every <script type="application/ld+json"> block in the HTML. */
function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/** JSON.parse a single block defensively; malformed JSON yields null instead of throwing. */
function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A JSON-LD payload can be a single object, an array, or a @graph wrapper. Flatten to a list of nodes. */
function flattenNodes(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.flatMap(flattenNodes);
  if (Array.isArray(parsed["@graph"])) return parsed["@graph"].flatMap(flattenNodes);
  return [parsed];
}

/** True if the node's @type is (or includes) "Product". */
function isProductNode(node) {
  const t = node && node["@type"];
  if (!t) return false;
  if (Array.isArray(t)) return t.some((x) => String(x).toLowerCase() === "product");
  return String(t).toLowerCase() === "product";
}

/** Pull the GTIN from whichever gtin field is present, preferring the most specific. */
function extractGtin(node) {
  const candidates = [node.gtin13, node.gtin12, node.gtin14, node.gtin];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== "") return String(c).trim();
  }
  return "";
}

/** Pull the brand name whether `brand` is a string or a Brand/Organization object. */
function extractBrand(node) {
  const b = node.brand;
  if (!b) return "";
  if (typeof b === "string") return b.trim();
  if (typeof b === "object" && typeof b.name === "string") return b.name.trim();
  return "";
}

/**
 * Split a product name like "Falken Wildpeak A/T3W 265/70R17 115T" into { model, size, loadIndex,
 * speedRating }. The size and load/speed tokens are located with the shared regexes above and stripped
 * out; whatever remains (minus a leading brand, if given) is the model name.
 */
function splitNameIntoSpecs(name, brand) {
  const src = String(name ?? "");

  let sizeMatch = src.match(METRIC_SIZE);
  if (!sizeMatch) sizeMatch = src.match(COMMERCIAL_SIZE);
  // Canonicalize dash notation (255/40-17 -> 255/40R17), same rule as tireSizeToken().
  const size = sizeMatch ? sizeMatch[0].replace(/\s+/g, "").replace(/(\d{2})-(\d{2})$/, "$1R$2").toUpperCase() : "";

  // Look for load/speed AFTER removing the size token, so the size's own "R" is never mistaken for a
  // speed-rating letter (same order tireLoadSpeedToken() uses).
  const withoutSize = src.replace(METRIC_SIZE, " ").replace(COMMERCIAL_SIZE, " ");
  const loadSpeedMatch = withoutSize.match(LOAD_SPEED);
  const loadSpeedToken = loadSpeedMatch ? loadSpeedMatch[0].replace(/\s+/g, "").toUpperCase() : "";

  let loadIndex = "";
  let speedRating = "";
  if (loadSpeedToken) {
    const lm = loadSpeedToken.match(/^(\d{2,3}(?:\/\d{2,3})?)([A-Z])$/);
    if (lm) {
      loadIndex = lm[1];
      speedRating = lm[2];
    }
  }

  // Model = the name with the brand prefix, the size token, and the load/speed token removed.
  let model = src;
  if (sizeMatch) model = model.replace(sizeMatch[0], " ");
  if (loadSpeedMatch) model = model.replace(loadSpeedMatch[0], " ");
  if (brand) {
    const brandRe = new RegExp(`^\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
    model = model.replace(brandRe, " ");
  }
  model = model.replace(/\s+/g, " ").trim();

  return { model, size, loadIndex, speedRating };
}

/**
 * Parse a Discount Tire product page's HTML for a JSON-LD Product block and return a normalized TireRow,
 * or null if no usable Product node is found. `now` is injectable for deterministic tests.
 *
 * @param {string} html
 * @param {string} sourceUrl
 * @param {() => string} [now]
 * @returns {TireRow | null}
 */
export function parseTireFromHtml(html, sourceUrl, now = () => new Date().toISOString()) {
  const blocks = extractJsonLdBlocks(String(html ?? ""));
  for (const block of blocks) {
    const parsed = safeParseJson(block);
    if (!parsed) continue;
    const nodes = flattenNodes(parsed);
    const product = nodes.find(isProductNode);
    if (!product) continue;

    const brand = extractBrand(product);
    const { model, size, loadIndex, speedRating } = splitNameIntoSpecs(product.name, brand);

    return {
      gtin: extractGtin(product),
      brand,
      model,
      size,
      loadIndex,
      speedRating,
      partNumber: String(product.mpn ?? product.sku ?? "").trim(),
      imageUrl: typeof product.image === "string" ? product.image : Array.isArray(product.image) ? String(product.image[0] ?? "") : "",
      sourceUrl: String(sourceUrl ?? ""),
      fetchedAt: now(),
    };
  }
  return null;
}
