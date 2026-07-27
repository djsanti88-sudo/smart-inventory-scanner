import { DEFAULT_SETTINGS } from "@/stores/scanStore";
import type { SessionHistoryEntry } from "@/services/sessions/sessionHistory";
import type { CountSnapshot } from "@/services/reports/varianceReport";
import type {
  Alias,
  InventorySession,
  Product,
  ScanEvent,
  InventoryCount,
  UnknownCodeReview,
  Settings,
} from "@/types";

// Tenant-scoped state that must be fully REPLACED (never merged) when the active business/user
// changes: loadBusinessData() does NOT return settings/needsReviewQueue/scanFeed, and finalCounts
// linger when no session restores. Used by setBusinessContext (switch) and resetForSignOut (Task 8).
// Keeps two-users-one-browser AND one-user-two-businesses isolation honest.
export function emptyTenantState(): {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  currentSession: InventorySession | null;
  sessionId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  countSnapshots: CountSnapshot[];
  settings: Settings;
  firstScanAt: string | null;
  recentLocations: string[];
  sessionHistory: SessionHistoryEntry[];
} {
  // C2: firstScanAt is per-tenant first-run state (drives the /scan empty-state banner), so a business
  // switch or sign-out must reset it to null exactly like scanFeed/finalCounts - otherwise a brand new
  // tenant would inherit the PREVIOUS tenant's "already scanned" flag and never see the banner.
  // recentLocations is documented per-business (scanStore.ts:611) - a business switch/sign-out must
  // reset it too, or the previous tenant's location strings leak into the new workspace's location
  // picker.
  // sessionHistory is the tenant's own archived scan log (codes + product names) - a business switch
  // or sign-out must reset it exactly like scanFeed, or the previous tenant's scanned codes leak into
  // the next tenant's History page.
  return {
    products: [],
    aliases: [],
    sessions: [],
    currentSession: null,
    sessionId: "",
    scanFeed: [],
    finalCounts: [],
    needsReviewQueue: [],
    countSnapshots: [],
    settings: { ...DEFAULT_SETTINGS },
    firstScanAt: null,
    recentLocations: [],
    sessionHistory: [],
  };
}
