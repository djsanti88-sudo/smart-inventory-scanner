import "server-only";
import type { AiLookupResult, DecodeDecision } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";
import type { UpcItemDbOutcome, UpcItemDbItem } from "@/services/upc/upcItemDbClient";
import type { UpcItemDbUsage } from "@/server/upc/upcItemDbUsage";

// The UPCitemdb FREE rung. SERVER-SIDE ONLY.
//
// Ladder position: runs FIRST among the paid/free-web rungs, AHEAD of Go-UPC (free before paid -
// owner order 2026-07-12 free-rungs plan). GTIN-gated at buildLadderRungs, same as Go-UPC.
//
// This rung uses UPCitemdb's KEYLESS TRIAL tier (100 combined requests/day per IP, verified against
// devs.upcitemdb.com's rate-limit docs - see the task report for exact quotes). It NEVER touches the
// paid daily AI-lookup cap counter and keeps its OWN local daily counter (hard-capped at 90/day, a
// buffer under the provider's 100/day) - LESSONS_LEARNED L12: never charge the same request on two
// spend paths.
//
// Resolver Trust Rules: a UPCitemdb hit is ALWAYS a SUGGESTION, never a verified auto-count on its
// own. confidence is capped at 0.7 and exactCodeEvidenceVerifiedByApp is always false here - only
// the app's own EvidenceVerifier/store gate can promote a code to verified, and a single free-DB
// self-report is deliberately excluded from that path (wrong identity is FAILURE; Unknown is
// ACCEPTABLE).
//
// Everything is injected (client, usage gate, clock) so the rung is fully unit-testable with mocks
// and never touches the network, the filesystem, or process.env directly.

export type UpcItemDbRungResult = {
  path: "upcitemdb_hit" | "upcitemdb_miss" | "upcitemdb_unavailable";
  decision?: DecodeDecision;
  results?: AiLookupResult[];
  reason: string;
};

export interface UpcItemDbRungDeps {
  client: (code: string) => Promise<UpcItemDbOutcome>;
  usage: UpcItemDbUsage;
  now?: () => Date;
}

/** Confidence cap for every UPCitemdb suggestion - a single free-DB source never exceeds this. */
const SUGGESTION_CONFIDENCE = 0.6;

function toResult(item: UpcItemDbItem, code: string): AiLookupResult {
  return {
    ...emptyResult(),
    productName: item.title,
    brand: item.brand,
    category: item.category,
    primaryBarcode: code,
    upc: item.upc || "",
    ean: item.ean || "",
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
 * The UPCitemdb rung. Returns an explicit `reason` on EVERY branch (never silent).
 *
 * Order: GTIN gate (defense in depth; buildLadderRungs also gates this) -> local daily-cap gate ->
 * client call -> outcome mapping (hit -> suggestion; miss/quota/bad_format/transient -> unsettled).
 */
export async function upcItemDbRung(code: string, deps: UpcItemDbRungDeps): Promise<UpcItemDbRungResult> {
  // GTIN gate: non-GTIN input (wrong shape or bad check digit) is not a UPCitemdb lookup. Client
  // never called. (buildLadderRungs also gates this rung's existence in the ladder array; this is
  // defense in depth so the rung is safe to call directly too, e.g. from tests or future callers.)
  if (!isGtinShaped(code) || !isValidCheckDigit(code)) {
    return { path: "upcitemdb_miss", reason: "not a GTIN / failed check digit" };
  }

  // Local daily-cap gate: hard-stop BEFORE any request, well under UPCitemdb's 100/day trial limit.
  const spend = await deps.usage.canSpend();
  if (!spend.allowed) {
    return { path: "upcitemdb_unavailable", reason: spend.reason ?? "upcitemdb: local daily limit reached" };
  }

  const outcome = await deps.client(code);

  switch (outcome.kind) {
    case "hit": {
      await deps.usage.record();
      return {
        path: "upcitemdb_hit",
        decision: suggestionDecision("UPCitemdb match (free tier, unverified) -> Needs Review suggestion"),
        results: [toResult(outcome.item, code)],
        reason: "UPCitemdb hit -> Needs Review suggestion",
      };
    }

    case "miss":
      // Genuine not-in-DB: no local counter charge on a miss (mirrors Go-UPC's negative-cache spirit;
      // a miss is free information, not a billed lookup against the 100/day trial cap in practice, but
      // conservatively we still don't charge it so genuine misses never starve real lookups).
      return { path: "upcitemdb_miss", reason: "upcitemdb: no match" };

    case "quota":
      return { path: "upcitemdb_unavailable", reason: "upcitemdb: provider quota exhausted" };

    case "bad_format":
      return { path: "upcitemdb_unavailable", reason: "upcitemdb: provider rejected code format" };

    case "transient":
      return { path: "upcitemdb_unavailable", reason: `upcitemdb: transient error (${outcome.detail})` };
  }
}
