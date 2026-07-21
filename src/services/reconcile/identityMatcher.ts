// identityMatcher.ts (reconcile Phase 2, Task 5) - brand-qualified identity matcher, the correctness
// heart of the Shop-Ware reconcile round. PURE function: no corpus/server imports, no React/next
// imports, no store access. All lookups are injected via MatcherDeps so this file never touches a
// database or the network. The matcher NEVER writes aliases or touches stores - linkageSuggestion is
// DATA ONLY, surfaced for a human to confirm elsewhere (AM-R6; reconcile matches never auto-approve).
//
// Resolution order (AM-R4/AM-R5, spec 2026-07-15-shopware-reconcile-pn-fill-design.md - copied
// verbatim, it is the law):
//   1. Part-number hit [AM-R4]: a bare index hit is NOT safe (PNs are per-manufacturer namespaces
//      that collide across brands). A PN hit is `matched` ONLY when it ALSO passes: brand equal or
//      `sameBrandFamily` (when the row carries a brand), AND size equal (when both sides carry a
//      parseable size). A PN hit failing that corroboration, or resolving to multiple corpus rows,
//      is `ambiguous` - never `matched`. A row with NO brand and NO size but a unique PN hit is also
//      `ambiguous` (nothing corroborates it, AM-R10a class).
//   2. Identity match [AM-R5]: size EXACT via the existing `tireSizeToken` (never a new parser) +
//      brand equal or same `brandFamilies` family + model token overlap via `identityMerge`'s
//      tokenizer with Jaccard >= 0.75 AND the `plusGenerationDiff` guard (R8 vs R8+ are different
//      products) -> `matched` when exactly ONE candidate; `ambiguous` when several.
//   3. Not a tire (no parseable size and no tire signals) -> `non_tire` passthrough (not an error).
//   4. Otherwise -> `unmatched`.
//
// Trust rule: wrong product identity is FAILURE; unmatched/ambiguous is ACCEPTABLE. When in doubt
// between matched and ambiguous, the answer is ambiguous.

import type { ExpectedInventoryRow } from "./types";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import { IDENTITY_JACCARD_THRESHOLD, FUZZY_BRAND_MIN, nameTokens, jaccard, plusGenerationDiff } from "@/services/catalog/identityMerge";
import { normalizedEditSimilarity } from "@/services/reconcile/normalizedEditDistance";
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { basePartNumberKey, tirePartNumberCore } from "@/services/catalog/tirePartNumber";
import { matchImportFuzzy, normalizeImportSize } from "@/services/reconcile/importFuzzyMatcher";

export type MatchStatus = "matched" | "ambiguous" | "unmatched" | "non_tire";

export interface CorpusCandidate {
  uid: string;
  brand: string;
  name: string;
  sizeToken?: string;
  partNumber?: string;
  barcode?: string;
}

export interface MatchResult {
  row: ExpectedInventoryRow;
  status: MatchStatus;
  /** Honest, human-readable, always set - even on `matched`. */
  reason: string;
  /** Only set when `status === "matched"`. */
  candidate?: CorpusCandidate;
  /** Deterministic similarity in [0,1]. Exact corroborated PN hits are 1. `null` or unset means
   *  not applicable (e.g. ambiguous/unmatched), matching `ImportPreviewRow.confidence` in importSchema.ts. */
  confidence?: number | null;
  matchBasis?: "part_number_exact" | "part_number_affix_core" | "identity_jaccard" | "identity_fuzzy";
  /** Set when `status === "ambiguous"` and there is more than one colliding candidate. */
  candidates?: CorpusCandidate[];
  /** Matched rows with a corpus barcode (AM-R6): a SUGGESTION-GRADE barcode <-> part-number linkage.
   *  Data only - the matcher never writes this as an alias or touches any store. */
  linkageSuggestion?: { barcode: string; partNumber: string };
  /** True when the ONLY part-number evidence came from an affix-stripped core key (owner correction 1):
   *  the weakest tier, a discovery candidate that must be confirmed against the exact product, never attached. */
  viaAffixCore?: boolean;
}

