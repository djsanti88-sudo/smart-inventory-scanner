// src/reconcile/match/importFuzzyMatcher.ts
import { tireSizeToken } from "@/decoding/tireSpecs";
import {
  FUZZY_BRAND_MIN,
  IDENTITY_JACCARD_THRESHOLD,
  nameTokens,
  plusGenerationDiff,
  prefixAwareJaccard,
} from "@/products/catalog/identityMerge";
import { sameBrandFamily } from "@/products/catalog/brandFamilies";
import { prefixBrandConflict } from "@/products/catalog/brandPrefixGeneral";
import { normalizedEditSimilarity } from "@/reconcile/match/normalizedEditDistance";
import type { CorpusCandidate } from "@/reconcile/match/identityMatcher";
import type { ExpectedInventoryRow } from "@/reconcile/types";

export interface FuzzyCandidateScore {
  candidate: CorpusCandidate;
  confidence: number;
  brandScore: number;
  nameScore: number;
}

export interface FuzzyImportDecision {
  status: "fuzzy" | "ambiguous" | "review";
  reason: string;
  confidence: number | null;
  candidate?: CorpusCandidate;
  candidates?: CorpusCandidate[];
  autoApprove: false;
}

function rowName(row: ExpectedInventoryRow): string {
  return row.model || row.name || row.specs || "";
}

// Notation normalization (owner-ratified "size-notation normalization"): the corpus size
// token is canonical NNN/NNRNN, but shop exports arrive as "225 65 17" or "225-65-17".
// This reformats any-separator width/aspect/rim into the canonical slash-R form so
// tireSizeToken can parse it. This is SAME-numbers-different-separator (the tires are
// identical), NOT fuzzy tolerance on size - a genuinely different or typo'd size still
// fails the exact-token gate below.
export function normalizeImportSize(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\b(LT|P|ST)?\s*(\d{3})[\s\-/](\d{2})[\s\-/](\d{2})\b/i);
  if (!m) return raw;
  const prefix = m[1] ? m[1].toUpperCase() : "";
  return raw.replace(m[0], `${prefix}${m[2]}/${m[3]}R${m[4]}`);
}

function sizeOf(value: string, brand?: string): string {
  // Canonical parse first (handles slash notation embedded in a name), then fall back to
  // notation-normalized so dash/space imports resolve to the SAME exact token.
  const direct = tireSizeToken({ productName: value, brand });
  return direct || tireSizeToken({ productName: normalizeImportSize(value), brand });
}

// Generic (non-tire) size / quantity units that make two otherwise-similar retail products DISTINCT:
// volume, weight, count, and pack notations. Matched with a required leading number so a bare unit
// letter inside a word never triggers. Used ONLY for the non-tire size-distinct guard (Improvement 2);
// it never relaxes the tire size gate. Canonicalized to "<number><unit>" for exact comparison; a set
// of tokens is returned because a name may carry more than one (e.g. "12 oz 6 pk").
const GENERIC_SIZE_UNIT =
  /(\d+(?:\.\d+)?)\s*(oz|ml|l|litre|liter|g|kg|lb|lbs|ct|count|pk|pack|x)\b/gi;

// Unit synonyms fold to one canonical spelling so "8ct" and "8 count", "6pk" and "6 pack" agree.
const UNIT_CANON: Record<string, string> = {
  litre: "l",
  liter: "l",
  l: "l",
  lbs: "lb",
  lb: "lb",
  count: "ct",
  ct: "ct",
  pack: "pk",
  pk: "pk",
};

function genericSizeTokens(value: string): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const m of value.matchAll(GENERIC_SIZE_UNIT)) {
    const num = String(parseFloat(m[1]));
    const unitRaw = m[2].toLowerCase();
    const unit = UNIT_CANON[unitRaw] ?? unitRaw;
    out.add(`${num}${unit}`);
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// A single name-token that is purely a generic size/quantity token (number glued to a unit, a bare
// numeric quantity, or a standalone unit word). On the NON-TIRE path the generic size is validated
// separately (setsEqual guard), so these tokens must NOT pollute the name-similarity score - "8ct"
// vs "8 count" is a size-notation difference, not a discriminating model-name difference.
const GENERIC_SIZE_NAME_TOKEN =
  /^(?:\d+(?:\.\d+)?(?:oz|ml|l|litre|liter|g|kg|lb|lbs|ct|count|pk|pack|x)?|oz|ml|litre|liter|kg|lbs|lb|count|pack|pk)$/i;

function stripGenericSizeTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !GENERIC_SIZE_NAME_TOKEN.test(t));
}

