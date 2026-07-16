// src/services/upc/barcodeTrust.ts
// Barcode trust gate (spec v3, AM-1..AM-11). Pure: no React, no next/*, no server imports.
//
// Two independent properties, never conflated:
//   1. Well-formed (shape + GS1 check digit) - cheap, local, trivially satisfiable by any invented number.
//   2. Verified identity - established ONLY by a re-checkable ground-truth artifact (AM-3):
//      a physical scan, the app's own EvidenceVerifier result, or the grandfathered corpus.
//
// AM-11 (live ground truth 2026-07-15): Sailun/Blackhawk's REAL published UPCs embed the part number
// (6959655468007 = 695965 + last-6-of-PN + check). "Payload embeds the PN" is a legitimate industry
// scheme AND the common fabrication pattern - so pnDerived is an ADVISORY annotation that never
// changes a verdict in either direction. Evidence distinguishes real from phantom; structure cannot.
import { isGtinShaped, isValidCheckDigit, canonicalGtin } from "./gtin";
import type { EvidenceStrength } from "../../types";

export type BarcodeVerdict = "rejected" | "suggested" | "verified";
export type PnDerived = "pn_derived" | "clean" | "cannot_assess";

export type GroundTruth =
  | { kind: "physical_scan" }
  | { kind: "evidence_verified"; strength: EvidenceStrength }
  | { kind: "corpus_trusted" };

export interface BarcodeGradeInput {
  barcode: string;
  partNumber?: string;
  /** Only re-checkable artifacts (AM-3). Callers must NEVER map a provider's self-report here. */
  groundTruth?: GroundTruth;
}

export interface BarcodeGrade {
  verdict: BarcodeVerdict;
  checkDigitValid: boolean;
  gtinShaped: boolean;
  placeholder: boolean;
  pnDerived: PnDerived;
  canonicalGtin: string | null;
  reason: string; // honest, human-readable, always set
}

/** The ONLY structural hard block (AM-11.4): enumerated junk with no legitimate counterexample. */
export const PLACEHOLDER_BARCODES: readonly string[] = [
  "123456789012",
  "0123456789012",
  "1234567890128",
  "01234567890128",
];

const PLACEHOLDER_CANONICALS = new Set(
  PLACEHOLDER_BARCODES.map((c) => canonicalGtin(c)).filter(Boolean) as string[],
);

export function isPlaceholderBarcode(code: string): boolean {
  const t = (code ?? "").trim();
  if (!t) return false;
  if (/^(\d)\1+$/.test(t)) return true; // all-same-digit (0000000000000, 9999999999999, 00000000, ...)
  if (PLACEHOLDER_BARCODES.includes(t)) return true;
  const canon = canonicalGtin(t);
  return canon !== null && PLACEHOLDER_CANONICALS.has(canon);
}

/**
 * ADVISORY annotation (AM-8 params, AM-11 demotion): does a contiguous run of >= 5 part-number
 * digits appear in the barcode payload (check digit excluded)? Compared against both the raw and
 * the canonical (zero-stripped) form. NEVER changes a verdict - shown as context in review UI only.
 */
export function pnDerivedAnnotation(barcode: string, partNumber?: string): PnDerived {
  const pnDigits = (partNumber ?? "").replace(/\D/g, "");
  if (pnDigits.length < 5) return "cannot_assess";
  const raw = (barcode ?? "").trim();
  const forms = new Set<string>();
  if (raw.length >= 2) forms.add(raw.slice(0, -1)); // payload without the check digit
  const canon = canonicalGtin(raw);
  if (canon) forms.add(canon.slice(0, -1));
  for (const body of forms) {
    for (let len = pnDigits.length; len >= 5; len--) {
      for (let i = 0; i + len <= pnDigits.length; i++) {
        if (body.includes(pnDigits.slice(i, i + len))) return "pn_derived";
      }
    }
  }
  return "clean";
}

const STRONG_EVIDENCE: readonly EvidenceStrength[] = ["grounding_chunk", "fetched_source"];

export function gradeBarcode(input: BarcodeGradeInput): BarcodeGrade {
  const raw = (input.barcode ?? "").trim();
  const gtinShaped = isGtinShaped(raw);
  const checkDigitValid = isValidCheckDigit(raw);
  const placeholder = isPlaceholderBarcode(raw);
  const canon = canonicalGtin(raw);
  const pnDerived = pnDerivedAnnotation(raw, input.partNumber);

  const base = { checkDigitValid, gtinShaped, placeholder, pnDerived, canonicalGtin: canon };

  // Structural rejection: misreads and enumerated junk. Ground truth never rescues these -
  // a "physical scan" of a bad-check-digit code IS the misread case.
  if (placeholder) {
    return { ...base, verdict: "rejected", reason: "Placeholder/dummy barcode (blocklist)" };
  }
  if (!gtinShaped) {
    return { ...base, verdict: "rejected", reason: "Not a GTIN-shaped barcode" };
  }
  if (!checkDigitValid) {
    return { ...base, verdict: "rejected", reason: "Invalid GS1 check digit (likely misread)" };
  }

  const gt = input.groundTruth;
  if (gt?.kind === "physical_scan") {
    return { ...base, verdict: "verified", reason: "Captured by a physical scan" };
  }
  if (gt?.kind === "corpus_trusted") {
    return { ...base, verdict: "verified", reason: "Grandfathered corpus barcode" };
  }
  if (gt?.kind === "evidence_verified" && STRONG_EVIDENCE.includes(gt.strength)) {
    return { ...base, verdict: "verified", reason: `App-verified in real evidence (${gt.strength})` };
  }
  if (gt?.kind === "evidence_verified") {
    return {
      ...base,
      verdict: "suggested",
      reason: `Evidence too weak to verify (${gt.strength}); needs a physical scan or stronger evidence`,
    };
  }
  return {
    ...base,
    verdict: "suggested",
    reason: "Well-formed but unverified; counts only after a physical scan or app-verified evidence",
  };
}
