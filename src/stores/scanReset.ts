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
  firstScanAt: string | null;
} {
  // C2: firstScanAt is per-tenant first-run state (drives the /scan empty-state banner), so a business
  // switch or sign-out must reset it to null exactly like scanFeed/finalCounts - otherwise a brand new
  // tenant would inherit the PREVIOUS tenant's "already scanned" flag and never see the banner.
  return { scanFeed: [], finalCounts: [], needsReviewQueue: [], settings: { ...DEFAULT_SETTINGS }, firstScanAt: null };
}
