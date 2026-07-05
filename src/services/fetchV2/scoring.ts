// Source scoring + per-mode verification decision for Fetch V2.
// Quality comes from the production source-trust tiers; association level caps it:
// a page whose code-to-product tie is weak can never be more than weak evidence.
import { classifySource } from "@/services/catalog/sourceTrust";
import { identityRelation } from "./siblingGuard";
import type { ExtractedProduct } from "./pageEvidence/extract";
import type { AssociationProof } from "./pageEvidence/association";
import type { FetchV2Identifier, FetchV2Mode, FetchV2Outcome } from "./types";

export interface SourceFinding {
  url: string;
  association: AssociationProof;
  product: ExtractedProduct | null;
  junkRejected: boolean;
  junkReasons: string[];
  quality: "strong" | "medium" | "weak" | "rejected";
  score: number; // 0-100
}

const QUALITY_SCORE = { strong: 85, medium: 55, weak: 30, rejected: 0 } as const;

export function scoreSource(url: string, association: AssociationProof, junkRejected: boolean): { quality: SourceFinding["quality"]; score: number } {
  if (junkRejected) return { quality: "rejected", score: 0 };
  if (association.level === "none") return { quality: "weak", score: 10 };
  const tier = classifySource(url);
  let quality: SourceFinding["quality"] =
    tier === "authoritative" || tier === "strong_commercial" ? "strong" : tier === "supporting" ? "medium" : "weak";
  if (association.level === "weak") quality = "weak"; // weak tie caps the source
  let score: number = QUALITY_SCORE[quality];
  if (quality === "strong" && tier === "authoritative") score = 95;
  return { quality, score };
}

