# Case: bug-04-barcode-stripped-from-own-products
## Task prompt (what the subject model sees)
Review the following code for real defects. This is a security/privacy module for a multi-tenant inventory app that defines which product fields are safe to persist/render to a customer (non-platform-owner) role, versus platform-only fields that must never leave the server.
## Input code
```ts
// src/services/security/sensitiveFields.ts
// Central denylist of fields that customer roles must NEVER receive (UI, API, exports, localStorage).
// PURE, no imports. The single source of truth used by every serializer + the SecurityLeakBot.

export const SENSITIVE_FIELDS = [
  "rawScannedCode", "rawCode", "raw_code",
  "cleanCode", "clean_code",
  "normalizedCode", "normalized_code", "normalizedCandidates", "normalized_candidates",
  "barcode", "barcodes", "primaryBarcode", "primary_barcode",
  "aliases", "aliasCodes", "alias_codes", "rawCodeExample", "raw_code_example",
  "gtin", "upc", "ean",
  "rawQrValue", "raw_qr_value",
  "vendorCodes", "vendor_codes",
  "sourceUrls", "source_urls", "sourceEvidence", "source_evidence", "evidence", "verifiedFacts",
  "providerName", "provider_name", "providerNames", "aiProvider", "ai_provider",
  "aiPrompt", "ai_prompt", "aiEvidence", "ai_evidence",
  "decodeTrace", "decode_trace", "lookupPath", "lookup_path",
  "globalCatalogId", "global_catalog_id", "globalAliasId", "global_alias_id",
  "internalConfidenceDebug", "internal_confidence_debug",
  "prompt", "fullAliasMap", "catalogIndex", "debugExport", "internalAuditDiagnostics",
  "scanEventIds", "scan_event_ids", "aliasesSeen", "aliases_seen", "idempotencyKey", "idempotency_key",
] as const;

const SENSITIVE_SET = new Set<string>(SENSITIVE_FIELDS.map((f) => f.toLowerCase()));

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_SET.has(key.toLowerCase());
}

/** Recursively strip sensitive keys from an object/array. Returns a NEW value; never mutates input. */
export function stripSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out as T;
  }
  return value;
}

/** Customer-safe product-facing fields (allowlist). Used to BUILD sanitized shapes, not just strip. */
export const CUSTOMER_SAFE_PRODUCT_FIELDS = [
  "id", "name", "brand", "category", "specsShort", "primarySku", "imageUrl", "location", "notes", "status",
] as const;

// A customer's OWN pending Needs-Review item — only the fields they need to SEE + ACT on it, plus their
// own scanned code (cleanCode, already shown to all roles in LiveScanFeed). EXCLUDES every provider/decode
// internal (providerName, sourceUrls, verifiedFacts, decodeProviderSummaries, evidence/crossCheck/confidence)
// AND every OTHER reusable code (rawCode/normalizedCandidates/suggestedAliases/gtin/upc/ean/primaryBarcode/
// primarySku/productUrl/specsFull) so no reusable alias/catalog data reaches a customer's disk.
export const CUSTOMER_SAFE_REVIEW_FIELDS = [
  "id", "businessId", "sessionId", "cleanCode",
  "suggestedProductName", "suggestedBrand", "suggestedCategory", "suggestedSpecsShort", "suggestedImageUrl",
  "reason", "blockingReasons", "hasSuggestion", "decodeStatus", "status",
  "createdAt", "resolvedAt", "resolvedBy", "resolutionAction", "syncStatus", "idempotencyKey",
  // STABLE-ID FIX: a LOCAL product id (not a barcode/gtin/reusable code), safe to persist - lets
  // resolveUnknown re-link this review's own provisional placeholder by id after a customer reload
  // instead of by reconstructed name (which collides when two codes share a prefix-floor brand).
  "provisionalProductId",
  "importQuantity",
] as const;

// A customer's OWN scan-feed event survives reload as an activity log (Product, Qty after, Status, Reason,
// Saved, Barcode). INCLUDES cleanCode: the code on THIS row is the shop's own physical scan of its own
// label - the shop's own data, not a foreign tenant's - so it must survive reload the same way Needs
// Review already keeps it (CUSTOMER_SAFE_REVIEW_FIELDS) at this same access level (QA fix #15: without it
// the audit trail loses what was physically scanned after a reload). This is NOT the reusable code->product
// alias/catalog database: that stays excluded via rawCode, normalizedCandidates, matchType, codeType,
// decodeNote, notes, syncError (platform-only decode traces + internal formatting) which remain stripped.
export const CUSTOMER_SAFE_SCANEVENT_FIELDS = [
  "id", "businessId", "sessionId", "matchedProductId", "cleanCode", "location",
  "status", "resolverStatus", "reason", "quantityDelta", "quantityAfterScan",
  "decodeStatus", "syncStatus", "createdAt", "source", "idempotencyKey",
] as const;
```
## GROUND TRUTH (never shown to subject)
- Defect: `CUSTOMER_SAFE_PRODUCT_FIELDS` is used to sanitize a shop's OWN product rows before persisting/rendering them (e.g. to localStorage), but it omits `primaryBarcode`/`gtin`/`upc`/`ean`. Since `stripSensitive`/the sensitive-field denylist treats those same field names as globally sensitive (meant for the reusable platform-wide alias/catalog corpus), building a product's persisted shape from this allowlist strips the shop's own scanned barcode off its own product row every time it is persisted. The `CUSTOMER_SAFE_SCANEVENT_FIELDS` allowlist right below it correctly includes `cleanCode` (the shop's own scan) with a comment explaining exactly this "own data is not the same as reusable corpus data" distinction — but `CUSTOMER_SAFE_PRODUCT_FIELDS` fails to apply that same reasoning to barcode fields, so a shop's own Products/Counts table shows blank/dash barcodes after every reload.
- Fix commit: 4807e16 fix(persist): a shop's own product identifiers survive customer-level persistence
- Key evidence: `export const CUSTOMER_SAFE_PRODUCT_FIELDS = ["id", "name", "brand", "category", "specsShort", "primarySku", "imageUrl", "location", "notes", "status"] as const;` — no `primaryBarcode`, `gtin`, `upc`, or `ean`, even though those are exactly the shop's own scanned identifiers on its own product row, and the sibling `CUSTOMER_SAFE_SCANEVENT_FIELDS` list just below deliberately keeps the analogous `cleanCode` field for the same reason.
- Scoring: HIT if the subject identifies that `CUSTOMER_SAFE_PRODUCT_FIELDS` omits the product's own barcode/gtin/upc/ean fields, causing a shop's own scanned identifier to be stripped from its own product data on persistence/reload, and notes the inconsistency with `CUSTOMER_SAFE_SCANEVENT_FIELDS`'s inclusion of `cleanCode` for the same reasoning. PARTIAL if the subject flags that `CUSTOMER_SAFE_PRODUCT_FIELDS` looks like it's missing fields compared to the full `Product` shape but doesn't specifically call out barcode/gtin/upc/ean as the ones that matter or the reload-data-loss consequence. Plausible-but-wrong findings: (1) suggesting `SENSITIVE_FIELDS`/`CUSTOMER_SAFE_REVIEW_FIELDS`/`CUSTOMER_SAFE_SCANEVENT_FIELDS` should also drop `idempotencyKey` for security (it's intentionally kept, it's not a reusable code); (2) claiming case-insensitive matching in `isSensitiveKey` via `.toLowerCase()` is a bug (it's intentional, matches both camelCase and snake_case names); (3) flagging that `CUSTOMER_SAFE_PRODUCT_FIELDS` doesn't include `verified`/`businessId` as a security gap (real but a distinct, separate defect fixed in a later commit, not this one).
