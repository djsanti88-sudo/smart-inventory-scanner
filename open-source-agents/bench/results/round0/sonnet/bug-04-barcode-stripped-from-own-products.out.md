# Review: bug-04-barcode-stripped-from-own-products

## Defect 1 (Critical): `stripSensitive` is a blanket key-name denylist with no concept of "own data vs. foreign reusable data," so it strips a customer's OWN product barcode along with genuinely platform-only fields

```ts
export const SENSITIVE_FIELDS = [
  ...
  "barcode", "barcodes", "primaryBarcode", "primary_barcode",
  ...
  "gtin", "upc", "ean",
  ...
] as const;

export function stripSensitive<T>(value: T): T {
  ...
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) continue;   // drops the key entirely, unconditionally
    out[k] = stripSensitive(v);
  }
  ...
}
```

`stripSensitive` is a pure, generic, recursive function that removes any key whose *name* matches the denylist, regardless of *whose* data the object represents or what role is asking. `barcode`, `barcodes`, `primaryBarcode`, `gtin`, `upc`, and `ean` are all on that denylist. But a shop's own `Product` record legitimately needs its own barcode field — that's the primary identifier the shop uses to scan and match its own inventory. If `stripSensitive` (rather than the purpose-built `CUSTOMER_SAFE_PRODUCT_FIELDS` allowlist) is ever applied to a customer's own product object — e.g. as a generic "sanitize before sending to the client" pass, a defensive wrapper around an API response, or a fallback path — the customer's own `primaryBarcode`/`barcode` fields are stripped exactly as if they were someone else's reusable alias/catalog data. The customer then cannot see or use the barcode on their own product record, even though it is unambiguously their own scanned data, not a "foreign tenant's" or a "reusable alias/catalog" secret.

This matches the module's own reasoning elsewhere: `CUSTOMER_SAFE_SCANEVENT_FIELDS`'s comment explicitly carves out an exception for `cleanCode` because it is "the shop's own physical scan of its own label — the shop's own data, not a foreign tenant's," and deliberately keeps it despite `cleanCode` also being denylisted in `SENSITIVE_FIELDS`. The module's own design principle (own-scan-data survives; foreign/reusable data doesn't) is applied as a special case for `CUSTOMER_SAFE_SCANEVENT_FIELDS`, but `stripSensitive`/`SENSITIVE_FIELDS` — the *general-purpose* denylist function documented as "the single source of truth used by every serializer" — has no equivalent per-context override for a product's own `barcode`/`primaryBarcode`. Any serializer that runs `stripSensitive` directly over a `Product` object (rather than exclusively using the `CUSTOMER_SAFE_PRODUCT_FIELDS` allowlist path) will silently drop the barcode from the customer's own product data.

## Defect 2 (Medium): `CUSTOMER_SAFE_PRODUCT_FIELDS` itself omits any barcode/SKU-like identifying field, so even the allowlist path loses it

```ts
export const CUSTOMER_SAFE_PRODUCT_FIELDS = [
  "id", "name", "brand", "category", "specsShort", "primarySku", "imageUrl", "location", "notes", "status",
] as const;
```

This allowlist includes `primarySku` but not `primaryBarcode`/`barcode`. If `primarySku` is meant to double as the customer-visible identifier, that's a naming/documentation gap (nothing in the comments explains why `primarySku` is safe but `primaryBarcode` isn't, when both plausibly identify the same object the customer owns) — but if `primarySku` and `primaryBarcode` are actually different concepts (SKU vs. UPC/barcode), then the allowlist for a customer's own product genuinely never includes their own barcode value at all, which breaks any customer-facing UI/export that needs to show or edit the barcode of a product they own.

## Not a defect
- Denylisting `barcode`/`gtin`/`upc`/`ean`/`aliases`/`sourceUrls`/`providerName`/etc. for the *reusable alias/catalog/decode-internal* data (the cross-tenant global database) is correct and intentional — that data must never leak to a customer role, and the extensive comments correctly justify this.
- `CUSTOMER_SAFE_REVIEW_FIELDS` and `CUSTOMER_SAFE_SCANEVENT_FIELDS` both correctly reason about "own scan of own label" vs. "reusable code database" and make deliberate, well-justified exceptions (`cleanCode` included, `rawCode`/`normalizedCandidates` excluded) — this part of the design is sound and internally consistent.
- `isSensitiveKey`'s case-insensitive lookup via a `Set` is a reasonable, efficient implementation with no bug in the matching logic itself.

## Recommendation
Either (a) never apply `stripSensitive` directly to a customer's own `Product` object — enforce that only the `CUSTOMER_SAFE_PRODUCT_FIELDS` allowlist path is used for products, the same way `CUSTOMER_SAFE_SCANEVENT_FIELDS` deliberately overrides the denylist for `cleanCode`; or (b) add an explicit "own barcode" allowlist field (e.g. `ownBarcode`/`primaryBarcode`) to `CUSTOMER_SAFE_PRODUCT_FIELDS` with the same "own data, not reusable" justification already used for scan events, and make sure any generic `stripSensitive` call site is documented as unsafe for product-shaped objects.
