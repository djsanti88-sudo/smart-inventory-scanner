// tireListingNormalizer.ts - pure, deterministic tire LISTING title cleaner + identity parser.
// No AI, no network. Built for real marketplace-scraped tire names that carry quantity prefixes
// ("Set of 4", "2 New", "1x"), condition words ("New", "NEW!"), foreign listing boilerplate
// (Polish "ostatnia sztuka", Cyrillic listing suffixes), retailer noise ("(TWO)", "(4 Tires)"),
// and fitment clauses ("Fits: 2004 Chevrolet ..."). Owner review of 268 live-decoded tire rows
// found this junk bleeding into stored product names and the Model field (items A1/A2/A3).
//
// Reuses the battle-tested size + load/speed parsing from tireSizeNormalizer.ts (matchTireSize)
// rather than inventing a competing regex - that module already owns the canonical
// "[LT|P|ST]W/AR RD [load][speed]" format and the range guards that keep an arbitrary number from
// being read as a size. This module adds: junk/quantity/condition/foreign-boilerplate stripping,
// brand/model isolation, and a sidewall-marker split, on top of that proven size parser.
//
// Project rule (resolver trust): a part that cannot be confidently found stays "" - never a wrong
// guess. A bare ambiguous size blob stays unparsed rather than guessed.

import { matchTireSize } from "@/products/tires/tireSizeNormalizer";
import { KNOWN_TIRE_BRANDS } from "@/decoding/tireSpecs";

// Small supplement to tireSpecs' curated KNOWN_TIRE_BRANDS, hand-verified from the real stress
// corpus fixtures (.superpowers/stress/results-relad100/batch-1.json, results-relad/batch-1.json)
// where these real tire brands appear constantly but are missing from that list. Kept local
// (never modifies the shared tireSpecs list, which other trust-gate code depends on).
const LISTING_BRAND_SUPPLEMENT = ["fortune", "mastercraft"];
const LISTING_KNOWN_BRANDS = [...KNOWN_TIRE_BRANDS, ...LISTING_BRAND_SUPPLEMENT];

export type ParsedTireIdentity = {
  brand: string;
  model: string;
  size: string;
  loadSpeed: string;
  sidewall: string;
  rest: string;
  /** True when the cleaned name carries multiple distinct load/speed ratings for what looks like
   *  one size (e.g. "93V, 93W, 93H") - a listing PAGE covering several variants, not one product.
   *  loadSpeed is left "" in this case (never arbitrarily pick one variant's rating). */
  multiVariant: boolean;
};

// ---------------------------------------------------------------------------------------------
// A1: junk-stripping regexes.
// ---------------------------------------------------------------------------------------------

// Leading quantity prefixes: "Set of 4 ", "2 New ", "1x ", "4x ", "1 New ", "2 Used ".
const LEAD_SET_OF_RE = /^\s*set\s+of\s+\d+\s*/i;
const LEAD_QTY_NEW_RE = /^\s*\d+\s*(?:new|used)\s+/i;
const LEAD_QTYX_RE = /^\s*\d+\s*[xX]\s+/;

