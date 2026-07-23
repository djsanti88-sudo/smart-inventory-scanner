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

/** Customer-safe product-facing fields (allowlist). Used to BUILD sanitized shapes, not just strip.
 * Owner rule (2026-07-22, encoded in src/components/FinalCountTable.tsx:129-131): the barcode a shop
 * scanned onto THEIR OWN product row is THEIR data - already rendered to every role in the UI - so
 * primaryBarcode/gtin/upc/ean are included here. Stripping a shop's own scanned identifier from that
 * same device's own localStorage persistence protected nothing and instead destroyed the shop's own
 * data (the Products/Counts "Barcode" column showed "-" after every reload). The reusable alias/catalog
 * corpus (aliases, vendorCodes, the master catalog) stays platform-only and is unaffected by this.
 * TOP-LEVEL LAW FIX (2026-07-22): `provisional` is a LOCAL boolean flag (never a barcode/alias/catalog
 * datum), and it MUST survive the customer persist split: with primaryBarcode persisted but provisional
 * stripped, a reload left the row findable by ensureProvisionalCount's idempotent guard (which returned
 * early, counting nothing) yet invisible to processScan's re-scan bridge (which requires
 * p.provisional === true) - so re-scanning the same code after a reload appeared on the feed but never
 * counted (scan 2 = count 1). Proof: src/stores/rescanAfterReload.store.test.ts. */
export const CUSTOMER_SAFE_PRODUCT_FIELDS = [
  "id", "name", "brand", "category", "specsShort", "primarySku", "imageUrl", "location", "notes", "status",
  "primaryBarcode", "gtin", "upc", "ean",
  "provisional",
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
  // HOLD-STAMP FIX (2026-07-22): also a LOCAL product id (never a barcode/reusable code). The
  // post-resolve stamp sites spare rows a human deliberately held open via suggestedLinkProductId
  // (identity-merge suggest_link path); dropping it here made the hold vanish on a customer
  // reload, letting auto-resolve stamp a row that was kept open on purpose.
  "suggestedLinkProductId",
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
