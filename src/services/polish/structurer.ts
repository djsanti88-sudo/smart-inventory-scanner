// Deterministic product structurer (Build 2 / Task 1). Pure function, no React/next imports, no
// network. Splits a raw product name into brand / model / descriptionText plus a glued-digits
// size tag (every tire notation) or a weight/count/volume tag. AI/LLM never runs here - this is
// the $0 deterministic pass; low-confidence rows are handed to a later LLM-fallback task.
//
// The junk-gate and brand-cleanliness SHAPES below intentionally mirror
// src/services/fetchV2/pageEvidence/junkRules.ts (NAV_NAME_RE / GENERIC_NAME_RE) and the tire-size
// regex mirrors src/services/fetchV2/siblingGuard.ts's battle-tested TIRE_SIZE_RE. Both are
// reimplemented locally (not imported) so this service stays independent of fetchV2.

export interface StructuredProduct {
  brand: string; // "" when unknown - NEVER guessed from noise
  model: string; // name minus brand minus size/weight/noise tokens
  descriptionText: string; // cleaned display string (full name, tidied)
  sizeTag: string; // glued digits ("2657017") or weight/count/volume tag ("9.25oz") or ""
  sizeTagKind: "tire" | "weight" | "count" | "volume" | "none";
  confidence: number; // 0..1; < 0.6 marks the row for LLM fallback
}

export interface StructurerContext {
  knownBrands?: string[]; // lexicon injected by the caller (catalog + prefix map); pure DI
  category?: string; // "tires" biases tire parsing
}

// ---------------------------------------------------------------------------------------------
// Junk gate - shapes reimplemented locally from the fetchV2 firewall (breadcrumb arrows,
// shop-speak, price comparison, host-echo single tokens, pure code echoes).
// ---------------------------------------------------------------------------------------------
const BREADCRUMB_RE = /[»➤]|\s>\s/;
const SHOP_SPEAK_RE =
  /\bbuy cheap\b|\bbuy online\b|\bin (?:an )?online store\b|\bonline store\b|\bcompare prices?\b|\bprice comparison\b|\bshop all\b|\bstore locator\b|\bmy store\b/i;
const GENERIC_WHOLE_NAME_RE =
  /^(nutrition facts?|ingredients?|products?|details?|specifications?|description|overview|reviews?|home)$/i;
const HOST_ECHO_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i; // single bare-domain token, e.g. "amazon.com"
const CODE_ECHO_RE = /^[\d\s-]{6,}$/; // pure digits/spaces/dashes - a barcode, not a product name

function isJunkName(name: string): boolean {
  const n = (name ?? "").trim();
  if (n.length < 2) return true;
  if (BREADCRUMB_RE.test(n)) return true;
  if (SHOP_SPEAK_RE.test(n)) return true;
  if (GENERIC_WHOLE_NAME_RE.test(n)) return true;
  if (HOST_ECHO_RE.test(n)) return true;
  if (CODE_ECHO_RE.test(n)) return true;
  return false;
}

/** A brand string supplied by a caller can itself be shop-speak / a nav label - never trust it
 *  blindly. Reimplements the shape of junkRules.cleanBrand locally. */