// Same quantity/marketing phrases, but ANYWHERE in the string (owner mandate: "Fortune Set Of 4
// FSR305 ..." has the phrase mid-string after the brand, not just leading). Requires a word
// boundary / whitespace on both sides so it can never eat digits that are part of a size token.
const MID_SET_OF_RE = /(?:^|\s)set\s+of\s+\d+(?:\s|$)/gi;
const MID_QTY_NEW_RE = /(?:^|\s)\d+\s*(?:new|used)(?:\s|$)/gi;
const MID_QTYX_RE = /(?:^|\s)\d+\s*[xX](?:\s|$)/g;
// Bug 5 (owner mandate 2026-07-21): the quantity strip removed "Set" but left "Of N"/"Of N
// word-number" remnants leaking into the model - live-observed "Bearway Of 2 Two Bw777", "Farroad Of
// 4 Four Frd26", "Durun Of 2 M626". Matches "Of <digit>" optionally followed by its spelled-out
// count word (Two/Three/.../Eight), anywhere in the string, at any position (not just leading).
const QTY_COUNT_WORD = "one|two|three|four|five|six|seven|eight";
const MID_OF_N_RE = new RegExp(`(?:^|\\s)of\\s+\\d+(?:\\s+(?:${QTY_COUNT_WORD}))?(?:\\s|$)`, "gi");
// Trailing bare "Tires"/"Tire" noise word at the very end of the string, but ONLY when it directly
// follows a sidewall marker (BSW/OWL/WSW/RWL/XL/SL) - the shape a real listing uses ("111T XL
// Tires"). Deliberately NOT a blanket trailing strip: a legitimate category-descriptor tail like
// "... Light Truck Tire" is preserved here (that phrase is trimmed later, in parseTireIdentity's
// own model-isolation edge-noise step, which is the correct layer for category-word stripping).
const TRAILING_TIRE_NOISE_RE = /(\b(?:BSW|OWL|WSW|RWL|XL|SL)\b)\s+tires?\s*$/i;

// Standalone condition words anywhere in the title: "New", "NEW!", "Used".
const CONDITION_WORD_RE = /\b(?:new|used)\b!?/gi;

// Internal UI status-tag leakage: a row's own name must NEVER carry the literal "(suggested)"
// status marker some earlier version of the app appended to it (the badge is UI-only, rendered as
// a separate sibling element - see FinalCountTable.tsx / LiveScanFeed.tsx). Stripped anywhere in
// the string, case-insensitively.
const SUGGESTED_TAG_RE = /\(\s*suggested\s*\)/gi;

// Parenthetical quantity/unit noise: "(TWO)", "(4 Tires)", "(2 Pack)", "(Two)".
const PAREN_QTY_WORD = /^(one|two|three|four|four|five|six|seven|eight)$/i;
const PAREN_NOISE_RE = /\(\s*(?:\d+\s*(?:tires?|tyres?|pack|pk|x)?|(?:one|two|three|four|five|six|seven|eight))\s*\)/gi;

// Trailing "Fits: ..." fitment clause (mirrors displayName.ts's customerDisplayName rule).
const FITS_CLAUSE_RE = /\s+(?:[-–—]\s*)?Fits[\s:].*$/i;

// Polish marketplace boilerplate: "ostatnia sztuka" (last piece/item).
const POLISH_BOILERPLATE_RE = /\bostatnia\s+sztuka\b/gi;

// Any Cyrillic run (listing suffixes like "ш 116Т (зима) а/шина" - not a latin model token).
const CYRILLIC_RUN_RE = /[Ѐ-ӿ]+/g;

// Trailing ellipsis some scraped titles carry ("... Tires 2357515 235 75 ...").
const TRAILING_ELLIPSIS_RE = /\s*\.{2,}\s*$/;

// Leading bracketed/parenthetical distributor tag that is not itself junk-quantity, e.g.
// "(Ikon Tyres) Hakkapeliitta SUV 7" - the parens are noise, the brand text inside survives.
const LEADING_PAREN_TAG_RE = /^\(([^()]+)\)\s*/;

// Leading foreign-language "tire(s)" boilerplate words (German "Reifen", French "Pneu"/"Pneus",
// Spanish "Neumatico"/"Neumaticos", with or without the accent). Mirrors the POLISH_BOILERPLATE_RE
// approach: a whole-word strip, never a substring match that could eat part of a brand/model.
const LEADING_FOREIGN_TIRE_WORD_RE = /^\s*(?:reifen|pneus?|neum[aá]ticos?)\s+/i;

// Retailer/foreign boilerplate tail introduced by a pipe ("| Preis auf AUTODOC"). Scoped to a
// TRAILING pipe-introduced span only (never a mid-string pipe some other listing might use for an
// unrelated reason) via the trailing $ anchor.
const TRAILING_PIPE_TAIL_RE = /\s*\|.*$/;

