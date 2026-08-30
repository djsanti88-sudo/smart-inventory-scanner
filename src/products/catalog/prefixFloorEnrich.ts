// F5 bundle-surgery (wave 2, 2026-07-20): async enrichment for the DERIVED-tier prefix-floor naming
// aid. The client-safe prefixFloorName (SEED + LEARNED only) already names a row synchronously and
// instantly at scan time - the TOP-LEVEL LAW (a scanned code appears + counts immediately) is enforced
// entirely by that synchronous path and is untouched here. This module is called AFTER a provisional
// row already exists, purely to upgrade a bare "Unidentified item (...)" label to a
// "<Brand> / product unconfirmed" naming aid when the DERIVED (4M-corpus) tier has a hit the client
// couldn't see without shipping its 2.3MB map. Offline / failed fetch / no-hit = the label silently
// stays as-is; never an error surfaced to the user, never a blocker, never a re-throw.

export interface PrefixFloorEnrichResult {
  name: string;
  brand: string;
  familyLabel: string | null;
}

/** True only for the exact safe fallback labels ensureProvisionalCount/provisionalPlaceholderName mint
 *  when the client-safe (SEED/LEARNED) lookup found nothing. Never upgrade any other name (a decoded
 *  product name, a prefix-floor name already resolved client-side, a human-entered name, etc.) - this
 *  guards against a race where the row moved on before the enrichment fetch resolved. */
export function isBareUnidentifiedLabel(name: string, code: string): boolean {
  return name === `Unidentified item (barcode ${code})` || name === `Unidentified item (code ${code})`;
}

// CLASS FIX (2026-08-04, cocacola-bug-report.md): a counted row showed Brand "Coca-Cola" next to a
// correctly decoded Michelin/Nexen tire (GS1 prefix 049000 is Coca-Cola's). Root cause: the prefix-floor
// NAMING AID (prefixFloor.ts's `prefixFloorName` - "<Brand> / product unconfirmed") is a STATISTICAL
// guess, never a verified identity - but once ensureProvisionalCount writes it as a row's `brand`, every
// later identity-merge call site that passed that value through as trustworthy `existing.brand` let the
// guess win forever over a real decode's brand, because a non-empty existing.brand looks identical to a
// genuine prior identity (a real decode, a human edit, an approved alias). A guard for this exact defect
// existed at ONE of three vulnerable call sites (scanStore.ts, dated 2026-07-21 comment) and was never
// propagated to the other two - the unpatched sites are exactly the paths a fresh single-code scan and a
// dedup-reuse take. `isFloorGuessOnlyLabel` + `brandIsOnlyFloorGuess` below are now the SINGLE shared
// signal every enrichProductIdentity call site passes (as `existingBrandIsFloorGuess`) so this class of
// defect can never regress at a future call site again.

/** True when `name` is EXACTLY the floor's own "<Brand>[ (<family>)] / product unconfirmed" naming-aid
 *  text (see prefixFloor.ts's `prefixFloorName` - the ONLY place in the codebase that assembles this
 *  exact suffix). Matches BOTH the synchronous SEED/LEARNED-tier mint (ensureProvisionalCount) and the
 *  async DERIVED-tier upgrade (enrichPrefixFloorLabel below) - both write this identical suffix, so
 *  pattern-matching the text itself is provenance-tier-agnostic (unlike re-deriving the name purely from
 *  the client-only SEED/LEARNED tiers, which cannot see a DERIVED-tier result the async fetch alone
 *  resolved). */
export function isFloorGuessOnlyLabel(name: string | undefined): boolean {
  return typeof name === "string" && / \/ product unconfirmed$/.test(name.trim());
}

/** True when `name` (a row's CURRENT name, for barcode/code `code`) carries no REAL identity yet -
 *  either the bare "Unidentified item" safe fallback, or the prefix-floor brand-guess naming aid. In
 *  both cases the row's `brand` field (if any) is not a trustworthy PRIOR identity: it is either ""
 *  (bare) or nothing more than a STATISTICAL GS1-prefix guess (see prefixFloor.ts) - never a verified
 *  decode, an approved alias, or a human edit. Every enrichProductIdentity call site that merges a
 *  decode/human identity onto an existing row must pass this as `existingBrandIsFloorGuess` so a floor
 *  guess can never permanently outrank a real identity. */
export function brandIsOnlyFloorGuess(name: string, code: string): boolean {
  return isBareUnidentifiedLabel(name, code) || isFloorGuessOnlyLabel(name);
}

/**
 * Fire-and-forget enrichment fetch. Returns the resolved floor, or null when the code isn't a
 * plausible prefix-floor candidate (8-14 digits), the fetch fails, the request is offline, or the
 * server found no derived-tier hit. NEVER throws - every failure path resolves to null so callers can
 * simply no-op on null without try/catch ceremony at every call site.
 */
export async function fetchPrefixFloorEnrichment(code: string): Promise<PrefixFloorEnrichResult | null> {
  if (!/^\d{8,14}$/.test(code)) return null;
  try {
    const res = await fetch(`/api/prefix-floor?code=${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { floor?: PrefixFloorEnrichResult | null };
    return body?.floor ?? null;
  } catch {
    return null; // offline / network error / abort: silent no-op, row keeps its safe fallback label
  }
}
