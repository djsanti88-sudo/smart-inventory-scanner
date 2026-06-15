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
