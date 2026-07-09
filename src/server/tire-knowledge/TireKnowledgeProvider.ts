import "server-only";
import type { AiLookupResult, DecodeDecision, EvidenceResult } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { lookupByExactBarcode, lookupByExactPartNumber, type TireKnowledgeRow } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { prettifyBrand, prettifyProductName } from "@/services/format/productDisplay";

// SERVER-ONLY deterministic tire-knowledge provider. It turns an EXACT trusted-corpus hit into a decode
// result WITHOUT any AI call or page fetch. It runs in the /api/ai-lookup route BEFORE the AI providers and
// AFTER the human-confirmed business catalog/flywheel. A MISS returns null so the existing AI/page-fetch/
// Needs-Review path runs unchanged. The corpus is GROUNDING, not blind trust: the same downstream store
// auto-count gate (firewall + tire specs + brand-prefix conflict + >=0.8) still applies, so a non-tire or a
// near-match can never auto-count this way. EXACT match only - never fuzzy, never near-match.

export interface CorpusDecodeResult {
  decision: DecodeDecision;
  results: AiLookupResult[];
  evidences: EvidenceResult[];
  providerNames: string[];
  path: "corpus_exact_barcode" | "corpus_exact_part_number";
}

// verified_2src is the strongest tier (independent two-source). verified_1src_strong is strong single
// source. Both clear the store's >=0.8 gate; nothing weaker reaches this code (the generator only ingests
// these two tiers), so a low-trust row can never produce a corpus auto-count.
const CONF: Record<string, number> = { verified_2src: 0.97, verified_1src_strong: 0.92 };

function toResult(row: TireKnowledgeRow): AiLookupResult {
  const specs = [row.size, [row.load_index, row.speed_rating].filter(Boolean).join("")].filter(Boolean).join(" ").trim();
  // DISPLAY-ONLY prettify: the corpus stores model slugs ("wrangler_workhorse_at") and lowercase
  // brands. Prettify here (new decode result construction), never rewrite the stored corpus row.
  const brand = prettifyBrand(row.brand);
  const model = prettifyProductName(row.model);
  const name = [brand, model, specs].filter(Boolean).join(" ").trim();
  return {
    ...emptyResult(),
    productName: name,
    brand,
    category: "Tire",
    specsShort: specs,
    specsFull: row.raw_size_text || specs,
    primarySku: row.manufacturer_part_number || "",
    primaryBarcode: row.barcode,
    upc: row.barcode_type === "upc_a" ? row.barcode : "",
    ean: row.barcode_type === "ean_13" ? row.barcode : "",
    gtin: row.barcode_type === "gtin_14" ? row.barcode : "",
    confidence: CONF[row.confidence] ?? 0.92,
    // NOT a customer-facing source URL: the corpus carries no external source URLs into the runtime result,
    // so a customer decode response can never leak the global corpus's sources.
    sourceUrls: [],
    verifiedFacts: [`Trusted tire knowledge base: exact ${row.barcode_type || "barcode"} ${row.barcode}`],
  };
}

function verifiedEvidence(code: string): EvidenceResult {
  // The corpus IS the app's own independently-verified exact-code source (check-digit validated + trusted
  // tier at generation). It is treated as strong app-verified evidence; the model's self-claim is irrelevant.
  return { verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["tire_knowledge_corpus"], reason: "Exact code found in the trusted tire knowledge base." };
}

/**
 * EXACT trusted-barcode resolution. Returns a VERIFIED decode (auto-count candidate, subject to the
 * downstream store gate) or null on a miss. No AI, no page fetch.
 */
export async function resolveExactBarcode(code: string): Promise<CorpusDecodeResult | null> {
  const row = await lookupByExactBarcode(code);
  if (!row) return null;
  const result = toResult(row);
  const confidence = result.confidence;
  const decision: DecodeDecision = {
    status: "verified",
    confidence,
    reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
    evidenceStrength: "fetched_source",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "single_provider", confidence, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    corroborationPath: "corpus_exact_barcode",
  };
  return { decision, results: [result], evidences: [verifiedEvidence(row.barcode)], providerNames: ["tire-corpus"], path: "corpus_exact_barcode" };
}

/**
 * EXACT trusted manufacturer-part-number resolution. Returns a SUGGESTED decode (deterministic identity,
 * routed to Needs Review for human confirmation) by default - part numbers are not globally unique like
 * barcodes, so auto-counting them silently is unsafe (Phase 4: "if policy is unclear, route to Needs
 * Review"). No AI, no page fetch.
 */
export async function resolveExactPartNumber(partNumber: string): Promise<CorpusDecodeResult | null> {
  const row = await lookupByExactPartNumber(partNumber);
  if (!row) return null;
  const result = toResult(row);
  const decision: DecodeDecision = {
    status: "suggested",
    confidence: 0.6,
    reason: "Matched a part number in the trusted tire knowledge base. Confirm before counting (part numbers are not unique like barcodes).",
    evidenceStrength: "fetched_source",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: 0.6, reason: "Trusted corpus exact part number.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
  };
  return { decision, results: [result], evidences: [verifiedEvidence(row.barcode)], providerNames: ["tire-corpus"], path: "corpus_exact_part_number" };
}
