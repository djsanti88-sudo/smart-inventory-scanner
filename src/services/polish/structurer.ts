// Deterministic product structurer (Build 2 / Task 1). Pure function, no React/next imports, no
// network. Splits a raw product name into brand / model / descriptionText plus a glued-digits
// size tag (every tire notation) or a weight/count/volume tag. AI/LLM never runs here - this is
// the $0 deterministic pass; low-confidence rows are handed to a later LLM-fallback task.
// The junk gate and brand-cleanliness shapes intentionally stay local so this pure deterministic
// service has no network-provider or server dependencies.

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
// Junk gate for breadcrumb arrows,
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

/** A brand string supplied by a caller can itself be shop-speak / a nav label / a host echo / a
 *  bare code echo - never trust it blindly. Reimplements the shape of junkRules.cleanBrand
 *  locally, and (R3) routes the arg through the SAME junk shapes as a full name so a junk brand
 *  arg like "amazon.com" or a scanned barcode string is treated as absent, not as a real brand. */
function isBrandJunk(brand: string): boolean {
  const b = (brand ?? "").trim();
  if (!b) return true;
  if (GENERIC_WHOLE_NAME_RE.test(b)) return true;
  if (SHOP_SPEAK_RE.test(b)) return true;
  if (BREADCRUMB_RE.test(b)) return true;
  if (HOST_ECHO_RE.test(b)) return true;
  if (CODE_ECHO_RE.test(b)) return true;
  if (/^(my store|the store|shop|store)$/i.test(b)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Tire size parsing - a richer standalone parser (reads siblingGuard.TIRE_SIZE_RE as a proven
// reference, does not import it). Handles: passenger (spaced/x/dash/ZR/XL glue, ST/LT/P service
// prefixes), decimal truck rims (22.5), flotation (37x12.50R20), ATV (25x8-12), motorcycle
// (100/80-17). Output is the three numeric groups glued together with every "." dropped.
// ---------------------------------------------------------------------------------------------
// (E1) The service-prefix group requires a non-letter (or start-of-string) immediately before it,
// via the inner negative lookbehind. Without this, the greedy `(?:ST|LT|P)` alternation would match
// the trailing "st"/"t"/"p" of an adjacent MODEL word (e.g. "Courser Quest 195/65R15" -> the "st" of
// "Quest" absorbed as a service prefix; "...Hp 225/40R18" -> the "p" of "Hp" absorbed), corrupting
// the matched span (`raw`) that buildModel() later strips out of the model text. The digit/rim
// groups themselves were already correct - only the extra absorbed letters leaked into `raw`.
const TIRE_SIZE_RE =
  /(?<![0-9])(?:(?<![A-Za-z])(?:ST|LT|P)\s?)?(\d{2,3}(?:\.\d+)?)\s?[/xX]\s?(\d{1,3}(?:\.\d+)?)\s?(Z?R|-)\s?(\d{2}(?:\.\d)?)\s?(?:XL|LT|ST)?(?![0-9])/i;

// (R1) Plausibility bounds against generic non-tire slash/dash numerics (e.g. "16/9-32" on a
// monitor stand, "12/5-14" as a recipe batch code). Scoped to the bare-hyphen separator only: the
// full 76,173-row tire-knowledge corpus was checked and NEVER uses a bare "-" separator (only
// "R"/"ZR"), while agricultural/OTR tires legitimately use widths/rims far outside passenger-tire
// ranges under the "R" separator (e.g. "800/70R38"). Restricting the bounds check to "-" catches
// the false-positive class without rejecting a single real "R"/"ZR" tire size in the corpus.
// Bounds: standard width 25-445mm / aspect 20-95%, OR flotation diameter 22-44in / width 4-18in;
// rim 8-30in (decimals like .5 allowed by the regex's rim group).
function isPlausibleTireSize(first: number, second: number, rim: number, separator: string): boolean {
  if (separator !== "-") return true;
  const standard = first >= 25 && first <= 445 && second >= 20 && second <= 95;
  const flotation = first >= 22 && first <= 44 && second >= 4 && second <= 18;
  const rimOk = rim >= 8 && rim <= 30;
  return (standard || flotation) && rimOk;
}

function tireSizeMatch(text: string): { tag: string; raw: string } | null {
  const re = new RegExp(TIRE_SIZE_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    if (isPlausibleTireSize(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[4]), m[3])) {
      return { tag: `${m[1]}${m[2]}${m[4]}`.replace(/\./g, ""), raw: m[0] };
    }
    if (m.index === re.lastIndex) re.lastIndex++; // defensive: never loop forever on a zero-length match
  }
  return null;
}

export function tireSizeTag(text: string): string {
  const m = tireSizeMatch(text);
  return m ? m.tag : "";
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

// (R5) PACK_UNIT_RE.exec (no "g" flag) always returns the leftmost match in the string, so when a
// name could plausibly carry more than one non-tire size/quantity notation, the FIRST one to occur
// textually wins - overlapping non-tire tags are resolved by textual order, not by unit priority.
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

// (R4) Compiling one RegExp per lexicon entry on every single structureProduct() call is wasteful
// once this runs hot over thousands of rows (an offline eval or a bulk import) with the same
// caller-supplied `knownBrands` array. Cache the compiled per-brand regexes keyed by the array's
// own reference identity - callers that pass the same lexicon array repeatedly (the normal case:
// one catalog/prefix-map lexicon built once, reused across every scan) get the compile cost once.
const lexiconRegexCache = new WeakMap<string[], Array<{ brand: string; re: RegExp }>>();

function compiledLexicon(knownBrands: string[]): Array<{ brand: string; re: RegExp }> {
  const cached = lexiconRegexCache.get(knownBrands);
  if (cached) return cached;
  const compiled = knownBrands
    .map((c) => (c ?? "").trim())
    .filter(Boolean)
    .map((c) => ({ brand: c, re: new RegExp(`\\b${escapeRegex(c)}\\b`, "i") }));
  lexiconRegexCache.set(knownBrands, compiled);
  return compiled;
}

// (E2) When multiple lexicon brands match the same text (a brand and its own sub-brand/family
// brand co-occurring, e.g. "Nokian Nordman 5" or "Ohtsu By Falken"), the correct brand is
// overwhelmingly the EARLIEST-occurring one in the text, not the longest string. Longest is only
// used to break a tie when two candidates start at the exact same position.
function lexiconBrandMatch(text: string, knownBrands: string[]): string {
  let best = "";
  let bestIndex = Infinity;
  for (const { brand: c, re } of compiledLexicon(knownBrands)) {
    const m = re.exec(text);
    if (!m) continue;
    if (m.index < bestIndex || (m.index === bestIndex && c.length > best.length)) {
      best = c;
      bestIndex = m.index;
    }
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

// (E3) "radial" is deliberately NOT in this generic set - see isEdgeNoise(), which only treats it
// as noise when it is the ONLY remaining model content. Real tire model lines routinely use it as
// an actual part of the name (BFGoodrich "Radial T/A", Thunderer "Radial R501").
const MODEL_EDGE_NOISE = new Set([
  "tire", "tires", "tyre", "tyres", "new", "set", "pair", "pcs", "wheel", "wheels", "oem",
  "the", "a", "of", "with", "and",
]);

const LOAD_INDEX_RE = /^\d{2,3}[A-Za-z]{1,2}$/; // e.g. "102W", "94V" - tire load index/speed rating

// (E3) Edge-noise stripping rules:
// - A generic noise word is only stripped from an edge when it is not the ONLY remaining model
//   content (never let stripping erase a token that would otherwise leave nothing to strip against).
// - "radial" specifically is only treated as noise when it is the sole remaining token; whenever
//   another token still exists, "radial" is real model content, not filler.
// - A single uppercase "A" is never treated as the noise-word article "a" - tire fitment codes
//   commonly end in an uppercase letter-pair like "T/A", "A/T", "M/S", and those must survive
//   (only the lowercase, natural-language article "a" is stripped).
function isEdgeNoise(token: string, remainingCount: number): boolean {
  if (token === "A") return false;
  const lower = token.toLowerCase();
  if (lower === "radial") return remainingCount <= 1;
  return MODEL_EDGE_NOISE.has(lower);
}

function buildModel(descriptionText: string, brand: string, size: SizeResult): string {
  let working = descriptionText;
  if (brand) {
    working = working.replace(new RegExp(`\\b${escapeRegex(brand)}\\b`, "i"), " ");
  }
  if (size.raw) {
    const idx = working.indexOf(size.raw);
    if (idx >= 0) {
      let after = working.slice(idx + size.raw.length);
      if (size.kind === "tire") {
        // (E3) A load index / speed rating (e.g. "102W") always immediately follows the size in
        // real tire naming - only strip it there. A token that merely LOOKS like a load index but
        // sits elsewhere (e.g. "365AW" in "Altimax 365AW", which precedes the size) is real model
        // content and must survive.
        const loadMatch = /^\s*(\d{2,3}[A-Za-z]{1,2})\b/.exec(after);
        if (loadMatch && LOAD_INDEX_RE.test(loadMatch[1])) {
          after = after.slice(loadMatch[0].length);
        }
      }
      working = working.slice(0, idx) + " " + after;
    }
    // (R2) A second (or later) tire-size mention in a multi-size listing must not leak into the
    // model - sizeTag always reflects only the first match, so strip every remaining tire-size
    // occurrence too.
    if (size.kind === "tire") {
      working = working.replace(new RegExp(TIRE_SIZE_RE.source, "gi"), " ");
    }
  }
  working = working.replace(/\(\s*\)/g, " "); // stray empty parens left behind by a "(2 Pack)" removal
  const tokens = working.split(/\s+/).filter(Boolean);
  while (tokens.length && isEdgeNoise(tokens[0], tokens.length)) tokens.shift();
  while (tokens.length && isEdgeNoise(tokens[tokens.length - 1], tokens.length)) tokens.pop();
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
