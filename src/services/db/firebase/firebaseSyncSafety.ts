import type { PendingSyncItem } from "@/types";

const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1_500;
const HASHED_APPLIED_KEY_PREFIX = "h2_";
const encoder = new TextEncoder();

export type FirebaseSyncErrorCode =
  | "missing_business_id"
  | "invalid_business_id"
  | "missing_idempotency_key"
  | "invalid_entity_id"
  | "invalid_session_id"
  | "missing_payload"
  | "invalid_payload_id"
  | "payload_entity_mismatch"
  | "payload_business_mismatch"
  | "payload_session_mismatch"
  | "payload_scan_event_mismatch"
  | "payload_idempotency_mismatch"
  | "invalid_product_id"
  | "invalid_scan_event_id"
  | "invalid_count_document_id"
  | "invalid_quantity_delta"
  | "invalid_entity_type"
  | "unsupported_operation"
  | "idempotency_conflict"
  | "firestore_transaction_failed";

export interface FirebaseSyncValidationFailure {
  errorCode: FirebaseSyncErrorCode;
  message: string;
}

function isReservedDocumentId(value: string): boolean {
  return value === "." || value === ".." || /^__.*__$/.test(value);
}

export function isValidFirestoreDocumentId(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("/") &&
    !isReservedDocumentId(value) &&
    encoder.encode(value).byteLength <= FIRESTORE_DOCUMENT_ID_MAX_BYTES
  );
}

/**
 * Keep existing valid applied-key document IDs stable. Unsafe keys are mapped to a fixed-length,
 * deterministic SHA-256 ID so tire sizes, serialized edit fingerprints, and oversized keys cannot
 * alter the Firestore path or exceed its document-ID limit.
 */
export async function appliedKeyDocumentId(idempotencyKey: string): Promise<string> {
  if (isValidFirestoreDocumentId(idempotencyKey)) return idempotencyKey;

  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(idempotencyKey));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${HASHED_APPLIED_KEY_PREFIX}${hex}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null:";
  if (value === undefined) return "undefined:";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:nan";
    if (value === Number.POSITIVE_INFINITY) return "number:positive_infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:negative_infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${JSON.stringify(value)}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return `array:[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `object:{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return `${typeof value}:${JSON.stringify(String(value))}`;
}

