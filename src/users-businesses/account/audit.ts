import type { AuditEvent } from "@/sync-database/types";

// Audit-event substrate. Pure + framework-free (no React / next / firebase imports) so it is unit-
// testable in the node vitest project. The store emits AuditEventInput through an injectable sink
// (cloud -> auditRepository.append, fire-and-forget). An audit write must NEVER block or break the
// scanner: the sink swallows its own errors, and the store guards the call in try/catch.

/** What a caller knows at the action site. businessId/actorUserId come from the real signed-in context. */
export interface AuditEventInput {
  businessId: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  metadata?: Record<string, unknown>;
}

/**
 * Assemble a persistable AuditEvent doc from an input + a fresh id. createdAt is set server-side.
 * Omits undefined fields entirely: Firestore's setDoc rejects `undefined` field values, so optional
 * metadata / a null actor must not be written as `undefined`.
 */
export function toAuditEvent(input: AuditEventInput, id: string): AuditEvent {
  const event: AuditEvent = {
    id,
    businessId: input.businessId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
  };
  if (input.actorUserId) event.actorUserId = input.actorUserId;
  if (input.metadata !== undefined) event.metadata = input.metadata;
  return event;
}