function stripParenIfNotQtyWord(inner: string): boolean {
  const t = inner.trim();
  if (/^\d+$/.test(t)) return true; // pure number, e.g. "(4)"
  if (PAREN_QTY_WORD.test(t)) return true;
  return false;
}

/**
 * Clean listing/marketing junk out of a raw tire listing title while preserving brand, model,
 * size, load/speed, and sidewall markers. Original casing is preserved where sensible (brand and
 * model tokens keep their casing; only stripped junk is removed).
 */
export function cleanListingTitle(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return "";

  // A leading bracket/paren tag ("(Ikon Tyres) ...") is a distributor prefix, not size/qty noise -
  // unwrap it (keep its text) before the quantity-word paren stripper runs, so a real word like
  // "Tyres" inside is never mistaken for the qty-word check below (which only matches whole "two"
  // etc, so this guard is defensive/clarifying rather than strictly required).
  const leadTagMatch = LEADING_PAREN_TAG_RE.exec(s);
  if (leadTagMatch && !stripParenIfNotQtyWord(leadTagMatch[1])) {
    s = `${leadTagMatch[1]} ${s.slice(leadTagMatch[0].length)}`;
  }

  s = s.replace(LEAD_SET_OF_RE, "");
  s = s.replace(LEAD_QTY_NEW_RE, "");
  s = s.replace(LEAD_QTYX_RE, "");
  s = s.replace(LEADING_FOREIGN_TIRE_WORD_RE, "");
  s = s.replace(SUGGESTED_TAG_RE, " ");

  // Trailing retailer pipe-tail boilerplate ("| Preis auf AUTODOC") - strip BEFORE the mid-string
  // quantity-phrase stripping below, since a "|"-introduced tail can itself contain digit-adjacent
  // text that would otherwise confuse the qty-phrase regexes.
  s = s.replace(TRAILING_PIPE_TAIL_RE, "");

  // Quantity/marketing phrases anywhere in the string (owner mandate: "Fortune Set Of 4 FSR305 ..."
  // has the phrase mid-string, after the brand). Run repeatedly since two phrases can be adjacent.
  let prevLen: number;
  do {
    prevLen = s.length;
    s = s.replace(MID_SET_OF_RE, " ");
    s = s.replace(MID_QTY_NEW_RE, " ");
    s = s.replace(MID_QTYX_RE, " ");
    s = s.replace(MID_OF_N_RE, " ");
  } while (s.length !== prevLen);

  s = s.replace(PAREN_NOISE_RE, " ");
  s = s.replace(FITS_CLAUSE_RE, "");
  s = s.replace(POLISH_BOILERPLATE_RE, " ");
  s = s.replace(CYRILLIC_RUN_RE, " ");
  s = s.replace(CONDITION_WORD_RE, " ");
  s = s.replace(TRAILING_ELLIPSIS_RE, "");
  s = s.replace(TRAILING_TIRE_NOISE_RE, "$1");

  // Collapse stray empty parens left behind by noise removal, then whitespace/edge punctuation.
  s = s.replace(/\(\s*\)/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s\-–—,/]+|[\s\-–—,/]+$/g, "").trim();

  return s;
}

// ---------------------------------------------------------------------------------------------
// A3: size canonicalization - thin wrapper over the proven tireSizeNormalizer parser so this
// module never competes with (or drifts from) its canonical format / range guards.
// ---------------------------------------------------------------------------------------------

// "235/65/17" shaped input (aspect and rim both slash-separated, no "R") - canonicalize the second
// slash to "R" before delegating to the shared parser, which expects an R/ZR/X separator before the
// rim. Scoped tightly (three purely-numeric groups only) so it can never misfire on an unrelated
// slash-heavy string.
const DOUBLE_SLASH_RE = /\b(\d{3})\/(\d{2})\/(\d{2}(?:\.\d)?)\b/;

function preNormalizeSizeSeparators(input: string): string {
  return DOUBLE_SLASH_RE.test(input) ? input.replace(DOUBLE_SLASH_RE, "$1/$2R$3") : input;
}

