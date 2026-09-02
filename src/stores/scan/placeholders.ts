import type { InventoryCount } from "@/types";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { decodeBarcodeStructure } from "@/decoding/barcodeAnatomy";
import { prefixFloorName } from "@/products/catalog/prefixFloor";

/**
 * The exact SAME safe, non-hallucinated placeholder label `ensureProvisionalCount` mints for an
 * unresolved code ("Unidentified item (barcode/code CODE)", or a prefix-floor brand guess when the GS1
 * prefix maps to a known brand). Pure function of the code alone, so it can be recomputed later purely
 * from `review.cleanCode` - used as a reload-resilient fallback to re-identify a scan's own provisional
 * placeholder product when its `provisional` flag and identifier fields (primaryBarcode/gtin/upc/ean/
 * primarySku) were stripped by the customer-role localStorage split (buildPersistedScanState /
 * CUSTOMER_SAFE_PRODUCT_FIELDS never persists those product-identity fields to a customer's disk).
 */
// F5 bundle-surgery: productIds with an /api/prefix-floor enrichment round-trip currently in flight.
// Module-level (not store state - transient network bookkeeping, never persisted): multiple call sites
// can request enrichment for the same freshly minted row in one scan flow; only one fetch ever fires.
const enrichInFlight = new Set<string>();

function provisionalPlaceholderName(code: string): string {
  const ct = detectCodeType(code);
  const struct = decodeBarcodeStructure(code, ct);
  const floor = prefixFloorName(code, ct);
  return floor ? floor.name : struct.checkDigitValid ? `Unidentified item (barcode ${code})` : `Unidentified item (code ${code})`;
}

// Rotation-side finalCounts prune (bug #34 residual, read-side counterpart to the pendingSyncQueue
// data-loss fix - see sessionRotationSyncSafety.store.test.ts). Rotation must drop ONLY the
// just-abandoned session's own finalCounts rows (superseded by the sessionHistory archive captured
// synchronously by archiveCurrentSessionIfAny just before this runs), never OTHER past sessions'
// rows a prior refreshFromCloud already merged into this array. A blanket `finalCounts: []` wipes
// those unrelated rows too, disabling/emptying the History page's CSV download for sessions that
// had nothing to do with this rotation until the next refreshFromCloud re-fetches them.
function pruneFinalCountsForRotation(
  finalCounts: InventoryCount[],
  abandonedSessionId: string | null | undefined,
): InventoryCount[] {
  if (!abandonedSessionId) return finalCounts;
  return finalCounts.filter((c) => c.sessionId !== abandonedSessionId);
}
export { enrichInFlight, provisionalPlaceholderName, pruneFinalCountsForRotation };
