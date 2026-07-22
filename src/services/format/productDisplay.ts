// Pure display-only formatting for slug-style product names and lowercase brand strings coming out of
// the tire corpus (e.g. "wrangler_workhorse_at", brand "goodyear"). NEVER used for matching/normalized
// fields - those stay untouched. No React / next imports (services stay pure, per project convention).

// Per-token uppercase map for known tire-spec abbreviations.
const TOKEN_MAP: Record<string, string> = {
  at: "AT",
  ht: "HT",
  ltx: "LTX",
  f1: "F1",
};

// Two consecutive single-letter tokens that form a known slash pair, e.g. ["a","s"] -> "A/S".
// Must be merged BEFORE per-token casing/mapping runs, or naive per-token mapping breaks names like
// "energy_saver_a_s" (produces "Energy Saver A S" instead of "Energy Saver A/S").
const LETTER_PAIRS: Record<string, string> = {
  "a,s": "A/S",
  "m,s": "M/S",
};

// Short alphanumeric model codes like "cs5" or "g2" (letters+digits, length <= 4) are uppercased
// wholesale. Longer digit-containing words like "season2" are real words with a trailing digit, not
// model codes, so they get Title Case instead.
const MAX_MODEL_CODE_LENGTH = 4;

function isShortModelCode(part: string): boolean {
  return /\d/.test(part) && part.length <= MAX_MODEL_CODE_LENGTH;
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// Formats a single hyphen-part (or a whole non-hyphenated token): known TOKEN_MAP entries win, then
// short digit-containing model codes uppercase wholesale, everything else is Title Case.
function formatPart(part: string): string {
  const lower = part.toLowerCase();
  if (TOKEN_MAP[lower]) return TOKEN_MAP[lower];
  if (isShortModelCode(lower)) return lower.toUpperCase();
  return titleCaseWord(part);
}

// Hyphenated tokens ("all-season2") split on "-" FIRST, then each part is cased independently via
// formatPart - this keeps long digit-suffixed words ("season2") from being swept into the wholesale
// model-code uppercase rule meant for short codes ("g2", "cs5").
function titleCaseToken(token: string): string {
  if (token.includes("-")) {
    return token.split("-").map(formatPart).join("-");
  }
  return titleCaseWord(token);
}

function formatToken(token: string): string {
  if (token.includes("-")) {
    return titleCaseToken(token);
  }
  return formatPart(token);
}

// Merge grouped letter-pair tokens left to right BEFORE per-token casing, then map/title-case the rest.
function mergeAndFormatTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i].toLowerCase();
    const next = tokens[i + 1]?.toLowerCase();
    const pairKey = next !== undefined ? `${cur},${next}` : undefined;
    if (pairKey && LETTER_PAIRS[pairKey]) {
      out.push(LETTER_PAIRS[pairKey]);
      i += 1; // consume both tokens
      continue;
    }
    out.push(formatToken(tokens[i]));
  }
  return out;
}

/**
 * Prettifies a slug-style product/model name ("wrangler_workhorse_at" -> "Wrangler Workhorse AT") for
 * display only. Already-clean input (no underscore AND contains an uppercase letter) passes through
 * unchanged, so real spec strings like "245/70R16 107T" or already-formatted names are never mangled.
 */
export function prettifyProductName(input: string): string {
  if (!input) return input;
  const hasUnderscore = input.includes("_");
  const hasUpper = /[A-Z]/.test(input);
  if (!hasUnderscore && hasUpper) return input;

  if (!hasUnderscore) return titleCaseToken(input);

  const tokens = input.split("_").filter((t) => t.length > 0);
  return mergeAndFormatTokens(tokens).join(" ");
}

// Known multi-cap brand names that Title Case would get wrong.
const BRAND_MAP: Record<string, string> = {
  bfgoodrich: "BFGoodrich",
  goodyear: "Goodyear",
  michelin: "Michelin",
  cooper: "Cooper",
  firestone: "Firestone",
  bridgestone: "Bridgestone",
};

/**
 * Prettifies a lowercase brand string for display only. Known brands use their canonical casing;
 * everything else falls back to Title Case.
 */
export function prettifyBrand(input: string): string {
  if (!input) return input;
  const lower = input.toLowerCase();
  if (BRAND_MAP[lower]) return BRAND_MAP[lower];
  return titleCaseToken(input);
}