function isBrandJunk(brand: string): boolean {
  const b = (brand ?? "").trim();
  if (!b) return true;
  if (GENERIC_WHOLE_NAME_RE.test(b)) return true;
  if (SHOP_SPEAK_RE.test(b)) return true;
  if (/^(my store|the store|shop|store)$/i.test(b)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Tire size parsing - a richer standalone parser (reads siblingGuard.TIRE_SIZE_RE as a proven
// reference, does not import it). Handles: passenger (spaced/x/dash/ZR/XL glue, ST/LT/P service
// prefixes), decimal truck rims (22.5), flotation (37x12.50R20), ATV (25x8-12), motorcycle
// (100/80-17). Output is the three numeric groups glued together with every "." dropped.
// ---------------------------------------------------------------------------------------------
const TIRE_SIZE_RE =
  /(?<![0-9])(?:(?:ST|LT|P)\s?)?(\d{2,3}(?:\.\d+)?)\s?[/xX]\s?(\d{1,3}(?:\.\d+)?)\s?(?:Z?R|-)\s?(\d{2}(?:\.\d)?)\s?(?:XL|LT|ST)?(?![0-9])/i;

export function tireSizeTag(text: string): string {
  const m = TIRE_SIZE_RE.exec(text ?? "");
  if (!m) return "";
  return `${m[1]}${m[2]}${m[3]}`.replace(/\./g, "");
}

function tireSizeMatch(text: string): { tag: string; raw: string } | null {
  const m = TIRE_SIZE_RE.exec(text ?? "");
  if (!m) return null;
  return { tag: `${m[1]}${m[2]}${m[3]}`.replace(/\./g, ""), raw: m[0] };
}

// ---------------------------------------------------------------------------------------------
// Weight / count / volume parsing (non-tire size/quantity tags).
// ---------------------------------------------------------------------------------------------
const PACK_UNIT_RE =
  /(?<![0-9])(\d+(?:\.\d+)?)\s?(fl\s?oz|oz|kg|g|lbs|lb|ml|l|count|ct|pack|pk)\b/i;

const UNIT_NORMALIZE: Record<string, string> = {
  "fl oz": "floz",
  floz: "floz",
  oz: "oz",
  kg: "kg",
  g: "g",
  lbs: "lbs",
  lb: "lb",
  ml: "ml",
  l: "l",
  count: "ct",
  ct: "ct",
  pack: "pk",
  pk: "pk",
};

const UNIT_KIND: Record<string, "weight" | "count" | "volume"> = {
  oz: "weight",
  kg: "weight",
  g: "weight",
  lbs: "weight",
  lb: "weight",
  ct: "count",
  pk: "count",
  ml: "volume",
  l: "volume",
  floz: "volume",
};

function packSizeMatch(text: string): { tag: string; kind: "weight" | "count" | "volume"; raw: string } | null {
  const m = PACK_UNIT_RE.exec(text ?? "");
  if (!m) return null;
  const unitKey = m[2].toLowerCase().replace(/\s+/g, " ").trim();
  const normalized = UNIT_NORMALIZE[unitKey] ?? unitKey.replace(/\s+/g, "");
  const kind = UNIT_KIND[normalized] ?? "count";
  return { tag: `${m[1]}${normalized}`.toLowerCase(), kind, raw: m[0] };
}

type SizeResult = { tag: string; kind: StructuredProduct["sizeTagKind"]; raw: string };

function detectSize(text: string, category: string | undefined): SizeResult {
  const tire = tireSizeMatch(text);
  if (tire) return { tag: tire.tag, kind: "tire", raw: tire.raw };
  if (category === "tires") return { tag: "", kind: "none", raw: "" };
  const pack = packSizeMatch(text);
  if (pack) return { tag: pack.tag, kind: pack.kind, raw: pack.raw };
  return { tag: "", kind: "none", raw: "" };
}

// ---------------------------------------------------------------------------------------------
// Brand detection - explicit arg (if non-junk) > longest knownBrands lexicon match at a word
// boundary > leading-token heuristic (capitalized-word-shaped, non-generic) > "".
// ---------------------------------------------------------------------------------------------
const GENERIC_LEAD_WORDS = new Set([
  "tire", "tires", "tyre", "tyres", "the", "new", "premium", "used", "genuine", "best", "top",
  "cheap", "hot", "free", "sale", "brand", "set", "pair", "all", "season",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "BurstBrand" / "Toyo" shaped (leading capital, has a lowercase letter - excludes ALL-CAPS
 *  noise like "TOYO" typed in a listing title, which only becomes a brand via the lexicon). */
function isCapitalizedWordShape(token: string): boolean {
  return /^[A-Z][a-zA-Z]*$/.test(token) && /[a-z]/.test(token);
}

function lexiconBrandMatch(text: string, knownBrands: string[]): string {
  let best = "";
  for (const candidate of knownBrands) {
    const c = (candidate ?? "").trim();
    if (!c) continue;
    const re = new RegExp(`\\b${escapeRegex(c)}\\b`, "i");
    if (re.test(text) && c.length > best.length) best = c;
  }
  return best;
}

function leadingTokenBrand(text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first || !isCapitalizedWordShape(first) || GENERIC_LEAD_WORDS.has(first.toLowerCase())) return "";
  const second = tokens[1];
  if (second && isCapitalizedWordShape(second) && !GENERIC_LEAD_WORDS.has(second.toLowerCase()) && !/\d/.test(second)) {
    return `${first} ${second}`;
  }
  return first;
}

function detectBrand(text: string, explicitBrand: string | undefined, knownBrands: string[] | undefined): string {
  if (explicitBrand && !isBrandJunk(explicitBrand)) return explicitBrand.trim();
  const lexiconMatch = lexiconBrandMatch(text, knownBrands ?? []);
  if (lexiconMatch) return lexiconMatch;
  // The leading-token guess is only safe when the caller operates in a domain that supplies a
  // brand lexicon at all (e.g. the tire/catalog structuring flow). Without one (plain grocery/
  // retail names with no ctx.knownBrands), guessing from capitalization alone produces too many
  // false brands - unknown ("") is the correct, safer answer there.
  if (knownBrands === undefined) return "";
  return leadingTokenBrand(text);
}

// ---------------------------------------------------------------------------------------------
// Marketplace noise stripping (shared by descriptionText and model).
// ---------------------------------------------------------------------------------------------
function stripMarketplaceNoise(raw: string): string {
  let s = raw;
  // Trailing "| eBay"-style tail: digit-free, short.
  s = s.replace(/\s*\|\s*[^\d|]{2,30}$/, " ");
  // NOTE: a parenthetical "(2 Pack)" is NOT stripped here - it is the count sizeTag's source
  // text. detectSize() reads it from descriptionText, then buildModel() removes it (and the
  // resulting empty parens) once the tag has been captured. Stripping it here would erase the
  // count tag before it is ever detected.
  // Leading quantity prefixes: "2 X ", "4 New ", "4 Used ".
  s = s.replace(/^\s*\d+\s*[xX]\s+/, "");
  s = s.replace(/^\s*\d+\s*(new|used)\s+/i, "");
  return s.replace(/\s+/g, " ").trim();
}

const MODEL_EDGE_NOISE = new Set([
  "tire", "tires", "tyre", "tyres", "new", "set", "pair", "pcs", "wheel", "wheels", "oem",
  "radial", "the", "a", "of", "with", "and",
]);

const LOAD_INDEX_RE = /^\d{2,3}[A-Za-z]{1,2}$/; // e.g. "102W", "94V" - tire load index/speed rating

function buildModel(descriptionText: string, brand: string, size: SizeResult): string {
  let working = descriptionText;
  if (brand) {
    working = working.replace(new RegExp(`\\b${escapeRegex(brand)}\\b`, "i"), " ");
  }
  if (size.raw) {
    const idx = working.indexOf(size.raw);
    if (idx >= 0) working = working.slice(0, idx) + " " + working.slice(idx + size.raw.length);
  }
  working = working.replace(/\(\s*\)/g, " "); // stray empty parens left behind by a "(2 Pack)" removal
  let tokens = working.split(/\s+/).filter(Boolean);
  if (size.kind === "tire") {
    tokens = tokens.filter((t) => !LOAD_INDEX_RE.test(t));
  }
  while (tokens.length && MODEL_EDGE_NOISE.has(tokens[0].toLowerCase())) tokens.shift();
  while (tokens.length && MODEL_EDGE_NOISE.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  return tokens.join(" ").trim();
}

function computeConfidence(brand: string, sizeTag: string): number {
  const hasBrand = brand.length > 0;
  const hasSize = sizeTag.length > 0;
  if (hasBrand && hasSize) return 0.9;
  if (hasBrand || hasSize) return 0.7;
  return 0.4;
}

const JUNK_RESULT: StructuredProduct = {
  brand: "",
  model: "",
  descriptionText: "",
  sizeTag: "",
  sizeTagKind: "none",
  confidence: 0,
};

export function structureProduct(name: string, brand?: string, ctx?: StructurerContext): StructuredProduct {
  const raw = (name ?? "").trim();
  if (isJunkName(raw)) return { ...JUNK_RESULT };

  const descriptionText = stripMarketplaceNoise(raw);
  if (!descriptionText) return { ...JUNK_RESULT };

  const detectedBrand = detectBrand(descriptionText, brand, ctx?.knownBrands);
  const size = detectSize(descriptionText, ctx?.category);
  const model = buildModel(descriptionText, detectedBrand, size);
  const confidence = computeConfidence(detectedBrand, size.tag);

  return {
    brand: detectedBrand,
    model,
    descriptionText,
    sizeTag: size.tag,
    sizeTagKind: size.kind,
    confidence,
  };
}
