// GS1 company-prefix index for the anti-hallucination firewall. MANY-TO-MANY and STATISTICAL, not
// official GS1 truth: one prefix can carry several candidate brand/manufacturer/OEM names (with
// confidence weights), and one owner can hold many prefixes (countries, subsidiaries, acquisitions,
// private-label, regional/pack-size variants, legacy assignments, OEM). The firewall treats this as a
// weighted hint + conflict signal, NEVER as identity truth (see prefixFirewall.ts).
//
// Sources are merged longest-prefix-first: derived_catalog (generated from our 4M DB) over curated_seed.
// Treat both as evidence, not authority. A future official GS1 / "Verified by GS1" source would rank above.

export type PrefixSource = "curated_seed" | "derived_catalog" | "learned_flywheel" | "official_gs1_future";

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

// F5 bundle-surgery (wave 2, 2026-07-20): the DERIVED_CATALOG tier (2.3MB `derivedPrefixMap.json`,
// generated from our 4M-row retail/tire corpus) used to be statically imported and eagerly expanded
// HERE, which put the whole file on the /scan client bundle (this module is reachable from
// scanStore.ts via prefixFloor.ts). It now lives SERVER-ONLY in @/server/catalog/prefixIndexServer.ts
// (lookupPrefixFull / lookupDerivedPrefix / candidateKnownPrefixesFull) - server callers (the decode
// pipeline, learnedProducts.ts) import the full-index functions from there instead of from here.
//
// This module (client-safe) keeps only SEED (curated, hand-audited, tiny) and LEARNED (in-memory
// flywheel, built from runtime data, never a static file) - both are safe and cheap to ship to the
// browser. `lookupPrefix`/`candidateKnownPrefixes` below intentionally do NOT see the derived tier;
// a client caller (scanStore's synchronous prefix-floor naming) gets SEED/LEARNED results instantly,
// and the async /api/prefix-floor route enriches with the derived tier afterward (never blocks the
// scanned row from appearing/counting - see prefixFloor.ts).
const DERIVED: Record<string, PrefixEntry> = {};

/** Test-only helper: replace the derived tier (used by prefixIndex.test.ts to simulate a derived hit
 *  without pulling in the 2.3MB file). Production code never calls this from the client. */
export function setDerivedPrefixes(map: Record<string, PrefixEntry>): void {
  for (const k of Object.keys(DERIVED)) delete DERIVED[k];
  Object.assign(DERIVED, map);
}

// --- Self-learning flywheel (in-memory) -----------------------------------------------------------
// recordLearnedPrefix accumulates VERIFIED-decode evidence per prefix at runtime (gated by
// isLearnablePrefix: verified + app-verified exact code + confidence >= 0.90). LEARNED is the LOWEST
// precedence tier (seed + derived win ties), so it only fills gaps / reinforces - it never overrides
// curated or derived truth. In-memory per process; durable persistence (Firestore) is a gated follow-up.
interface LearnCounts { brands: Map<string, number>; cats: Map<string, number>; total: number }
const learnedCounts = new Map<string, LearnCounts>();
const LEARNED: Record<string, PrefixEntry> = {};

export function recordLearnedPrefix(code: string, brand: string, category?: string): void {
  const prefix = gtin13(code).slice(0, 7);
  if (prefix.length < 7 || !brand?.trim()) return;
  const b = brand.trim().toLowerCase();
  const c = (category ?? "").trim().toLowerCase();
  let lc = learnedCounts.get(prefix);
  if (!lc) { lc = { brands: new Map(), cats: new Map(), total: 0 }; learnedCounts.set(prefix, lc); }
  lc.brands.set(b, (lc.brands.get(b) ?? 0) + 1);
  if (c) lc.cats.set(c, (lc.cats.get(c) ?? 0) + 1);
  lc.total++;
  const brands = [...lc.brands.entries()].sort((a, z) => z[1] - a[1]);
  const cats = [...lc.cats.entries()].sort((a, z) => z[1] - a[1]).slice(0, 3);
  const categories = cats.map(([k]) => k);
  const candidates: PrefixCandidate[] = brands.slice(0, 4).map(([name, count]) => ({
    name, kind: "manufacturer", productCount: count, confidence: Number((count / lc!.total).toFixed(3)), categories,
  }));
  const topShare = brands.length ? brands[0][1] / lc.total : 0;
  const categoryDist: Record<string, number> = {};
  for (const [k, n] of cats) categoryDist[k] = n;
  LEARNED[prefix] = {
    prefix, candidates, dominant: topShare >= 0.5 ? (candidates[0] ?? null) : null,
    productCount: lc.total, categoryDist, countryHints: [], confidence: Number(topShare.toFixed(3)),
    ambiguity: Number((1 - topShare).toFixed(3)), source: "learned_flywheel",
  };
  brandFootprint = null; // learned a new prefix -> rebuild the reverse index lazily
}

/** Test/reset helper: clear the in-memory learned tier. */
export function clearLearnedPrefixes(): void {
  learnedCounts.clear();
  for (const k of Object.keys(LEARNED)) delete LEARNED[k];
  brandFootprint = null;
}

/**
 * Look up the prefix entry for a scanned code. Matches the LONGEST known prefix the digits start with,
 * preferring derived_catalog (more data) over curated_seed. Returns null for unknown prefixes so
 * non-cataloged product types are never affected.
 */
// Normalize any scanned code to GTIN-13 so a UPC-12 scan and its GTIN-13 form share one prefix space
// (OFF/derived keys are GTIN-13; the curated seed is stored the same way, e.g. 0051596 / 0792145).
export function gtin13(code: string | undefined): string {
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
  consider(LEARNED); // flywheel is LOWEST precedence: only fills gaps seed/derived don't cover
  return best;
}

// --- Reverse index: brand -> set of known prefixes (across all tiers) ------------------------------
// Powers the reverse guard: "the candidate brand is known under THESE prefixes, and the scan isn't one
// of them." Built lazily + cached; invalidated when the flywheel learns. Server-only (this module is).
function normBrandKey(s: string | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
let brandFootprint: Map<string, Set<string>> | null = null;
function buildFootprint(): Map<string, Set<string>> {
  const fp = new Map<string, Set<string>>();
  const add = (map: Record<string, PrefixEntry>) => {
    for (const e of Object.values(map)) {
      for (const c of e.candidates) {
        const b = normBrandKey(c.name);
        if (!b) continue;
        if (!fp.has(b)) fp.set(b, new Set());
        fp.get(b)!.add(e.prefix);
      }
    }
  };
  add(SEED);
  add(DERIVED);
  add(LEARNED);
  return fp;
}

/** Prefixes our data associates with this brand (exact normalized-key match). Empty if the brand is unknown. */
export function candidateKnownPrefixes(brand: string | undefined): string[] {
  const b = normBrandKey(brand);
  if (!b) return [];
  if (!brandFootprint) brandFootprint = buildFootprint();
  return [...(brandFootprint.get(b) ?? [])];
}

