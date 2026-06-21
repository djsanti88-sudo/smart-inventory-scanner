import type { Alias } from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";

// aliasDiscovery.ts - pure, deterministic. Find the GROUNDED identifiers that could become aliases for a
// product, and which of them are safe to OFFER as one-click "discovered" aliases. No AI, no network.
//
// Trust rule it serves: a suggested/AI-derived identifier is NEVER auto-trusted. This module only ever
// returns codes that ACTUALLY appear in the product/decode data (it never fabricates one), and the caller
// persists them as UNAPPROVED aliases until a human approves them. Approving is conflict-safe: a code that
// already belongs (approved) to another product is never offered.

export type GroundedIdentifier = { rawCode: string; cleanCode: string; field: string };

const IDENTIFIER_FIELDS = ["primaryBarcode", "primarySku", "gtin", "upc", "ean"] as const;

type IdentityLike = Partial<Record<(typeof IDENTIFIER_FIELDS)[number], string>> & {
  vendorCodes?: string[];
  extras?: string[]; // decode-surfaced extras (e.g. the `aliases` array or an extracted part number)
};

/**
 * Collect the GROUNDED (present, non-empty) identifier codes from a product/decode identity. Never
 * invents: only values actually present are returned, deduped by clean code. `extras` carry decode
 * suggestions (the `aliases` array, an extracted part number) under field "discovered".
 */
export function collectGroundedIdentifiers(identity: IdentityLike): GroundedIdentifier[] {
  const out: GroundedIdentifier[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined, field: string) => {
    if (!raw || !raw.trim()) return; // prefer blank over a fabricated code
    const cleanCode = cleanScanCode(raw).cleanCode;
    if (!cleanCode || seen.has(cleanCode)) return;
    seen.add(cleanCode);
    out.push({ rawCode: raw.trim(), cleanCode, field });
  };
  for (const f of IDENTIFIER_FIELDS) push(identity[f], f);
  for (const v of identity.vendorCodes ?? []) push(v, "vendorCode");
  for (const e of identity.extras ?? []) push(e, "discovered");
  return out;
}

/**
 * Of the grounded identifiers, the DISCOVERABLE ones for `productId` are those not already an APPROVED
 * alias of this product (already matchable) and not an APPROVED alias of a DIFFERENT product (conflict -
 * never hijack). An UNapproved alias of this product is still discoverable (it does not match yet). Pure;
 * never invents a code.
 */
export function discoverableIdentifiers(
  grounded: GroundedIdentifier[],
  aliases: Alias[],
  productId: string,
  businessId: string,
): GroundedIdentifier[] {
  const approvedOwner = new Map<string, string>(); // cleanCode -> productId, approved aliases only
  for (const a of aliases) {
    if (a.businessId === businessId && a.approved) approvedOwner.set(a.cleanCode, a.productId);
  }
  return grounded.filter((g) => {
    const owner = approvedOwner.get(g.cleanCode);
    if (owner === productId) return false; // already matchable for this product
    if (owner) return false; // approved for a DIFFERENT product -> conflict, never offer
    return true;
  });
}
