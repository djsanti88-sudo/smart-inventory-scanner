// Role-aware serializers. The ONE place customer-facing shapes are produced. platformOwner ("platform")
// gets the full internal shape; everyone else ("business") gets product-facing fields only. Used by the
// server resolve endpoint, the customer loader, export builders, and (secondarily) UI. PURE.

import type { AccessLevel } from "@/services/security/roleAccess";
import { stripSensitive, CUSTOMER_SAFE_PRODUCT_FIELDS } from "@/services/security/sensitiveFields";

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
}

/** Product → role-shaped. platform: full object untouched. business: product-facing allowlist only. */
export function sanitizeProduct<T extends Record<string, unknown>>(product: T, level: AccessLevel): T | CustomerProduct {
  if (level === "platform") return product;
  const p = product as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_SAFE_PRODUCT_FIELDS) out[f] = p[f] ?? "";
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

/** Generic record sanitizer for any customer-facing payload (defense in depth): strip every sensitive key. */
export function sanitizeForBusiness<T>(value: T): T {
  return stripSensitive(value);
}
