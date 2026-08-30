// Private, local feedback/event log - the "smarter over time" substrate. Stays shop-scoped and is
// NEVER part of the global catalog (privacy rule). Pure + capped (ring buffer) to protect localStorage.

export type FeedbackEventType =
  | "barcode_scanned"
  | "found_from_catalog"
  | "found_from_override"
  | "found_from_ai"
  | "product_approved"
  | "product_rejected"
  | "product_name_edited"
  | "alias_linked"
  | "alias_removed"
  | "marked_junk"
  | "ran_cleanup"
  | "restored_cleanup"
  | "conflict_detected"
  | "source_confirmed"
  | "source_rejected"
  | "auto_verified_catalog_entry"
  | "catalog_candidate_blocked"
  | "trusted_source_match";

export interface FeedbackEvent {
  id: string;
  businessId: string;
  type: FeedbackEventType;
  code: string;
  productId: string | null;
  at: string;
  meta?: Record<string, string | number | boolean>;
}

export const FEEDBACK_EVENT_CAP = 500;

/** Append an event, keeping only the most recent FEEDBACK_EVENT_CAP (oldest dropped). Pure. */
export function appendFeedback(
  events: FeedbackEvent[],
  event: FeedbackEvent,
  cap: number = FEEDBACK_EVENT_CAP,
): FeedbackEvent[] {
  const next = [...events, event];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
