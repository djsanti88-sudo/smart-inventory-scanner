import type { CodeType } from "@/types";

// Self-learning flywheel: a GENUINELY verified decode teaches the prefix map so future scans (and the
// anti-hallucination firewall) get smarter over time, for $0. STRICT gate (owner rule): only learn from
// a decode that is verified + APP-verified exact code + confidence >= 0.90 + a PUBLIC barcode + a real
// brand. Learned prefixes are statistical evidence, never identity truth - they follow the same runtime
// rules as derived prefixes (override-able by exact-code evidence; private-label mismatch is not a veto).

const PUBLIC_BARCODE_TYPES: CodeType[] = ["upc_a", "ean_13", "gtin_14"];
const MIN_CONFIDENCE = Number(process.env.PREFIX_LEARN_MIN_CONFIDENCE || 0.9);

export interface LearnableDecode {
  status: string;
  confidence: number;
  exactCodeEvidenceVerifiedByApp: boolean;
  codeType: CodeType;
  brand?: string;
}

/** True only when a decode is trustworthy enough to teach the prefix map (verified + >=0.90 + public + brand). */
export function isLearnablePrefix(d: LearnableDecode): boolean {
  return (
    d.status === "verified" &&
    d.exactCodeEvidenceVerifiedByApp === true &&
    (d.confidence ?? 0) >= MIN_CONFIDENCE &&
    PUBLIC_BARCODE_TYPES.includes(d.codeType) &&
    !!(d.brand && d.brand.trim())
  );
}
