// GS1 company-prefix index for the anti-hallucination firewall. MANY-TO-MANY and STATISTICAL, not
// official GS1 truth: one prefix can carry several candidate brand/manufacturer/OEM names (with
// confidence weights), and one owner can hold many prefixes (countries, subsidiaries, acquisitions,
// private-label, regional/pack-size variants, legacy assignments, OEM). The firewall treats this as a
// weighted hint + conflict signal, NEVER as identity truth (see prefixFirewall.ts).
//
// Sources are merged longest-prefix-first: derived_catalog (generated from our 4M DB) over curated_seed.
// Treat both as evidence, not authority. A future official GS1 / "Verified by GS1" source would rank above.

export type PrefixSource = "curated_seed" | "derived_catalog" | "official_gs1_future";

export interface PrefixCandidate {
  name: string;
  kind: "brand" | "manufacturer" | "oem";
  productCount: number; // how many catalog rows support this candidate (0 for pure seed)
  confidence: number; // 0..1 share of this candidate within the prefix
  categories?: string[];
}

export interface PrefixEntry {
  prefix: string;
  candidates: PrefixCandidate[];
  dominant: PrefixCandidate | null; // top candidate, if one clearly leads
  productCount: number;
  categoryDist: Record<string, number>;
  countryHints: string[];
  confidence: number; // 0..1 dominance of the top candidate (firewall veto weight)
  ambiguity: number; // 0..1 (1 = shared/ambiguous prefix -> weaker veto)
  source: PrefixSource;
  notes?: string; // private-label / OEM risk
}

// --- Curated seed (small, hand-checked; NOT GS1-authoritative) -------------------------------------
// Keys are the GS1 company prefix as it appears at the START of the UPC-A digit string (number-system
// digit included), e.g. United Solutions UPCs begin 051596..., King of Fans begin 792145....
const SEED: Record<string, PrefixEntry> = {
  "0051596": {
    prefix: "0051596",
    candidates: [
      { name: "United Solutions", kind: "manufacturer", productCount: 0, confidence: 0.9, categories: ["housewares", "bucket", "storage"] },
    ],
    dominant: { name: "United Solutions", kind: "manufacturer", productCount: 0, confidence: 0.9, categories: ["housewares", "bucket", "storage"] },
    productCount: 0,
    categoryDist: { housewares: 1, bucket: 1, storage: 1 },
    countryHints: ["US"],
    confidence: 0.9,
    ambiguity: 0.1,
    source: "curated_seed",
    notes: "Manufactures private-label housewares (e.g., Home Depot 'Homer Bucket'). Retail brand on the package may legitimately differ from this manufacturer - do NOT treat a retail-brand difference as a conflict.",
  },
  "0792145": {
    prefix: "0792145",
    candidates: [
      { name: "King of Fans", kind: "manufacturer", productCount: 0, confidence: 0.9, categories: ["ceiling fan", "lighting"] },
      { name: "Hampton Bay", kind: "brand", productCount: 0, confidence: 0.85, categories: ["ceiling fan"] },
    ],
    dominant: { name: "King of Fans", kind: "manufacturer", productCount: 0, confidence: 0.9, categories: ["ceiling fan", "lighting"] },
    productCount: 0,
    categoryDist: { "ceiling fan": 1, lighting: 1 },
    countryHints: ["US"],
    confidence: 0.9,
    ambiguity: 0.15,
    source: "curated_seed",
    notes: "OEM that makes Home Depot's 'Hampton Bay' ceiling fans (e.g., AL383LED-BN). Many-to-one brand relationship.",
  },
};

// Derived (from our 4M DB / corpus) is merged in at runtime from the generated JSON. Empty {} until
// `scripts/build-prefix-index.mjs` populates it. Kept separate so the seed stays hand-auditable and the
// derived map can be regenerated independently. Loaded at module init below via setDerivedPrefixes.
import derivedPrefixMap from "@/services/catalog/derivedPrefixMap.json";
const DERIVED: Record<string, PrefixEntry> = {};

/** Replace the derived prefix map (called by the loader once the generated file is available). */
export function setDerivedPrefixes(map: Record<string, PrefixEntry>): void {
  for (const k of Object.keys(DERIVED)) delete DERIVED[k];
  Object.assign(DERIVED, map);
}

/**
 * Look up the prefix entry for a scanned code. Matches the LONGEST known prefix the digits start with,
 * preferring derived_catalog (more data) over curated_seed. Returns null for unknown prefixes so
 * non-cataloged product types are never affected.
 */
// Normalize any scanned code to GTIN-13 so a UPC-12 scan and its GTIN-13 form share one prefix space
// (OFF/derived keys are GTIN-13; the curated seed is stored the same way, e.g. 0051596 / 0792145).
function gtin13(code: string | undefined): string {
  const d = (code || "").replace(/\D/g, "");
  if (d.length === 12) return "0" + d; // UPC-A -> GTIN-13
  if (d.length === 14) return d.slice(1); // drop the GTIN-14 indicator digit
  return d; // already 13 (or 8 / other)
}

export function lookupPrefix(code: string | undefined): PrefixEntry | null {
  const digits = gtin13(code);
  if (digits.length < 7) return null;
  let best: PrefixEntry | null = null;
  const consider = (map: Record<string, PrefixEntry>) => {
    for (const key of Object.keys(map)) {
      if (!digits.startsWith(key)) continue;
      if (!best || key.length > best.prefix.length) best = map[key];
    }
  };
  consider(SEED); // curated seed is AUTHORITATIVE for its prefixes (wins ties; never shadowed by derived)
  consider(DERIVED); // derived refines only with a strictly-longer match
  return best;
}

// The generated derived map is stored COMPACT (array per prefix) to keep the file small + fast to load:
//   [confidence, ambiguity, productCount, [[name,count]...], [[category,count]...]]
// Expand it into full PrefixEntry objects at module init. (An empty {} stays empty.)
type CompactEntry = [number, number, number, [string, number][], [string, number][]];
function expandCompact(map: Record<string, unknown>): Record<string, PrefixEntry> {
  const out: Record<string, PrefixEntry> = {};
  for (const [prefix, v] of Object.entries(map)) {
    if (!Array.isArray(v)) continue;
    const [cf, am, pc, cands, cats] = v as CompactEntry;
    const categories = (cats ?? []).map(([k]) => k);
    const candidates: PrefixCandidate[] = (cands ?? []).map(([name, count]) => ({
      name, kind: "manufacturer", productCount: count, confidence: pc ? Number((count / pc).toFixed(3)) : 0, categories,
    }));
    const categoryDist: Record<string, number> = {};
    for (const [k, n] of cats ?? []) categoryDist[k] = n;
    out[prefix] = {
      prefix, candidates, dominant: cf >= 0.5 ? (candidates[0] ?? null) : null,
      productCount: pc, categoryDist, countryHints: [], confidence: cf, ambiguity: am, source: "derived_catalog",
    };
  }
  return out;
}
setDerivedPrefixes(expandCompact(derivedPrefixMap as Record<string, unknown>));
