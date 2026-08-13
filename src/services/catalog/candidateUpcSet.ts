import { normalizeBrand, tokenize } from "@/services/catalog/brandPrefixGeneral";

// Reverse known-UPC guard: build an AI-proposed product's known UPC SET from OUR OWN catalog/corpus
// (no live lookup, deterministic, fast). UPC SETS - never a single UPC - because one product family
// legitimately carries many UPCs (pack size, region, bundle, retailer/color/size variant, packaging
// update, old vs new). The firewall only treats a set EXCLUSION as a conflict when it is also
// category-incompatible (see prefixFirewall.ts), so multi-prefix/multi-UPC products are not false-rejected.

export interface UpcRecord {
  name?: string;
  brand?: string;
  model?: string;
  primarySku?: string;
  barcode?: string;
  primaryBarcode?: string;
  upc?: string;
  ean?: string;
  gtin?: string;
  normalizedBarcode?: string;
  aliases?: string[];
}

export interface CandidateProduct {
  brand?: string;
  manufacturer?: string;
  name?: string;
  model?: string;
  primarySku?: string;
}

function normSku(s: string | undefined): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function brandMatch(candidate: CandidateProduct, record: UpcRecord): boolean {
  const cands = [candidate.brand, candidate.manufacturer].map(normalizeBrand).filter(Boolean);
  const rb = normalizeBrand(record.brand);
  if (!rb || cands.length === 0) return false;
  for (const c of cands) {
    if (c === rb) return true;
    const c0 = c.split(" ")[0];
    const r0 = rb.split(" ")[0];
    if (c0 && rb.includes(c0)) return true;
    if (r0 && c.includes(r0)) return true;
  }
  return false;
}

function nameOverlap(candidate: CandidateProduct, record: UpcRecord): boolean {
  const a = new Set(tokenize(candidate.name));
  if (a.size === 0) return false;
  return tokenize(record.name).some((t) => a.has(t));
}

function modelMatch(candidate: CandidateProduct, record: UpcRecord): boolean {
  const cm = [normSku(candidate.model), normSku(candidate.primarySku)].filter(Boolean);
  const rm = [normSku(record.model), normSku(record.primarySku)].filter(Boolean);
  if (cm.length === 0 || rm.length === 0) return false;
  return cm.some((c) => c.length >= 4 && rm.includes(c));
}

function codesOf(record: UpcRecord): string[] {
  const raw = [
    record.barcode,
    record.primaryBarcode,
    record.upc,
    record.ean,
    record.gtin,
    record.normalizedBarcode,
    ...(record.aliases ?? []),
  ];
  return raw.map((c) => (c || "").replace(/\D/g, "")).filter(Boolean);
}

/**
 * Build the candidate's known UPC set from our own records. A record matches the candidate when the
 * brand matches AND (the product name overlaps OR a specific model/SKU matches). Returns deduped
 * digit-only codes; empty when nothing in our data matches (the guard then stays inert).
 */
export function candidateKnownUpcSet(candidate: CandidateProduct, records: UpcRecord[]): string[] {
  if (!candidate || (!candidate.brand && !candidate.manufacturer && !candidate.name && !candidate.model)) return [];
  const out = new Set<string>();
  for (const r of records) {
    if (!brandMatch(candidate, r)) continue;
    if (!nameOverlap(candidate, r) && !modelMatch(candidate, r)) continue;
    for (const c of codesOf(r)) out.add(c);
  }
  return [...out];
}

function normUpc(s: string): string {
  return (s || "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Shop-catalog reverse-UPC guard (CLIENT-SAFE - no prefix map): does the AI-proposed product already
 * exist in OUR OWN catalog/products under a DIFFERENT barcode than the one scanned? If so, flag it for a
 * platformOwner heads-up (likely a mis-scan, a duplicate, or a wrong code). Inert when the candidate is
 * not in our data. Uses UPC SETS (GTIN-equivalent), never a single code.
 */
export function shopReverseUpcConflict(
  candidate: CandidateProduct,
  scannedCode: string,
  records: UpcRecord[],
): { conflict: boolean; knownUpcs: string[] } {
  const knownUpcs = candidateKnownUpcSet(candidate, records);
  if (knownUpcs.length === 0) return { conflict: false, knownUpcs: [] };
  const scan = normUpc(scannedCode);
  const conflict = !knownUpcs.map(normUpc).includes(scan);
  return { conflict, knownUpcs };
}
