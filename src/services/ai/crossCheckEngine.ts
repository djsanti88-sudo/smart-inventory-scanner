import type { AiLookupResult, CrossCheckResult } from "@/types";

// CrossCheckEngine: compares two provider decode results STRUCTURALLY (not by string equality).
// It looks at brand similarity, product-name token overlap, barcode agreement, and contradictions.
// It decides whether the providers agree, conflict, are weak, or only one responded.

function tokens(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

export function brandSimilarity(a: string, b: string): number {
  const na = tokens(a).join(" ");
  const nb = tokens(b).join(" ");
  if (!na && !nb) return 0;
  if (na === nb) return 1;
  return jaccard(tokens(a), tokens(b));
}

export function nameSimilarity(a: string, b: string): number {
  return jaccard(tokens(a), tokens(b));
}

function digitsOnly(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}

function firstBarcode(r: AiLookupResult): string {
  return r.primaryBarcode || r.gtin || r.upc || r.ean || "";
}

function present(r: AiLookupResult | null): r is AiLookupResult {
  return !!r && (r.productName.trim().length > 0 || r.brand.trim().length > 0);
}

export function crossCheck(a: AiLookupResult | null, b: AiLookupResult | null): CrossCheckResult {
  const pa = present(a);
  const pb = present(b);

  if (!pa && !pb) {
    return { decision: "weak", confidence: 0, reason: "No usable provider result.", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] };
  }
  if (pa !== pb) {
    return {
      decision: "single_provider",
      confidence: 0.4,
      reason: "Only one provider returned a result.",
      brandSimilarity: 0,
      nameSimilarity: 0,
      contradictions: [],
    };
  }

  // Both present.
  const ra = a as AiLookupResult;
  const rb = b as AiLookupResult;
  const brandSim = brandSimilarity(ra.brand, rb.brand);
  const nameSim = nameSimilarity(ra.productName, rb.productName);
  const contradictions: string[] = [];

  const barA = digitsOnly(firstBarcode(ra));
  const barB = digitsOnly(firstBarcode(rb));
  const barcodeMatch = barA.length > 0 && barB.length > 0 && barA === barB;
  if (barA && barB && barA !== barB) {
    contradictions.push(`barcode mismatch: ${barA} vs ${barB}`);
  }

  if (ra.brand.trim() && rb.brand.trim() && brandSim < 0.4) {
    contradictions.push(`brand mismatch: ${ra.brand} vs ${rb.brand}`);
  }

  if (contradictions.length > 0) {
    return {
      decision: "conflict",
      confidence: 0.2,
      reason: "Providers disagree on identity.",
      brandSimilarity: brandSim,
      nameSimilarity: nameSim,
      contradictions,
    };
  }

  const agree = barcodeMatch || (brandSim >= 0.7 && nameSim >= 0.3);
  if (agree) {
    return {
      decision: "agree",
      confidence: Math.min(1, 0.6 + 0.4 * Math.max(nameSim, barcodeMatch ? 1 : 0)),
      reason: barcodeMatch ? "Providers agree on the barcode and identity." : "Providers agree on brand and product name.",
      brandSimilarity: brandSim,
      nameSimilarity: nameSim,
      contradictions: [],
    };
  }

  return {
    decision: "weak",
    confidence: 0.3,
    reason: "Providers do not clearly agree and do not clearly conflict.",
    brandSimilarity: brandSim,
    nameSimilarity: nameSim,
    contradictions: [],
  };
}