/** Stable content identity for replay validation; object key order never changes the digest. */
export async function canonicalPayloadHash(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalidId(
  value: unknown,
  errorCode: FirebaseSyncErrorCode,
  label: string,
): FirebaseSyncValidationFailure | null {
  if (typeof value !== "string" || !isValidFirestoreDocumentId(value)) {
    return { errorCode, message: `${label} must be a valid Firestore document ID` };
  }
  return null;
}

function payloadRecord(item: PendingSyncItem): Record<string, unknown> | null {
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return null;
  return item.payload as Record<string, unknown>;
}

function validateEntityPayload(
  item: PendingSyncItem,
  payload: Record<string, unknown>,
  expectedEntityType: PendingSyncItem["entityType"],
): FirebaseSyncValidationFailure | null {
  if (item.entityType !== expectedEntityType) {
    return {
      errorCode: "invalid_entity_type",
      message: `${item.operation} requires entityType ${expectedEntityType}`,
    };
  }

  const payloadIdError = invalidId(payload.id, "invalid_payload_id", "payload.id");
  if (payloadIdError) return payloadIdError;
  if (payload.id !== item.entityId) {
    return {
      errorCode: "payload_entity_mismatch",
      message: "payload.id must match entityId",
    };
  }
  return null;
}

export function validatePendingSyncItem(item: PendingSyncItem): FirebaseSyncValidationFailure | null {
  if (!item.businessId) {
    return { errorCode: "missing_business_id", message: "businessId is required" };
  }
  const businessIdError = invalidId(item.businessId, "invalid_business_id", "businessId");
  if (businessIdError) return businessIdError;

  if (!item.idempotencyKey) {
    return { errorCode: "missing_idempotency_key", message: "idempotencyKey is required" };
  }

  const entityIdError = invalidId(item.entityId, "invalid_entity_id", "entityId");
  if (entityIdError) return entityIdError;
  const sessionIdError = invalidId(item.sessionId, "invalid_session_id", "sessionId");
  if (sessionIdError) return sessionIdError;

  const payload = payloadRecord(item);
  if (!payload) {
    return { errorCode: "missing_payload", message: "payload must be an object" };
  }
  if (payload.businessId !== undefined && payload.businessId !== item.businessId) {
    return {
      errorCode: "payload_business_mismatch",
      message: "payload.businessId must match businessId",
    };
  }

  switch (item.operation) {
    case "SAVE_SCAN_EVENT": {
      const entityError = validateEntityPayload(item, payload, "ScanEvent");
      if (entityError) return entityError;
      const payloadSessionError = invalidId(payload.sessionId, "invalid_session_id", "payload.sessionId");
      if (payloadSessionError) return payloadSessionError;
      if (payload.sessionId !== item.sessionId) {
        return { errorCode: "payload_session_mismatch", message: "payload.sessionId must match sessionId" };
      }
      if (item.scanEventId !== payload.id) {
        return {
          errorCode: "payload_scan_event_mismatch",
          message: "scanEventId must match payload.id for SAVE_SCAN_EVENT",
        };
      }
      return null;
    }
    case "SAVE_UNKNOWN_SCAN": {
      const entityError = validateEntityPayload(item, payload, "UnknownCodeReview");
      if (entityError) return entityError;
      const payloadSessionError = invalidId(payload.sessionId, "invalid_session_id", "payload.sessionId");
      if (payloadSessionError) return payloadSessionError;
      if (payload.sessionId !== item.sessionId) {
        return { errorCode: "payload_session_mismatch", message: "payload.sessionId must match sessionId" };
      }
      if (payload.scanEventId !== undefined) {
        const payloadScanEventError = invalidId(
          payload.scanEventId,
          "invalid_scan_event_id",
          "payload.scanEventId",
        );
        if (payloadScanEventError) return payloadScanEventError;
        if (payload.scanEventId !== item.scanEventId) {
          return {
            errorCode: "payload_scan_event_mismatch",
            message: "payload.scanEventId must match scanEventId when embedded",
          };
        }
      }
      if (payload.idempotencyKey !== undefined && payload.idempotencyKey !== item.idempotencyKey) {
        return {
          errorCode: "payload_idempotency_mismatch",
          message: "payload.idempotencyKey must match idempotencyKey when embedded",
        };
      }
      return null;
    }
    case "RESOLVE_ALIAS": {
      const entityError = validateEntityPayload(item, payload, "Alias");
      if (entityError) return entityError;
      return invalidId(payload.productId, "invalid_product_id", "payload.productId");
    }
    case "SAVE_PRODUCT":
      return validateEntityPayload(item, payload, "Product");
    case "SAVE_SESSION": {
      const entityError = validateEntityPayload(item, payload, "CountSession");
      if (entityError) return entityError;
      if (payload.id !== item.sessionId) {
        return { errorCode: "payload_session_mismatch", message: "payload.id must match sessionId" };
      }
      return null;
    }
    case "SETTLE_TRUSTED_EXACT": {
      if (item.entityType !== "UnknownCodeReview") return { errorCode: "invalid_entity_type", message: "SETTLE_TRUSTED_EXACT requires entityType UnknownCodeReview" };
      const product = payload.product as Record<string, unknown> | undefined;
      const review = payload.review as Record<string, unknown> | undefined;
      const terminalEvents = payload.terminalEvents;
      const archivedProduct = payload.archivedProduct as Record<string, unknown> | undefined;
      const countTransfers = payload.countTransfers ?? [];
      if (!product || !review || !Array.isArray(terminalEvents) || !Array.isArray(countTransfers) || terminalEvents.length > 400 || countTransfers.length > 50 || terminalEvents.length + (countTransfers.length * 2) > 490) return { errorCode: "missing_payload", message: "trusted settlement requires bounded product, review, terminalEvents, and countTransfers payloads" };
      if (product.id === undefined || product.businessId !== item.businessId || review.id !== item.entityId || review.businessId !== item.businessId || review.sessionId !== item.sessionId) return { errorCode: "payload_entity_mismatch", message: "trusted settlement payload does not bind to its queue item" };
      if (archivedProduct && (archivedProduct.businessId !== item.businessId || archivedProduct.id === product.id || !isValidFirestoreDocumentId(String(archivedProduct.id ?? "")))) return { errorCode: "payload_entity_mismatch", message: "archived product does not bind safely to trusted settlement" };
      for (const event of terminalEvents) {
        if (!event || typeof event !== "object" || Array.isArray(event)) return { errorCode: "missing_payload", message: "terminal events must be objects" };
        const record = event as Record<string, unknown>;
        if (record.businessId !== item.businessId || !isValidFirestoreDocumentId(String(record.id ?? "")) || record.sessionId !== item.sessionId || record.matchedProductId !== product.id) return { errorCode: "payload_entity_mismatch", message: "terminal event does not bind to trusted settlement" };
      }
      for (const transfer of countTransfers) {
        if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) return { errorCode: "missing_payload", message: "count transfers must be objects" };
        const record = transfer as Record<string, unknown>;
        if (record.sessionId !== item.sessionId || record.fromProductId === record.toProductId || !isValidFirestoreDocumentId(String(record.fromProductId ?? "")) || record.toProductId !== product.id || !Number.isInteger(record.quantity) || Number(record.quantity) <= 0) return { errorCode: "payload_entity_mismatch", message: "count transfer does not bind to trusted settlement" };
      }
      return null;
    }
    case "INCREMENT_COUNT": {
      if (item.entityType !== "InventoryCount") {
        return {
          errorCode: "invalid_entity_type",
          message: "INCREMENT_COUNT requires entityType InventoryCount",
        };
      }
      const payloadSessionError = invalidId(payload.sessionId, "invalid_session_id", "payload.sessionId");
      if (payloadSessionError) return payloadSessionError;
      if (payload.sessionId !== item.sessionId) {
        return { errorCode: "invalid_session_id", message: "payload.sessionId must match sessionId" };
      }
      const productIdError = invalidId(payload.productId, "invalid_product_id", "payload.productId");
      if (productIdError) return productIdError;
      const scanEventIdError = invalidId(payload.scanEventId, "invalid_scan_event_id", "payload.scanEventId");
      if (scanEventIdError) return scanEventIdError;
      if (item.scanEventId !== null && item.scanEventId !== payload.scanEventId) {
        return {
          errorCode: "payload_scan_event_mismatch",
          message: "scanEventId must match payload.scanEventId when present",
        };
      }
      if (payload.idempotencyKey !== item.idempotencyKey) {
        return {
          errorCode: "payload_idempotency_mismatch",
          message: "payload.idempotencyKey must match idempotencyKey",
        };
      }
      if (
        typeof payload.quantityDelta !== "number" ||
        !Number.isFinite(payload.quantityDelta) ||
        !Number.isInteger(payload.quantityDelta) ||
        payload.quantityDelta === 0
      ) {
        return {
          errorCode: "invalid_quantity_delta",
          message: "payload.quantityDelta must be a nonzero finite integer",
        };
      }
      if (payload.scanEvent !== undefined) {
        const scanEvent = payload.scanEvent;
        if (!scanEvent || typeof scanEvent !== "object" || Array.isArray(scanEvent)) {
          return { errorCode: "missing_payload", message: "payload.scanEvent must be an object when present" };
        }
        const embedded = scanEvent as Record<string, unknown>;
        const embeddedIdError = invalidId(embedded.id, "invalid_scan_event_id", "payload.scanEvent.id");
        if (embeddedIdError) return embeddedIdError;
        if (embedded.id !== payload.scanEventId) {
          return { errorCode: "payload_scan_event_mismatch", message: "payload.scanEvent.id must match payload.scanEventId" };
        }
        if (embedded.businessId !== item.businessId) {
          return { errorCode: "payload_business_mismatch", message: "payload.scanEvent.businessId must match businessId" };
        }
        if (embedded.sessionId !== item.sessionId) {
          return { errorCode: "payload_session_mismatch", message: "payload.scanEvent.sessionId must match sessionId" };
        }
        if (embedded.matchedProductId !== payload.productId) {
          return { errorCode: "payload_entity_mismatch", message: "payload.scanEvent.matchedProductId must match productId" };
        }
      }
      if (payload.product !== undefined) {
        const product = payload.product;
        if (!product || typeof product !== "object" || Array.isArray(product)) {
          return { errorCode: "missing_payload", message: "payload.product must be an object when present" };
        }
        const embedded = product as Record<string, unknown>;
        const embeddedIdError = invalidId(embedded.id, "invalid_product_id", "payload.product.id");
        if (embeddedIdError) return embeddedIdError;
        if (embedded.id !== payload.productId) {
          return { errorCode: "payload_entity_mismatch", message: "payload.product.id must match productId" };
        }
        if (embedded.businessId !== item.businessId) {
          return { errorCode: "payload_business_mismatch", message: "payload.product.businessId must match businessId" };
        }
      }
      return invalidId(
        `${payload.sessionId as string}_${payload.productId as string}`,
        "invalid_count_document_id",
        "inventory count document ID",
      );
    }
    default:
      return { errorCode: "unsupported_operation", message: `Unsupported operation ${String(item.operation)}` };
  }
}