/** Shared size lookup used by both canonicalTireSize() and parseTireIdentity() - applies the
 *  double-slash pre-normalization before delegating to the shared, proven tireSizeNormalizer. */
function findSize(text: string) {
  return matchTireSize(preNormalizeSizeSeparators(text));
}

/** Canonical tire size string ([LT|P|ST]W/AR RD), or "" when the input is not a confident size. */
export function canonicalTireSize(raw: string | null | undefined): string {
  const m = findSize(raw ?? "");
  if (!m) return "";
  // matchTireSize's canonical may carry a trailing " <load><speed>" when the WHOLE input is just
  // "size + load/speed" (e.g. "P225/60R18 103H") - canonicalTireSize is size-only, so strip that.
  return m.canonical.split(" ")[0];
}

// ---------------------------------------------------------------------------------------------
// A2: full identity parse - brand / model / size / loadSpeed / sidewall / rest.
// ---------------------------------------------------------------------------------------------

const SIDEWALL_TOKEN_RE = /\b(BSW|OWL|WSW|RWL|XL|SL)\b/gi;

function extractBrand(cleaned: string): { brand: string; withoutBrand: string } {
  const lower = cleaned.toLowerCase();
  // Longest known-brand match first (mirrors tireSpecs.inferTireBrandFromName ordering).
  for (const b of [...LISTING_KNOWN_BRANDS].sort((x, y) => y.length - x.length)) {
    const idx = lower.indexOf(b);
    if (idx < 0) continue;
    const before = idx === 0 || /[^a-z0-9]/i.test(cleaned[idx - 1]);
    const after = idx + b.length >= cleaned.length || /[^a-z0-9]/i.test(cleaned[idx + b.length]);
    if (!before || !after) continue;
    const brandRaw = cleaned.slice(idx, idx + b.length);
    // Preserve proper casing for known brands (e.g. "fortune" is not in the KNOWN_TIRE_BRANDS
    // list, so this only fires for the curated list - title-case it for display consistency).
    const brand = brandRaw
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
    const withoutBrand = (cleaned.slice(0, idx) + " " + cleaned.slice(idx + b.length)).replace(/\s+/g, " ").trim();
    return { brand, withoutBrand };
  }

  // No known brand recognized - never guess one from capitalization alone. The leading token
  // (e.g. "Climaflex" in a listing with no separate declared brand) stays part of the model text.
  return { brand: "", withoutBrand: cleaned };
}

/**
 * Parse a raw tire listing title into { brand, model, size, loadSpeed, sidewall, rest }.
 * Empty string for any part that cannot be confidently found - never a wrong guess. Cyrillic (or
 * other non-latin) model text is dropped rather than transliterated; only the latin model token
 * (if any survives after cleaning) is kept.
 */
