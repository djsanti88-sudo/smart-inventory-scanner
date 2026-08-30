// PURE server-side scan resolution for the protected /api/resolve-scan endpoint. No Firebase, no
// server-only, no React imports - so it is unit-testable in isolation. The endpoint reads a business's
// products + aliases (server-side, with elevated privileges), then calls this to run the DETERMINISTIC
// resolver and shape the result for the caller's access level. A customer ("business") gets product-facing
// match info only (NO raw/clean/normalized codes, NO aliases, NO provider/evidence). platformOwner
// ("platform") gets the full internal result. This is the ONE place customer scan responses are produced.

import { resolveRawScan } from "@/services/resolver";
import { sanitizeScanResult, type CustomerScanResult } from "@/services/security/serializers";
import type { AccessLevel } from "@/users-businesses/roles/roleAccess";
import type { Product, Alias, ResolverResult } from "@/types";

export interface ResolveScanServerInput {
  rawInput: string;
  businessId: string;
  level: AccessLevel;
  products: Product[];
  aliases: Alias[];
}

/** Resolve a raw scan server-side and shape it for the caller's role. Deterministic only (never AI). */
export function resolveScanForRole(
  input: ResolveScanServerInput,
): Record<string, unknown> | CustomerScanResult {
  const result: ResolverResult = resolveRawScan(
    input.rawInput,
    input.products,
    input.aliases,
    input.businessId,
  );
  // Attach the matched product so the serializer can build product-facing fields for customers.
  const product = result.productId
    ? input.products.find((p) => p.id === result.productId) ?? null
    : null;
  const enriched = {
    ...result,
    matchedProductId: result.productId,
    productName: product?.name ?? "",
    product: product ?? undefined,
  } as Record<string, unknown>;
  // platform -> full internal result; business -> sanitized customer shape (defense-in-depth in serializer).
  return sanitizeScanResult(enriched, input.level);
}