export function scoreImportCandidate(
  row: ExpectedInventoryRow,
  candidate: CorpusCandidate,
): FuzzyCandidateScore | null {
  const expectedName = rowName(row);
  const candidateName = candidate.name || "";
  if (!expectedName || !candidateName) return null;

  const expectedTokens = nameTokens(expectedName);
  const candidateTokens = nameTokens(candidateName);
  if (plusGenerationDiff(expectedTokens, candidateTokens)) return null;

  // Name-scoring tokens: identical to the raw tokens on the TIRE path (unchanged behavior). On the
  // NON-TIRE path they get generic size/quantity tokens stripped (validated separately below).
  let nameTokensA = expectedTokens;
  let nameTokensB = candidateTokens;

  // --- Size / size-distinct gating ---
  // TIRE path (unchanged): when BOTH sides carry a parseable tire size it is a HARD gate, never
  // fuzzy - a row with no parseable size may NOT fuzzy-match a specific-size candidate on name alone
  // (a size typo changes the physical product). Exact canonical-token equality only; field concat
  // order matches identityMatcher.rowSizeToken ([sizeText, specs, model]).
  const expectedRowText = [row.sizeText, row.specs, row.model].filter(Boolean).join(" ");
  const candidateText = [candidate.sizeToken, candidate.name].filter(Boolean).join(" ");
  const expectedSize = sizeOf(expectedRowText, row.brand);
  const candidateSize = sizeOf(candidateText, candidate.brand);

  if (expectedSize || candidateSize) {
    // At least one side is a tire (has a parseable tire size). Preserve today's behavior EXACTLY:
    // both must resolve to the identical canonical tire token, else no match. (A one-sided tire size
    // fails this equality, so a sizeless row still cannot fuzzy-match a specific-size tire candidate.)
    if (expectedSize !== candidateSize) return null;
  } else {
    // NON-TIRE path (Improvement 2): neither side is a tire. Drop the tire-size hard gate but
    // generalize "different size = distinct" to generic volume/weight/count/pack units. Extract a
    // generic size/quantity token set from each name:
    //   - BOTH sides carry a size token and they DIFFER -> DISTINCT (return null), exactly like tires.
    //   - Only ONE side carries a size token -> conservative: cannot prove same product, no match.
    //   - Neither side carries a size token -> allowed to proceed on brand + name alone.
    const expectedGeneric = genericSizeTokens(expectedRowText || expectedName);
    const candidateGeneric = genericSizeTokens(candidateText || candidateName);
    const hasExpected = expectedGeneric.size > 0;
    const hasCandidate = candidateGeneric.size > 0;
    if (hasExpected !== hasCandidate) return null; // one-sided size -> conservative no match
    if (hasExpected && hasCandidate && !setsEqual(expectedGeneric, candidateGeneric)) return null; // size-distinct
    // Size already validated; keep it out of the name-similarity score ("8ct" vs "8 count").
    nameTokensA = stripGenericSizeTokens(expectedTokens);
    nameTokensB = stripGenericSizeTokens(candidateTokens);
  }

  // Sanctioned brand-conflict veto, unconditional: a known GS1-prefix-to-brand conflict
  // kills the match. prefixBrandConflict is a negative veto, never positive proof.
  const code = row.barcode || row.partNumbers[0] || "";
  if (prefixBrandConflict(code, row.brand)) return null;

  // Brand corroboration: same curated corporate family (preserves the Dunlop carve-out) OR
  // a BOUNDED typo-tolerance floor. Brand edit-distance is NOT a general similarity notion -
  // it must clear FUZZY_BRAND_MIN so distinct real brands that merely look alike route to
  // review, never surface as a fuzzy suggestion. (Keeps "Micheln"->"Michelin" working.)
  const sameFamily = !!row.brand && !!candidate.brand && sameBrandFamily(row.brand, candidate.brand);
  const brandEdit = row.brand && candidate.brand
    ? normalizedEditSimilarity(row.brand, candidate.brand)
    : 0;
  if (row.brand && candidate.brand && !sameFamily && brandEdit < FUZZY_BRAND_MIN) return null;
  const brandScore = sameFamily ? 1 : brandEdit;

  // Prefix-aware token overlap (Improvement 1) lets "Def LTX" ~ "Defender LTX" and
  // "Wrangler" ~ "Wrangler AT" surface, while a discriminating extra token still drags the score
  // down. Whole-string edit-similarity is still taken as an alternative for reordered/typo names.
  const nameScore = Math.max(
    prefixAwareJaccard(nameTokensA, nameTokensB),
    normalizedEditSimilarity(expectedName, candidateName),
  );
  return {
    candidate,
    brandScore,
    nameScore,
    confidence: Math.min(brandScore, nameScore),
  };
}

export function matchImportFuzzy(
  row: ExpectedInventoryRow,
  candidates: CorpusCandidate[],
): FuzzyImportDecision {
  const scored = candidates
    .map((candidate) => scoreImportCandidate(row, candidate))
    .filter((entry): entry is FuzzyCandidateScore => entry !== null)
    .sort((left, right) => right.confidence - left.confidence);
  const qualifying = scored.filter((entry) => entry.confidence >= IDENTITY_JACCARD_THRESHOLD);

  if (qualifying.length === 1) {
    return {
      status: "fuzzy",
      reason: "Unique typo-tolerant candidate requires human confirmation.",
      confidence: qualifying[0].confidence,
      candidate: qualifying[0].candidate,
      autoApprove: false,
    };
  }
  if (qualifying.length > 1) {
    return {
      status: "ambiguous",
      reason: "Multiple typo-tolerant candidates require human selection.",
      confidence: qualifying[0].confidence,
      candidates: qualifying.map((entry) => entry.candidate),
      autoApprove: false,
    };
  }
  return {
    status: "review",
    reason: "No candidate met the 0.75 fuzzy threshold.",
    confidence: scored[0]?.confidence ?? null,
    candidates: scored.slice(0, 3).map((entry) => entry.candidate),
    autoApprove: false,
  };
}
