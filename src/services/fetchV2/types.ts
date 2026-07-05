// Fetch V2 result contract + the makeResult builder that ENFORCES count-first invariants:
// verification can NEVER decide whether a scan persists or increments quantity.
// classify/normalize import only TYPES from here, so these value imports cannot cycle at runtime.
import { classifyIdentifier } from "./classify";
import { normalizeVariants } from "./normalize";

export type FetchV2Outcome = "verified" | "suggested" | "needs_review" | "unknown" | "unsupported" | "rejected";
export type FetchV2Mode = "fast" | "balanced" | "strict";
export type FetchV2IdType =
  | "upc_a" | "ean_13" | "gtin_14"
  | "asin" | "fnsku_like" | "url" | "vendor_sku" | "tire_code" | "raw_text" | "unknown";

export interface FetchV2Identifier {
  type: FetchV2IdType;
  isPublicBarcode: boolean;
  checkDigitValid: boolean | null;
  gs1PrefixHint: string;
  notes: string[];
}

export interface NormalizedValues {
  primary: string;
  upcA: string;
  ean13: string;
  gtin14: string;
  withoutSeparators: string;
  /** every distinct searchable variant, primary first */
  all: string[];
}

export interface FetchV2CountBehavior {
  mustPersistScan: boolean;
  mustIncrementQuantity: boolean;
  groupingKey: string;
  productAssignmentAllowed: boolean;
}

export interface FetchV2Product {
  brand: string;
  name: string;
  model: string;
  partNumber: string;
  size: string;
  description: string;
  category: string;
  imageUrl: string;
}

export interface FetchV2Evidence {
  exactCodeFound: boolean;
  codeToProductProven: boolean;
  sourceQuality: "strong" | "medium" | "weak" | "rejected" | "none";
  sourceScore: number;
  identityScore: number;
  associationScore: number;
  finalConfidence: number;
  winningSourceUrl: string;
  winningSourceType: string;
  codeLocation: string;
  proofSummary: string;
}

export interface FetchV2Result {
  version: "fetch_v2";
  rawValue: string;
  normalizedValues: NormalizedValues;
  identifier: FetchV2Identifier;
  outcome: FetchV2Outcome;
  countBehavior: FetchV2CountBehavior;
  product: FetchV2Product;
  evidence: FetchV2Evidence;
  sourcesChecked: string[];
  conflicts: string[];
  performance: { durationMs: number; sourceCount: number; earlyStopped: boolean; cacheHit: boolean };
  debug: { mode: FetchV2Mode; rulesFired: string[]; notes: string[] };
}

const EMPTY_PRODUCT: FetchV2Product = { brand: "", name: "", model: "", partNumber: "", size: "", description: "", category: "", imageUrl: "" };
const EMPTY_EVIDENCE: FetchV2Evidence = {
  exactCodeFound: false, codeToProductProven: false, sourceQuality: "none", sourceScore: 0,
  identityScore: 0, associationScore: 0, finalConfidence: 0, winningSourceUrl: "",
  winningSourceType: "", codeLocation: "", proofSummary: "",
};

/**
 * Build a complete FetchV2Result, ENFORCING the count-first contract regardless of caller input:
 * every scan persists and increments (verification only ever controls product assignment), and
 * assignment is allowed ONLY for a verified outcome.
 */
export function makeResult(partial: Partial<FetchV2Result> & { rawValue: string }): FetchV2Result {
  const identifier = partial.identifier ?? classifyIdentifier(partial.rawValue);
  const normalizedValues = partial.normalizedValues ?? normalizeVariants(partial.rawValue, identifier.type);
  const outcome: FetchV2Outcome = partial.outcome ?? "unknown";
  return {
    version: "fetch_v2",
    rawValue: partial.rawValue,
    normalizedValues,
    identifier,
    outcome,
    countBehavior: {
      mustPersistScan: true, // NON-NEGOTIABLE: counting never depends on resolution
      mustIncrementQuantity: true,
      groupingKey: partial.countBehavior?.groupingKey || normalizedValues.primary || partial.rawValue.trim(),
      productAssignmentAllowed: outcome === "verified",
    },
    product: { ...EMPTY_PRODUCT, ...partial.product },
    evidence: { ...EMPTY_EVIDENCE, ...partial.evidence },
    sourcesChecked: partial.sourcesChecked ?? [],
    conflicts: partial.conflicts ?? [],
    performance: { durationMs: 0, sourceCount: 0, earlyStopped: false, cacheHit: false, ...partial.performance },
    debug: { mode: "balanced", rulesFired: [], notes: [], ...partial.debug },
  };
}
