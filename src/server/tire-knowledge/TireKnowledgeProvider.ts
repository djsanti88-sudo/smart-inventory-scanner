import "server-only";
import type { AiLookupResult, DecodeDecision, EvidenceResult } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { lookupByExactBarcode, lookupByExactBarcodeLocal, lookupByExactPartNumber, type TireKnowledgeRow } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { isTrustedLocalDemoTireRow } from "@/server/tire-knowledge/localDemoTrust.mjs";
import { prettifyBrand, prettifyProductName } from "@/services/format/productDisplay";
import { basePartNumberKey } from "@/services/catalog/tirePartNumber";
import { normalizeTrustedCorpusTireSize } from "@/services/tire/tireSizeNormalizer";

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
  canonicalProductUid?: string;
}

// verified_2src is the strongest tier (independent two-source). verified_1src_strong is strong single
// source. Both clear the store's >=0.8 gate; nothing weaker reaches this code (the generator only ingests
// these two tiers), so a low-trust row can never produce a corpus auto-count.
const CONF: Record<string, number> = { verified_2src: 0.97, verified_1src_strong: 0.92 };

// BUG FIX (PN-resolved suggestion's barcode never carried through, owner-reported live on preview):
// the generator's REAL output convention for barcode_type is "upc"/"ean"/"gtin14" - 78,201 of 78,223
// rows use it. Only 22 legacy rows use "upc_a"/"ean_13"/"gtin_14". The switch below previously only
// recognized the legacy convention, so the row's barcode silently landed in NO result field for
// almost every corpus row. Normalize both conventions here (one seam) and default any other
// GTIN-shaped barcode_type value into the gtin field so a future generator convention still carries
// through instead of silently dropping again.
function barcodeField(row: TireKnowledgeRow): { upc: string; ean: string; gtin: string } {
  const barcode = row.barcode || "";
  if (!barcode) return { upc: "", ean: "", gtin: "" };
  switch (row.barcode_type) {
    case "upc":
    case "upc_a":
      return { upc: barcode, ean: "", gtin: "" };
    case "ean":
    case "ean_13":
      return { upc: "", ean: barcode, gtin: "" };
    case "gtin14":
    case "gtin_14":
      return { upc: "", ean: "", gtin: barcode };
    default:
      // Unrecognized/future barcode_type value: still carry the barcode (into gtin, the most
      // general identifier field) rather than dropping it silently.
      return { upc: "", ean: "", gtin: barcode };
  }
}