export interface OutcomeDecision {
  outcome: FetchV2Outcome;
  confidence: number;
  winner: SourceFinding | null;
  conflicts: string[];
  rulesFired: string[];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function decideOutcome(identifier: FetchV2Identifier, findings: SourceFinding[], mode: FetchV2Mode): OutcomeDecision {
  const rules: string[] = [];
  if (findings.length === 0) return { outcome: "unknown", confidence: 0, winner: null, conflicts: [], rulesFired: ["no findings"] };

  const valid = findings.filter((f) => !f.junkRejected);
  if (valid.length === 0) {
    return { outcome: "rejected", confidence: 0, winner: null, conflicts: findings.flatMap((f) => f.junkReasons), rulesFired: ["all sources junk-rejected"] };
  }

  const byScore = [...valid].sort((a, b) => b.score - a.score);
  const winner = byScore[0];
  const identified = valid.filter((f) => (f.product?.name ?? "").trim().length > 0);
  // Verification demands BOTH a proven code tie AND a non-empty identity - a matching gtin on a
  // page whose name was junk-stripped proves the code exists, not what the product is.
  const strongAssoc = identified.filter((f) => f.association.level === "strong");

  // Conflict analysis runs ONLY across sources that actually tied the code to a product
  // (strong association). A weak page with no code tie must never veto a proven one
  // (live bug 2026-07-04: a digit-collision video-game page demoted a correct verify).
  const ident = (f: SourceFinding) => ({ name: f.product!.name, brand: f.product!.brand });
  for (let i = 0; i < strongAssoc.length; i++) {
    for (let j = i + 1; j < strongAssoc.length; j++) {
      const rel = identityRelation(ident(strongAssoc[i]), ident(strongAssoc[j]));
      if (rel === "sibling") {
        const reason = `sibling variants both claim this code: "${strongAssoc[i].product!.name}" vs "${strongAssoc[j].product!.name}"`;
        rules.push("sibling guard: " + reason);
        return { outcome: "needs_review", confidence: 0.4, winner, conflicts: [reason], rulesFired: rules };
      }
      if (rel === "unrelated") {
        const reason = `recycled/conflicting code: unrelated products both claim it: "${strongAssoc[i].product!.name}" vs "${strongAssoc[j].product!.name}"`;
        rules.push("conflict guard: " + reason);
        return { outcome: "needs_review", confidence: 0.4, winner, conflicts: [reason], rulesFired: rules };
      }
    }
  }

  // Verification is reserved for public barcodes; everything else tops out at suggested.
  if (identifier.isPublicBarcode && identifier.checkDigitValid !== false) {
    const strongSource = strongAssoc.find((f) => f.quality === "strong");
    const mediumPlus = strongAssoc.filter((f) => f.quality === "strong" || f.quality === "medium");
    // Corroboration = two code-tied sources on DIFFERENT hosts whose identities AGREE
    // (host distinctness alone is not agreement - that hole was masked by the old guard).
    const corroborated = mediumPlus.some((a, i) =>
      mediumPlus.some((b, j) => j > i && hostOf(a.url) !== hostOf(b.url) && identityRelation(ident(a), ident(b)) === "agree"),
    );

    if (mode === "strict") {
      if (strongSource && corroborated) {
        rules.push("strict: strong source + independent agreeing corroboration");
        return { outcome: "verified", confidence: 0.95, winner: strongSource, conflicts: [], rulesFired: rules };
      }
    } else {
      if (strongSource) {
        rules.push(`${mode}: single strong source with proven code-to-product association`);
        return { outcome: "verified", confidence: 0.9, winner: strongSource, conflicts: [], rulesFired: rules };
      }
      if (mode === "balanced" && corroborated) {
        rules.push("balanced: two independent medium sources agree");
        return { outcome: "verified", confidence: 0.85, winner: mediumPlus[0], conflicts: [], rulesFired: rules };
      }
    }
  } else if (!identifier.isPublicBarcode) {
    rules.push("non-public identifier: verification not allowed");
  } else {
    rules.push("check digit invalid: verification not allowed");
  }

  // --- Search-index (snippet) consensus: owner-approved verify tier 2026-07-04 -----------------
  // Merchant feeds carry the barcode in result titles/snippets even when pages do not. Findings
  // tagged "search_snippets" are exact-code-carrying results. Rules: any unrelated identity among
  // them = conflict (recycled code) -> needs_review; 3+ DISTINCT hosts all agreeing -> verified.
  const snips = valid.filter((f) => f.association.matchedField === "search_snippets" && (f.product?.name ?? "").trim());
  if (snips.length >= 2) {
    for (let i = 0; i < snips.length; i++) {
      for (let j = i + 1; j < snips.length; j++) {
        if (identityRelation(ident(snips[i]), ident(snips[j])) === "unrelated") {
          const reason = `code-carrying search results disagree: "${snips[i].product!.name}" vs "${snips[j].product!.name}"`;
          rules.push("snippet conflict guard: " + reason);
          return { outcome: "needs_review", confidence: 0.4, winner, conflicts: [reason], rulesFired: rules };
        }
      }
    }
  }
  if (identifier.isPublicBarcode && identifier.checkDigitValid !== false && snips.length > 0) {
    const byHost = new Map<string, SourceFinding>();
    for (const s of snips) if (!byHost.has(hostOf(s.url))) byHost.set(hostOf(s.url), s);
    const distinct = [...byHost.values()];
    const allAgree = distinct.every((a, i) => distinct.every((b, j) => j <= i || identityRelation(ident(a), ident(b)) !== "unrelated" && identityRelation(ident(a), ident(b)) !== "sibling"));
    if (distinct.length >= 3 && allAgree) {
      rules.push(`snippet consensus: ${distinct.length} independent code-carrying results agree`);
      const nameTokensOf = (f: SourceFinding) => (f.product?.name ?? "").split(/\s+/).filter(Boolean).length;
      const best = [...distinct].sort((a, b) => nameTokensOf(b) - nameTokensOf(a))[0];
      return { outcome: "verified", confidence: 0.85, winner: best, conflicts: [], rulesFired: rules };
    }
    if (distinct.length >= 2 && allAgree) rules.push("snippet consensus: 2 hosts agree (suggestion-grade)");
  }

  if (identified.length > 0) {
    rules.push("usable identity without verification-grade proof");
    // Winner = the most informative candidate: proven code tie first, then source score, then the
    // richer name (live bug: first-inserted "CAMPBELL" beat the full soup name).
    const nameTokens = (f: SourceFinding) => (f.product?.name ?? "").split(/\s+/).filter(Boolean).length;
    const best = [...identified].sort(
      (a, b) =>
        (b.association.level === "strong" ? 1 : 0) - (a.association.level === "strong" ? 1 : 0) ||
        b.score - a.score ||
        nameTokens(b) - nameTokens(a),
    )[0];
    return { outcome: "suggested", confidence: strongAssoc.length > 0 ? 0.6 : 0.45, winner: best, conflicts: [], rulesFired: rules };
  }

  rules.push("sources fetched but no identity/evidence found");
  return { outcome: "unknown", confidence: 0, winner: null, conflicts: [], rulesFired: rules };
}
