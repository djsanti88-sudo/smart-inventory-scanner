import { DEFAULT_SETTINGS } from "@/stores/scanStore";
import type { ScanEvent, InventoryCount, UnknownCodeReview, Settings } from "@/types";

// Tenant-scoped state that must be fully REPLACED (never merged) when the active business/user
// changes: loadBusinessData() does NOT return settings/needsReviewQueue/scanFeed, and finalCounts
// linger when no session restores. Used by setBusinessContext (switch) and resetForSignOut (Task 8).
// Keeps two-users-one-browser AND one-user-two-businesses isolation honest.
export function emptyTenantState(): {
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  settings: Settings;
} {
  return { scanFeed: [], finalCounts: [], needsReviewQueue: [], settings: { ...DEFAULT_SETTINGS } };
}
