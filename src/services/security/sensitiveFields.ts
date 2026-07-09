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
] as const;

// A customer's OWN scan-feed event survives reload as an activity log (Product, Qty after, Status, Reason,
// Saved). It deliberately EXCLUDES cleanCode: a MATCHED feed row maps a known code -> product, and a growing
// list of those is a slice of the reusable code->product database, which must never persist to a customer
// browser (Sec-4 leak guard). The product name + qty are what the customer needs after a reload; the raw
// code is on the physical item and is shown live during the session. Also excludes rawCode,
// normalizedCandidates, matchType, codeType, decodeNote, notes, syncError (platform-only decode traces).
export const CUSTOMER_SAFE_SCANEVENT_FIELDS = [
  "id", "businessId", "sessionId", "matchedProductId",
  "status", "resolverStatus", "reason", "quantityDelta", "quantityAfterScan",
  "decodeStatus", "syncStatus", "createdAt", "source", "idempotencyKey",
] as const;
