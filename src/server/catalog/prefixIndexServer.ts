import "server-only";

// F5 bundle-surgery (wave 2, 2026-07-20): the FULL prefix index (SEED + DERIVED_CATALOG + LEARNED),
// including the 2.3MB `derivedPrefixMap.json` generated from our 4M-row retail/tire corpus, lives here
// SERVER-ONLY. The client-safe half (@/services/catalog/prefixIndex) keeps only the tiny curated SEED
// and the in-memory LEARNED flywheel so `lookupPrefix` stays synchronous and correct for those tiers in
// browser code (scanStore's prefix-floor naming) without ever shipping the derived map to a customer.
//
// Server-only callers that need the FULL merged index (pipeline.ts's firewall/corroboration checks,
// learnedProducts.ts's prefix-corroboration gate) import lookupPrefixFull / candidateKnownPrefixesFull
// from HERE, not from the client-safe module - this preserves their exact prior behavior (derived-tier
// data included) with zero behavior change.

import {
  type PrefixEntry,
  type PrefixSource,
  type PrefixCandidate,
  gtin13,
  lookupPrefix as lookupSeedOrLearned,
  candidateKnownPrefixes as candidateKnownPrefixesSeedOrLearned,
} from "@/services/catalog/prefixIndex";
import derivedPrefixMap from "@/services/catalog/derivedPrefixMap.json";
import { prefixFloorName, type PrefixFloorResult } from "@/services/catalog/prefixFloor";
import type { CodeType } from "@/types";

export type { PrefixEntry, PrefixSource, PrefixCandidate };

// The generated derived map is stored COMPACT (array per prefix) to keep the file small + fast to load:
//   [confidence, ambiguity, productCount, [[name,count]...], [[category,count]...]]
// Expand it into full PrefixEntry objects once at module init (server process only).
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

const DERIVED: Record<string, PrefixEntry> = expandCompact(derivedPrefixMap as Record<string, unknown>);

/** DERIVED-tier-only lookup (longest-prefix match). Used by the /api/prefix-floor route to enrich a
 *  client row that the client-safe SEED/LEARNED lookup already tried and missed. */
export function lookupDerivedPrefix(code: string | undefined): PrefixEntry | null {
  const digits = gtin13(code);
  if (digits.length < 7) return null;
  let best: PrefixEntry | null = null;
  for (const key of Object.keys(DERIVED)) {
    if (!digits.startsWith(key)) continue;
    if (!best || key.length > best.prefix.length) best = DERIVED[key];
  }
  return best;
}

/**
 * FULL merged lookup (SEED > DERIVED > LEARNED precedence, matching the pre-split `lookupPrefix`
 * exactly) for server-only callers that need the whole index (decode pipeline firewall,
 * learned-tier prefix corroboration). Never use from client code - import the client-safe
 * `lookupPrefix` from @/services/catalog/prefixIndex instead.
 */
export function lookupPrefixFull(code: string | undefined): PrefixEntry | null {
  const digits = gtin13(code);
  if (digits.length < 7) return null;
  const seedOrLearned = lookupSeedOrLearned(code); // SEED wins ties; LEARNED is lowest precedence
  const derived = lookupDerivedPrefix(code);
  if (!seedOrLearned) return derived;
  if (!derived) return seedOrLearned;
  // Longer/more-specific match wins; SEED already beats same-length DERIVED inside lookupSeedOrLearned's
  // own precedence, so only compare when derived is a strictly longer (more specific) prefix match AND
  // the seed/learned hit isn't itself a SEED entry (SEED is authoritative for its own prefixes).
  if (seedOrLearned.source === "curated_seed") return seedOrLearned;
  return derived.prefix.length >= seedOrLearned.prefix.length ? derived : seedOrLearned;
}

/** FULL reverse brand->prefixes footprint (SEED + DERIVED + LEARNED). Server-only. */
export function candidateKnownPrefixesFull(brand: string | undefined): string[] {
  const b = (brand || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!b) return [];
  const out = new Set<string>(candidateKnownPrefixesSeedOrLearned(brand));
  for (const e of Object.values(DERIVED)) {
    for (const c of e.candidates) {
      const cb = c.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (cb === b) out.add(e.prefix);
    }
  }
  return [...out];
}

/** Server-side prefixFloorName using the FULL merged index (unchanged behavior from before the
 *  bundle split). Used by the decode pipeline and the /api/prefix-floor route. */
export function prefixFloorNameFull(code: string, codeType: CodeType): PrefixFloorResult | null {
  return prefixFloorName(code, codeType, lookupPrefixFull);
}