export function parseTireIdentity(raw: string | null | undefined): ParsedTireIdentity {
  const cleaned = cleanListingTitle(raw);
  if (!cleaned) {
    return { brand: "", model: "", size: "", loadSpeed: "", sidewall: "", rest: "", multiVariant: false };
  }

  const preNormalized = preNormalizeSizeSeparators(cleaned);
  const sizeMatch = findSize(cleaned);
  const size = sizeMatch?.canonical.split(" ")[0] ?? "";

  // Multi-speed-variant detection (owner mandate): a listing page naming several distinct
  // load/speed ratings for the same size ("93V, 93W, 93H") describes MULTIPLE product variants,
  // not one. Detected on comma-separated load/speed-shaped tokens anywhere in the cleaned text -
  // scoped to a run of 2+ such tokens so a single legitimate rating never false-positives.
  const MULTI_VARIANT_RUN_RE = /\b\d{2,3}[A-Z]\b(?:\s*,\s*\d{2,3}[A-Z]\b){1,}/i;
  const multiVariant = MULTI_VARIANT_RUN_RE.test(preNormalized);

  const loadSpeed = multiVariant ? "" : sizeMatch ? sizeMatch.canonical.split(" ").slice(1).join(" ") : "";

  // Remove the matched size + load/speed spans before isolating brand/model so their tokens never
  // leak into either. Work from the pre-normalized text so a "235/65/17" span (whose raw match
  // includes the synthesized "R") can still be located and stripped.
  let working = preNormalized;
  if (sizeMatch) {
    working = working.split(sizeMatch.raw).join(" ");
    if (sizeMatch.rawLoadSpeed) working = working.split(sizeMatch.rawLoadSpeed).join(" ");
  }
  if (multiVariant) {
    // Strip the entire comma-separated run of variant ratings out of the working text so none of
    // them leak into the model.
    working = working.replace(MULTI_VARIANT_RUN_RE, " ");
  }

  // Sidewall marker (BSW/OWL/WSW/RWL/XL/SL) - captured separately, stripped from model.
  const sidewallMatches = [...working.matchAll(SIDEWALL_TOKEN_RE)].map((m) => m[0].toUpperCase());
  const sidewall = [...new Set(sidewallMatches)].join(" ");
  working = working.replace(SIDEWALL_TOKEN_RE, " ");

  // Product-type noise words ("tires"/"tyres") never belong in a model, wherever they sit in the
  // string (not just at an edge - "Climaflex 4s Fsr402 - Tires 2254518" has it mid-string, ahead of
  // the size that already got stripped above).
  working = working.replace(/\b(tires?|tyres?)\b/gi, " ");
  // A bare "-" separator left dangling after other stripping is punctuation noise, not a model dash
  // like "A/T2" or "T/A" (those never appear as a STANDALONE token).
  working = working.replace(/(^|\s)-(\s|$)/g, " ");

  const { brand, withoutBrand } = extractBrand(working);

  // Trailing generic category/noise words that are not part of the model (mirrors structurer.ts's
  // MODEL_EDGE_NOISE set, extended with the tire-category words this fixture set showed).
  const EDGE_NOISE = new Set([
    "the", "a", "of", "with", "and",
    "light", "truck", "suv", "crossover", "touring", "all", "terrain", "commercial",
    "summer", "winter", "season", "radial", "position", "steer", "drive",
    "class", "grade", "ply", "cylinder",
  ]);

  // A bare tire load-range/ply class code trailing the model (e.g. "E", "C", "D2", "10PLY") - only
  // meaningful adjacent to a size, never part of a model designation.
  const LOAD_CLASS_RE = /^[A-Z]\d?$|^\d{1,2}PLY$/i;

  // A slash-joined compound (e.g. "SUV/Crossover") is edge-noise only when EVERY sub-word is noise -
  // this must never strip a real model fitment code like "A/T2" or "M/S" (those contain non-noise
  // sub-words, e.g. digits or single letters not in EDGE_NOISE).
  function isEdgeNoiseToken(tokenRaw: string): boolean {
    const parts = tokenRaw.toLowerCase().split("/").filter(Boolean);
    if (parts.length === 0) return true; // pure punctuation like "/" or "-"
    return parts.every((p) => EDGE_NOISE.has(p));
  }

  const tokens = withoutBrand.split(/\s+/).filter(Boolean);
  while (tokens.length && isEdgeNoiseToken(tokens[0])) tokens.shift();
  // Trim the trailing tail: repeatedly drop generic category/descriptor words and bare load-class
  // codes from the END, even when they are not the very last token popped consecutively (a
  // category phrase like "All Terrain" or "Touring SUV/Crossover" can span multiple words after
  // the model designation ends).
  while (tokens.length) {
    const lastRaw = tokens[tokens.length - 1];
    if (isEdgeNoiseToken(lastRaw) || LOAD_CLASS_RE.test(lastRaw)) {
      tokens.pop();
      continue;
    }
    break;
  }
  const model = tokens.join(" ").replace(/\s+/g, " ").trim();

  return { brand, model, size, loadSpeed, sidewall, rest: "", multiVariant };
}