export interface MatcherDeps {
  /** ALL hits for a normalized part number, never LIMIT 1 (a non-unique index must not be treated as unique). */
  lookupByPartNumber(normalizedPn: string): CorpusCandidate[];
  /** Candidates sharing a brand (or its family) and an exact tire size token, for the identity path. */
  candidatesByBrandSize(brand: string | undefined, sizeToken: string): CorpusCandidate[];
  /** Candidates for the character-fuzzy fallback tier (Task 15, Stage B): all corpus rows sharing the
   *  row's exact size token, regardless of brand - matchImportFuzzy does its own brand corroboration
   *  (family or bounded edit-distance) so this must NOT pre-filter by brand equality. */
  candidatesForFuzzy?(sizeToken: string): CorpusCandidate[];
}

/** Same brand-equality test the rest of the round uses: equal after brandFamilies' own normalization,
 *  or the two brands are members of the same curated company family. */
function brandsCorroborate(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  return sameBrandFamily(a, b);
}

/** Distinguishes a TYPO of the same brand ("Micheln" vs "Michelin") from a genuinely different real
 *  brand ("Goodyear" vs "Michelin"). Same test the character-fuzzy tier (importFuzzyMatcher) already
 *  uses for this exact question: same curated brandFamilies family, or normalized edit-similarity
 *  clearing FUZZY_BRAND_MIN. Deliberately NOT used for general brand corroboration (that stays exact-
 *  or-family only, AM-R4/AM-R5) - only to decide whether an exact-barcode identity should be trusted
 *  over a brand-text mismatch that is plausibly just a typo. */
function brandsAreTypoOfSameBrand(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (brandsCorroborate(a, b)) return true;
  return normalizedEditSimilarity(a, b) >= FUZZY_BRAND_MIN;
}

/** Best-effort parseable tire size for a row: sizeText first, falling back to specs/model/name text so
 *  a size embedded in a free-text spec column (or a Name-only column, as UniversalImportPanel produces
 *  when there is no dedicated size column) is still found. Falls back to notation-normalized parsing
 *  (dash/space separators, e.g. "225-65-17" or "225 65 17") when the direct canonical parse misses -
 *  same-numbers-different-separator is size EQUALITY, not fuzzy tolerance (mirrors importFuzzyMatcher's
 *  sizeOf helper so the exact-token identity tier and the fuzzy fallback agree on what counts as the
 *  same size). "" when nothing parses either way. */
function rowSizeToken(row: ExpectedInventoryRow): string {
  const text = [row.sizeText ?? "", row.specs ?? "", row.model ?? "", row.name ?? ""].join(" ");
  const direct = tireSizeToken({ productName: text, brand: row.brand });
  if (direct) return direct;
  return tireSizeToken({ productName: normalizeImportSize(text), brand: row.brand });
}

/** Whether the row shows any tire signal at all (a parseable size, or a brand/model that reads as a
 *  tire even without one) - used only to decide `non_tire` vs `unmatched` when nothing else matched. */
function hasAnyTireSignal(row: ExpectedInventoryRow, sizeToken: string): boolean {
  if (sizeToken) return true;
  const text = `${row.brand ?? ""} ${row.model ?? ""} ${row.specs ?? ""} ${row.name ?? ""}`.toLowerCase();
  return /\b(tire|tyre|r1[3-9]|r20|r21|r22)\b/.test(text);
}

function buildLinkageSuggestion(candidate: CorpusCandidate, row: ExpectedInventoryRow): { barcode: string; partNumber: string } | undefined {
  if (!candidate.barcode) return undefined;
  const pn = candidate.partNumber ?? row.partNumbers[0];
  if (!pn) return undefined;
  return { barcode: candidate.barcode, partNumber: pn };
}

/**
 * Match one Shop-Ware expected-inventory row against the corpus. Pure: all data access is through
 * `deps`. Never mutates `row`. Never writes aliases or touches a store - `linkageSuggestion` is a
 * data-only hint for a human confirmation step elsewhere (AM-R6).
 */
