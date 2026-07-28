// Role-aware serializers. The ONE place customer-facing shapes are produced. platformOwner ("platform")
// gets the full internal shape; everyone else ("business") gets product-facing fields only. Used by the
// server resolve endpoint, the customer loader, export builders, and (secondarily) UI. PURE.

import type { AccessLevel } from "@/services/security/roleAccess";
import { stripSensitive, CUSTOMER_SAFE_PRODUCT_FIELDS, CUSTOMER_SAFE_REVIEW_FIELDS, CUSTOMER_SAFE_SCANEVENT_FIELDS } from "@/services/security/sensitiveFields";

export interface CustomerProduct {
  id: string;
  name: string;
  brand: string;
  category: string;
  specsShort: string;
  primarySku: string; // the manufacturer part number is product-facing (allowed); NOT barcode/gtin/upc/ean
  imageUrl: string;
  location: string;
  notes: string;
  status: string;
  verified: boolean;
  businessId: string;
}

// Fields whose absence must NOT be coerced to "" - `verified` is a boolean trust flag (defaulting a
// missing value to "" would poison the resolver trust gate's `p.verified === true` check with a
// truthy-but-wrong-typed value in some contexts and is simply the wrong type for a boolean field).
const BOOLEAN_PRODUCT_FIELDS = new Set<string>(["verified"]);

/** Product → role-shaped. platform: full object untouched. business: product-facing allowlist only. */
export function sanitizeProduct<T extends Record<string, unknown>>(product: T, level: AccessLevel): T | CustomerProduct {
  if (level === "platform") return product;
  const p = product as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_SAFE_PRODUCT_FIELDS) {
    out[f] = BOOLEAN_PRODUCT_FIELDS.has(f) ? p[f] === true : p[f] ?? "";
  }
  return out as unknown as CustomerProduct;
}

export function sanitizeProducts<T extends Record<string, unknown>>(products: T[], level: AccessLevel) {
  return products.map((p) => sanitizeProduct(p, level));
}

export interface CustomerScanResult {
  matchedProductId: string | null;
  productName: string;
  brand: string;
  category: string;
  partNumber: string; // primarySku
  specs: string;
  matchStatus: string; // known | needs_review | conflict
  quantityAfterScan: number;
  reason: string;
}

/** A scan/resolve result → role-shaped. business: product-facing match info only, NO raw/clean/normalized
 *  codes, NO aliases, NO provider/evidence/trace. platform: full result untouched. */
export function sanitizeScanResult(
  result: Record<string, unknown>,
  level: AccessLevel,
): Record<string, unknown> | CustomerScanResult {
  if (level === "platform") return result;
  const r = result as Record<string, unknown>;
  const product = (r.product ?? {}) as Record<string, unknown>;
  return {
    matchedProductId: (r.matchedProductId as string) ?? (r.productId as string) ?? null,
    productName: (r.productName as string) ?? (product.name as string) ?? "",
    brand: (product.brand as string) ?? "",
    category: (product.category as string) ?? "",
    partNumber: (product.primarySku as string) ?? "",
    specs: (product.specsShort as string) ?? "",
    matchStatus: (r.resolverStatus as string) ?? (r.status as string) ?? "",
    quantityAfterScan: typeof r.quantityAfterScan === "number" ? (r.quantityAfterScan as number) : 0,
    reason: typeof r.reason === "string" ? (r.reason as string) : "",
  };
}

/** A Needs-Review item → role-shaped. business: allowlist of act-on-it fields + the user's own cleanCode;
 *  NO provider/evidence internals and NO other reusable codes. platform: untouched. */
export function sanitizeReview<T extends Record<string, unknown>>(review: T, level: AccessLevel): T | Record<string, unknown> {
  if (level === "platform") return review;
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_SAFE_REVIEW_FIELDS) if (f in review) out[f] = review[f];
  return out;
}

/** A scan-feed event → role-shaped. business: allowlist matching LiveScanFeed's customer columns (own
 *  cleanCode kept); NO rawCode/normalized/matchType/decodeNote/syncError. platform: untouched. */
export function sanitizeScanEvent<T extends Record<string, unknown>>(event: T, level: AccessLevel): T | Record<string, unknown> {
  if (level === "platform") return event;
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_SAFE_SCANEVENT_FIELDS) if (f in event) out[f] = event[f];
  return out;
}

/** Generic record sanitizer for any customer-facing payload (defense in depth): strip every sensitive key. */
export function sanitizeForBusiness<T>(value: T): T {
  return stripSensitive(value);
}
