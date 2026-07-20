// src/services/reconcile/importFuzzyMatcher.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import {
  FUZZY_BRAND_MIN,
  IDENTITY_JACCARD_THRESHOLD,
  jaccard,
  nameTokens,
  plusGenerationDiff,
} from "@/services/catalog/identityMerge";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { normalizedEditSimilarity } from "@/services/reconcile/normalizedEditDistance";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

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

  // Size is a HARD gate, never fuzzy - mirrors identityMatcher Step 2's `if (rowSize)`.
  // A row with no parseable size may NOT fuzzy-match a specific-size candidate on name
  // alone (a size typo changes the physical product). Exact canonical-token equality only;
  // field concat order matches identityMatcher.rowSizeToken ([sizeText, specs, model]).
  const expectedSize = sizeOf([row.sizeText, row.specs, row.model].filter(Boolean).join(" "), row.brand);
  if (!expectedSize) return null;
  const candidateSize = sizeOf([candidate.sizeToken, candidate.name].filter(Boolean).join(" "), candidate.brand);
  if (expectedSize !== candidateSize) return null;

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

  const nameScore = Math.max(
    jaccard(expectedTokens, candidateTokens),
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