export function matchExpectedRow(row: ExpectedInventoryRow, deps: MatcherDeps): MatchResult {
  const rowSize = rowSizeToken(row);

  // --- Step 1: part-number hit (AM-R4) ---------------------------------------------------------
  const pnHits = new Map<string, CorpusCandidate>();
  const baseHitUids = new Set<string>();
  for (const rawPn of row.partNumbers) {
    const base = basePartNumberKey(rawPn);
    if (base) {
      for (const hit of deps.lookupByPartNumber(base)) {
        pnHits.set(hit.uid, hit);
        baseHitUids.add(hit.uid);
      }
    }
    // Affix core is DISCOVERY-ONLY (owner correction 1): it may ADD a candidate but never outranks a
    // base hit, and a core-only hit is tagged so it is never mistaken for exact identity.
    const core = tirePartNumberCore(rawPn);
    if (core) {
      for (const hit of deps.lookupByPartNumber(core)) {
        if (!pnHits.has(hit.uid)) pnHits.set(hit.uid, hit);
      }
    }
  }

  if (pnHits.size > 0) {
    const hits = [...pnHits.values()];

    if (hits.length > 1) {
      return {
        row,
        status: "ambiguous",
        reason: `Part number matches ${hits.length} different corpus products (${hits.map((h) => `${h.brand} ${h.name}`).join(", ")}); cannot pick one safely.`,
        candidates: hits,
      };
    }

    const hit = hits[0];
    const hasRowBrand = !!row.brand && row.brand.trim().length > 0;
    const hitSize = hit.sizeToken ?? "";
    const bothHaveSize = !!rowSize && !!hitSize;
    // An exact-barcode match (same canonical GTIN, byte-exact as parsed) is a STRONGER identity signal
    // than fuzzy brand text. When the row's barcode matches the PN-hit candidate's barcode byte-exact,
    // AND the brand mismatch is plausibly just a typo of the SAME brand (not a genuinely different real
    // brand), trust the barcode identity instead of downgrading to a false "brand collision". A truly
    // different brand (e.g. barcode says Michelin but the row says Goodyear) still gets flagged below -
    // this only forgives the typo case, never a real cross-brand collision.
    const barcodeExact = !!row.barcode && !!hit.barcode && row.barcode.trim() === hit.barcode.trim();

    if (!hasRowBrand && !rowSize) {
      // Nothing to corroborate a per-manufacturer-namespace PN hit with - ambiguous, not matched.
      return {
        row,
        status: "ambiguous",
        reason: `Part number hit for "${hit.brand} ${hit.name}" but the Shop-Ware row has no brand or size to corroborate it; a bare PN hit is not safe (PN namespaces collide across brands).`,
      };
    }

    if (hasRowBrand && !brandsCorroborate(row.brand, hit.brand)) {
      const typoOfSameBrand = barcodeExact && brandsAreTypoOfSameBrand(row.brand, hit.brand);
      if (!typoOfSameBrand) {
        return {
          row,
          status: "ambiguous",
          reason: `Part number hit resolves to brand "${hit.brand}" but the Shop-Ware row says brand "${row.brand}" (not the same company); treating as a brand collision, not a match.`,
        };
      }
      // Fall through: exact-barcode identity + a same-brand typo overrides the brand-text mismatch.
    }

    if (bothHaveSize && rowSize !== hitSize) {
      return {
        row,
        status: "ambiguous",
        reason: `Part number hit for "${hit.brand} ${hit.name}" has size ${hitSize}, but the Shop-Ware row says ${rowSize}; sizes disagree so this is not a safe match.`,
      };
    }

    // At least one corroboration signal must have actually been CHECKED and agreed - a signal that
    // was merely absent on one side (e.g. row has a size but the corpus hit carries none at all) is
    // not corroboration, it is just an unchecked dimension. Without this, a PN hit with a size-only
    // row against a size-less corpus candidate would fall through to `matched` on zero real evidence.
    const brandTypoCorroborated = hasRowBrand && barcodeExact && !brandsCorroborate(row.brand, hit.brand)
      && brandsAreTypoOfSameBrand(row.brand, hit.brand);
    const brandCorroborated = hasRowBrand && brandsCorroborate(row.brand, hit.brand);
    const sizeCorroborated = bothHaveSize && rowSize === hitSize;
    if (!brandCorroborated && !sizeCorroborated && !brandTypoCorroborated) {
      return {
        row,
        status: "ambiguous",
        reason: `Part number hit for "${hit.brand} ${hit.name}" but neither brand nor size could actually be corroborated against the corpus record; a bare PN hit is not safe (PN namespaces collide across brands).`,
      };
    }

    const reasonBits: string[] = [];
    if (brandCorroborated) reasonBits.push("brand corroborated");
    if (brandTypoCorroborated) reasonBits.push("exact barcode match overrides a likely brand typo");
    if (sizeCorroborated) reasonBits.push("size corroborated");
    const viaAffixCore = !baseHitUids.has(hit.uid);
    const coreNote = viaAffixCore ? " Candidate found via distributor-affix core - confirm the exact product before attaching." : "";
    return {
      row,
      status: "matched",
      confidence: 1,
      matchBasis: viaAffixCore ? "part_number_affix_core" : "part_number_exact",
      reason: `Part number hit for "${hit.brand} ${hit.name}" (${reasonBits.join(", ") || "corroborated"}).${coreNote}`,
      candidate: hit,
      linkageSuggestion: buildLinkageSuggestion(hit, row),
      viaAffixCore,
    };
  }

  // --- Step 2: identity match (AM-R5) -----------------------------------------------------------
  if (rowSize) {
    const rowTokens = nameTokens(row.model ?? "");
    const candidates = deps.candidatesByBrandSize(row.brand, rowSize);

    const identityMatches: Array<{ candidate: CorpusCandidate; confidence: number }> = [];
    for (const cand of candidates) {
      if (cand.sizeToken !== rowSize) continue;
      if (!brandsCorroborate(row.brand, cand.brand)) continue;
      const candTokens = nameTokens(cand.name);
      const sim = jaccard(rowTokens, candTokens);
      if (sim < IDENTITY_JACCARD_THRESHOLD) continue;
      if (plusGenerationDiff(rowTokens, candTokens)) continue; // R8 vs R8+ - different product, never match here.
      identityMatches.push({ candidate: cand, confidence: sim });
    }

    if (identityMatches.length === 1) {
      const { candidate: cand, confidence } = identityMatches[0];
      return {
        row,
        status: "matched",
        confidence,
        matchBasis: "identity_jaccard",
        reason: `Identity match on size ${rowSize}, brand "${cand.brand}", and model name similarity to "${cand.name}".`,
        candidate: cand,
        linkageSuggestion: buildLinkageSuggestion(cand, row),
      };
    }

    if (identityMatches.length > 1) {
      return {
        row,
        status: "ambiguous",
        reason: `Identity match on size ${rowSize} and brand matches ${identityMatches.length} different corpus products (${identityMatches.map((c) => c.candidate.name).join(", ")}); cannot pick one safely.`,
        confidence: Math.max(...identityMatches.map((entry) => entry.confidence)),
        candidates: identityMatches.map((entry) => entry.candidate),
      };
    }
  }

  // --- Step 2b: character-fuzzy fallback (Stage B, Task 15) ------------------------------------
  // Only runs when the exact-token identity-jaccard tier above found ZERO survivors (fell through
  // without returning) AND there is at least one same-size corpus candidate to fuzzy-score against.
  // Without the non-empty guard, a row with a parseable size but truly nothing in the corpus at that
  // size would get matchImportFuzzy([]) -> "review" -> "ambiguous" here, silently downgrading the
  // pre-existing honest "unmatched" outcome for a genuine no-hit row. matchImportFuzzy does its own
  // brand corroboration (family or bounded edit-distance) and size-notation normalization; it NEVER
  // auto-approves (autoApprove: false).
  if (rowSize && deps.candidatesForFuzzy) {
    const fuzzyCandidates = deps.candidatesForFuzzy(rowSize);
    if (fuzzyCandidates.length > 0) {
      const fuzzy = matchImportFuzzy(row, fuzzyCandidates);
      if (fuzzy.status === "fuzzy") {
        return {
          row,
          status: "matched",
          reason: fuzzy.reason,
          confidence: fuzzy.confidence ?? undefined,
          matchBasis: "identity_fuzzy",
          candidate: fuzzy.candidate,
        };
      }
      if (fuzzy.status === "ambiguous" || fuzzy.status === "review") {
        return {
          row,
          status: "ambiguous",
          reason: fuzzy.reason,
          confidence: fuzzy.confidence ?? undefined,
          candidates: fuzzy.candidates,
        };
      }
    }
  }

  // --- Step 3 / 4: non_tire vs unmatched ---------------------------------------------------------
  if (!hasAnyTireSignal(row, rowSize)) {
    return {
      row,
      status: "non_tire",
      reason: "No parseable tire size and no tire signals found on this row; not treated as a tire product.",
    };
  }

  return {
    row,
    status: "unmatched",
    reason: "No part-number hit and no identity match found in the corpus for this row.",
  };
}
