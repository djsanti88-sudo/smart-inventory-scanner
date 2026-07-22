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