function toResult(row: TireKnowledgeRow, includeTrustedModel = false): AiLookupResult {
  // The trusted corpus sometimes stores a compact metric size (e.g. "2856020").  Normalize only
  // the display/result seam with the shared, range-guarded parser so the downstream countable-tire
  // identity check sees the same canonical size without changing corpus identity or trust decisions.
  const size = normalizeTrustedCorpusTireSize({
    size: row.size,
    rawSizeText: row.raw_size_text,
    model: row.model,
  }) ?? row.size;
  const specs = [size, [row.load_index, row.speed_rating].filter(Boolean).join("")].filter(Boolean).join(" ").trim();
  // DISPLAY-ONLY prettify: the corpus stores model slugs ("wrangler_workhorse_at") and lowercase
  // brands. Prettify here (new decode result construction), never rewrite the stored corpus row.
  const brand = prettifyBrand(row.brand);
  const modelDisplay = row.model_display?.trim();
  const model = modelDisplay || prettifyProductName(row.model);
  // Structured model is source data, never the display prettifier. The local corpus audit confirms
  // a raw-model fallback for rows without model_display is still byte-faithful to the manifest.
  const trustedStructuredModel = modelDisplay || row.model.trim();
  const name = [brand, model, specs].filter(Boolean).join(" ").trim();
  const { upc, ean, gtin } = barcodeField(row);
  return {
    ...emptyResult(),
    productName: name,
    brand,
    category: "Tire",
    specsShort: specs,
    specsFull: row.raw_size_text || specs,
    primarySku: row.manufacturer_part_number || "",
    // ALWAYS carry the corpus row's barcode into primaryBarcode when present, regardless of which
    // barcode_type convention the row uses - this is the field the client actually surfaces.
    primaryBarcode: row.barcode || "",
    upc,
    ean,
    gtin,
    confidence: CONF[row.confidence] ?? 0.92,
    // NOT a customer-facing source URL: the corpus carries no external source URLs into the runtime result,
    // so a customer decode response can never leak the global corpus's sources.
    sourceUrls: [],
    verifiedFacts: [`Trusted tire knowledge base: exact ${row.barcode_type || "barcode"} ${row.barcode}`],
    ...(includeTrustedModel && trustedStructuredModel ? { trustedStructuredModel } : {}),
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
  const result = toResult(row, true);
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

/** Local-demo corpus resolution deliberately accepts only the conservative SQLite evidence tier. */
export async function resolveExactBarcodeLocal(code: string): Promise<CorpusDecodeResult | null> {
  const row = await lookupByExactBarcodeLocal(code);
  if (!row || !isTrustedLocalDemoTireRow(row)) return null;
  const result = toResult(row, true);
  const decision: DecodeDecision = {
    status: "verified", confidence: CONF[row.confidence] ?? 0.92,
    reason: "Verified from the trusted tire knowledge base (exact barcode). No AI lookup needed.",
    evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "single_provider", confidence: CONF[row.confidence] ?? 0.92, reason: "Trusted corpus exact barcode.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    corroborationPath: "corpus_exact_barcode",
  };
  return { decision, results: [result], evidences: [verifiedEvidence(row.barcode)], providerNames: ["local-tire-corpus"], path: "corpus_exact_barcode", canonicalProductUid: row.canonical_product_uid };
}

// RC4 (owner-ratified, pilot PN recall): "if only the distributor affix differs and the digits are
// identical, approve" - a part-number identity match is high-trust. 0.85 when the scanned PN matches
// the corpus's manufacturer_part_number exactly (modulo space/hyphen normalization only); 0.8 when
// only the affix-stripped numeric core matched (a distributor prefix/suffix was removed to get
// there). Both tiers clear the >=0.8 auto-apply-suggestion gate elsewhere, but NEITHER ever reaches
// "verified" here - a PN match has no barcode evidence, so it stays a suggestion the human/UI can
// approve or decline on the counted row.
const PLAIN_PN_CONFIDENCE = 0.85;
const AFFIX_CORE_PN_CONFIDENCE = 0.8;

/**
 * EXACT trusted manufacturer-part-number resolution. Returns a SUGGESTED decode (deterministic identity,
 * routed to Needs Review / suggestion-row confirmation) - part numbers are not globally unique like
 * barcodes, so this NEVER returns "verified" and NEVER marks exactCodeEvidenceVerifiedByApp true. No AI,
 * no page fetch.
 */
export async function resolveExactPartNumber(partNumber: string): Promise<CorpusDecodeResult | null> {
  const row = await lookupByExactPartNumber(partNumber);
  if (!row) return null;
  const result = toResult(row);

  // Determine which tier applies by comparing the scanned PN's plain normalized key against the
  // corpus row's own normalized key. If they match, the raw key was the hit (no affix stripped). If
  // they differ, lookupByExactPartNumber only could have hit via the affix-core variant.
  const scannedPlainKey = basePartNumberKey(partNumber);
  const corpusPlainKey = basePartNumberKey(row.manufacturer_part_number);
  const isAffixCoreHit = scannedPlainKey !== corpusPlainKey;

  const confidence = isAffixCoreHit ? AFFIX_CORE_PN_CONFIDENCE : PLAIN_PN_CONFIDENCE;
  const reason = isAffixCoreHit
    ? "Matched by part number in the tire knowledge base (distributor prefix stripped). Confirm before counting (part numbers are not unique like barcodes)."
    : "Matched by part number in the tire knowledge base. Confirm before counting (part numbers are not unique like barcodes).";

  const decision: DecodeDecision = {
    status: "suggested",
    confidence,
    reason,
    evidenceStrength: "fetched_source",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence, reason: "Trusted corpus exact part number.", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
  };
  return { decision, results: [result], evidences: [verifiedEvidence(row.barcode)], providerNames: ["tire-corpus"], path: "corpus_exact_part_number" };
}
