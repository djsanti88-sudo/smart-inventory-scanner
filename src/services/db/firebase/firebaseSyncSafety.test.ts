import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase/firestore";
import type { PendingSyncItem } from "@/types";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import {
  appliedKeyDocumentId,
  canonicalPayloadHash,
  validatePendingSyncItem,
} from "@/services/db/firebase/firebaseSyncSafety";

function productItem(overrides: Partial<PendingSyncItem> = {}): PendingSyncItem {
  return {
    id: "queue-1",
    businessId: "business-1",
    sessionId: "session-1",
    entityType: "Product",
    entityId: "product-1",
    operation: "SAVE_PRODUCT",
    payload: {
      id: "product-1",
      businessId: "business-1",
      name: "Nokian Outpost APT 245/55R19",
      verified: false,
    },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    idempotencyKey: "business-1:session-1:product-1:SAVE_PRODUCT",
    scanEventId: null,
    ...overrides,
  };
}

describe("Firebase sync safety", () => {
  it("preserves legacy applied-key IDs that are valid Firestore document IDs", async () => {
    const key = "business-1:session-1:product-1:SAVE_PRODUCT";
    await expect(appliedKeyDocumentId(key)).resolves.toBe(key);
    await expect(appliedKeyDocumentId("x".repeat(1_500))).resolves.toBe("x".repeat(1_500));
  });

  it("deterministically hashes slash-containing and reserved applied-key IDs", async () => {
    const slashKey = "business-1:session-1:Nokian 245/55R19:SAVE_PRODUCT";
    const first = await appliedKeyDocumentId(slashKey);
    const second = await appliedKeyDocumentId(slashKey);

    expect(first).toBe(second);
    expect(first).toMatch(/^h2_[0-9a-f]{64}$/);
    expect(first).not.toContain("/");

    for (const reserved of [".", "..", "__reserved__"]) {
      await expect(appliedKeyDocumentId(reserved)).resolves.toMatch(/^h2_[0-9a-f]{64}$/);
    }
  });

  it("uses UTF-8 byte length, not JavaScript character count, for the 1,500-byte limit", async () => {
    const exactlyLimit = "\u00e9".repeat(750);
    const overLimit = "\u00e9".repeat(751);

    await expect(appliedKeyDocumentId(exactlyLimit)).resolves.toBe(exactlyLimit);
    await expect(appliedKeyDocumentId(overLimit)).resolves.toMatch(/^h2_[0-9a-f]{64}$/);
  });

  it("does not collapse distinct unsafe keys", async () => {
    const [a, b] = await Promise.all([
      appliedKeyDocumentId("product/245/55R19"),
      appliedKeyDocumentId("product/245/55R20"),
    ]);
    expect(a).not.toBe(b);
  });

  it("hashes payloads deterministically regardless of object key order", async () => {
    const first = await canonicalPayloadHash({
      id: "product-1",
      nested: { width: 245, codes: ["012345678905", "4019238012345"] },
      verified: false,
    });
    const reordered = await canonicalPayloadHash({
      verified: false,
      nested: { codes: ["012345678905", "4019238012345"], width: 245 },
      id: "product-1",
    });
    const changed = await canonicalPayloadHash({
      id: "product-1",
      nested: { width: 255, codes: ["012345678905", "4019238012345"] },
      verified: false,
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("rejects malformed entity and payload IDs with stable error codes", () => {
    expect(validatePendingSyncItem(productItem({ entityId: "product/1" }))).toMatchObject({
      errorCode: "invalid_entity_id",
    });

    expect(
      validatePendingSyncItem(
        productItem({
          payload: { id: "other-product", businessId: "business-1", name: "Wrong entity" },
        }),
      ),
    ).toMatchObject({ errorCode: "payload_entity_mismatch" });

    expect(
      validatePendingSyncItem(
        productItem({
          payload: { id: "product-1", businessId: "business-2", name: "Wrong tenant" },
        }),
      ),
    ).toMatchObject({ errorCode: "payload_business_mismatch" });
  });

  it("returns the structured validation error before touching Firestore", async () => {
    const target = new FirebaseSyncTarget({} as Firestore, { emulator: true });
    const result = await target.apply(productItem({ entityId: "product/1" }));

    expect(result).toMatchObject({
      ok: false,
      alreadyApplied: false,
      errorCode: "invalid_entity_id",
    });
    expect(result.error).toMatch(/^invalid_entity_id:/);
  });

  it("accepts a valid product write even when its display data contains tire-size slashes", () => {
    expect(validatePendingSyncItem(productItem())).toBeNull();
  });

  it("requires scan-event and session payload envelopes to match their queue item", () => {
    const event = productItem({
      entityType: "ScanEvent",
      entityId: "event-1",
      operation: "SAVE_SCAN_EVENT",
      scanEventId: "event-1",
      payload: {
        id: "event-1",
        businessId: "business-1",
        sessionId: "other-session",
      },
    });
    expect(validatePendingSyncItem(event)).toMatchObject({ errorCode: "payload_session_mismatch" });

    const session = productItem({
      entityType: "CountSession",
      entityId: "session-2",
      operation: "SAVE_SESSION",
      payload: {
        id: "session-2",
        businessId: "business-1",
        status: "active",
      },
    });
    expect(validatePendingSyncItem(session)).toMatchObject({ errorCode: "payload_session_mismatch" });
  });

  it("requires unknown-review session metadata to match the queue envelope", () => {
    const unknown = productItem({
      entityType: "UnknownCodeReview",
      entityId: "review-1",
      operation: "SAVE_UNKNOWN_SCAN",
      scanEventId: "event-1",
      payload: {
        id: "review-1",
        businessId: "business-1",
        sessionId: "other-session",
        scanEventId: "event-1",
      },
    });
    expect(validatePendingSyncItem(unknown)).toMatchObject({ errorCode: "payload_session_mismatch" });

    expect(
      validatePendingSyncItem({
        ...unknown,
        payload: {
          ...(unknown.payload as Record<string, unknown>),
          sessionId: "session-1",
          scanEventId: "other-event",
        },
      }),
    ).toMatchObject({ errorCode: "payload_scan_event_mismatch" });
  });

  it("accepts nonzero integer count deltas, including transfer corrections, and rejects malformed deltas", () => {
    const increment = (quantityDelta: number): PendingSyncItem =>
      productItem({
        entityType: "InventoryCount",
        entityId: "session-1_product-1",
        operation: "INCREMENT_COUNT",
        scanEventId: "event-1",
        idempotencyKey: "business-1:session-1:event-1:INCREMENT_COUNT",
        payload: {
          businessId: "business-1",
          sessionId: "session-1",
          productId: "product-1",
          scanEventId: "event-1",
          quantityDelta,
          idempotencyKey: "business-1:session-1:event-1:INCREMENT_COUNT",
        },
      });

    expect(validatePendingSyncItem(increment(1))).toBeNull();
    expect(validatePendingSyncItem(increment(7))).toBeNull();
    expect(validatePendingSyncItem(increment(-7))).toBeNull();
    for (const invalid of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(validatePendingSyncItem(increment(invalid))).toMatchObject({
        errorCode: "invalid_quantity_delta",
      });
    }
  });
});
