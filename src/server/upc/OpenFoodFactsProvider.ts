import "server-only";
import type { AiLookupResult, DecodeDecision } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";
import type { OpenFoodFactsOutcome, OpenFoodFactsProduct } from "@/services/upc/openFoodFactsClient";
import type { OpenFoodFactsUsage } from "@/server/upc/openFoodFactsUsage";

// The Open Food Facts FREE rung. SERVER-SIDE ONLY.
//
// Ladder position: runs SECOND among the free/paid rungs, AFTER UPCitemdb and BEFORE Go-UPC
// (owner order 2026-07-12 free-rungs plan). GTIN-gated at buildLadderRungs, same as UPCitemdb.
//
// This rung uses OFF's keyless, ODbL-licensed public API (~15 req/min/IP for reads, verified
// against openfoodfacts.github.io/openfoodfacts-server/api/ - see the task report for exact
// quotes). It NEVER touches the paid daily AI-lookup cap and keeps its OWN local per-minute
// throttle counter (hard-capped at 10/min, a buffer under the provider's ~15/min limit) -
// LESSONS_LEARNED L12: never charge the same request on two spend paths.
//
// Resolver Trust Rules: an OFF hit is ALWAYS a SUGGESTION, never a verified auto-count on its own.
// confidence is capped and exactCodeEvidenceVerifiedByApp is always false here - only the app's own
// EvidenceVerifier/store gate can promote a code to verified, and a single free-DB self-report is
// deliberately excluded from that path (wrong identity is FAILURE; Unknown is ACCEPTABLE).
//
// Everything is injected (client, usage gate, clock) so the rung is fully unit-testable with mocks
// and never touches the network, the filesystem, or process.env directly.

export type OpenFoodFactsRungResult = {
  path: "openfoodfacts_hit" | "openfoodfacts_miss" | "openfoodfacts_unavailable";
  decision?: DecodeDecision;
  results?: AiLookupResult[];
  reason: string;
};

export interface OpenFoodFactsRungDeps {
  client: (code: string) => Promise<OpenFoodFactsOutcome>;
  usage: OpenFoodFactsUsage;
  now?: () => Date;
}

/** Confidence cap for every OFF suggestion - a single free-DB source never exceeds this. */
const SUGGESTION_CONFIDENCE = 0.6;

function toResult(product: OpenFoodFactsProduct, code: string): AiLookupResult {
  return {
    ...emptyResult(),
    productName: product.name,
    brand: product.brand,
    category: product.category,
    primaryBarcode: code,
    confidence: SUGGESTION_CONFIDENCE,
    sourceUrls: [],
    verifiedFacts: [],
    needsHumanReview: true,
  };
}

function suggestionDecision(reason: string): DecodeDecision {
  return {
    status: "needs_review",
    confidence: SUGGESTION_CONFIDENCE,
    reason,
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: SUGGESTION_CONFIDENCE,
      reason,
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
}

/**
 * The Open Food Facts rung. Returns an explicit `reason` on EVERY branch (never silent).
 *
 * Order: GTIN gate (defense in depth; buildLadderRungs also gates this) -> local per-minute
 * throttle gate -> client call -> outcome mapping (hit -> suggestion; miss/quota/bad_format/
 * transient -> unsettled).
 */
export async function openFoodFactsRung(code: string, deps: OpenFoodFactsRungDeps): Promise<OpenFoodFactsRungResult> {
  // GTIN gate: non-GTIN input (wrong shape or bad check digit) is not an OFF lookup. Client never
  // called. (buildLadderRungs also gates this rung's existence in the ladder array; this is defense
  // in depth so the rung is safe to call directly too, e.g. from tests or future callers.)
  if (!isGtinShaped(code) || !isValidCheckDigit(code)) {
    return { path: "openfoodfacts_miss", reason: "not a GTIN / failed check digit" };
  }

  // Local per-minute throttle gate: hard-stop BEFORE any request, well under OFF's ~15/min limit.
  const spend = await deps.usage.canSpend();
  if (!spend.allowed) {
    return { path: "openfoodfacts_unavailable", reason: spend.reason ?? "openfoodfacts: local per-minute limit reached" };
  }

  const outcome = await deps.client(code);

  switch (outcome.kind) {
    case "hit": {
      await deps.usage.record();
      return {
        path: "openfoodfacts_hit",
        decision: suggestionDecision("Open Food Facts match (free tier, unverified) -> Needs Review suggestion"),
        results: [toResult(outcome.product, code)],
        reason: "Open Food Facts hit -> Needs Review suggestion",
      };
    }

    case "miss":
      return { path: "openfoodfacts_miss", reason: "openfoodfacts: no match" };

    case "quota":
      return { path: "openfoodfacts_unavailable", reason: "openfoodfacts: provider quota exhausted" };

    case "bad_format":
      return { path: "openfoodfacts_unavailable", reason: "openfoodfacts: provider rejected code format" };

    case "transient":
      return { path: "openfoodfacts_unavailable", reason: `openfoodfacts: transient error (${outcome.detail})` };
  }
}
