import { describe, it, expect } from "vitest";
import { createTestScanStore, scanStoreMigrate } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import {
  buildPersistedScanState,
  persistAccessLevel,
  type PersistableScanState,
} from "@/stores/scanPersist";

// QA Task 6 regression: the no-login / open-access LOCAL runtime is the OWNER'S OWN device (there is no
// cloud backend and no signed-in customer). Persist stripping must NOT run there, or the owner's own
// data - CSV-imported products, their approved aliases, and human-taught aliases - is silently destroyed
// on every page reload (aliases dropped entirely + product barcode identifiers sanitized away by the
// "business" customer split), turning a previously-KNOWN scan into an unknown after refresh.
//
// The fix is an EXPLICIT local-mode flag: with no cloud backend configured, persistAccessLevel(null)
// resolves to the full "platform" persistence shape (platform-equivalent), so aliases + barcodes survive.
// The FORBIDDEN_KEYS contract (scanPersist.test.ts) still holds for a genuine signed-in customer role,
// which passes an explicit "business" level - that stripping is unchanged.

// A single-product CSV the owner uploads on their own machine. The barcode is what they later scan.
const CSV = [
  "name,brand,category,barcode,sku",
  "Owner Widget 9000,OwnerBrand,Hardware,700123456789,OWN-9000",
].join("\n");
const IMPORTED_BARCODE = "700123456789";

/**
 * Faithful reload: build the persisted localStorage blob at the level the REAL persist split would use
 * (persistAccessLevel from the current userId - null on the local/mock path), JSON round-trip it exactly
 * like localStorage, run it through the store's migrate step, then merge it over a FRESH store the same
 * shallow way zustand's default merge (onRehydrateStorage) does. This is the true "close the tab, reopen"
 * path - NOT a hard-coded "business" level.
 */
function reloadLikeLocalRuntime(source: ReturnType<typeof createTestScanStore>) {
  const s = source.getState() as unknown as PersistableScanState;
  const level = persistAccessLevel(s.userId); // <- the code path under test (userId is null locally)
  const persisted = buildPersistedScanState(s, level);
  const roundTripped = JSON.parse(JSON.stringify(persisted));
  const migrated = scanStoreMigrate(roundTripped, 7) as Record<string, unknown>;

  const fresh = createTestScanStore({ db: new MockDb() });
  fresh.setState((prev) => ({ ...prev, ...migrated }));
  return fresh;
}

describe("QA Task 6 - local (no-login) runtime keeps owner data across reload", () => {
  it("CSV-imported product still resolves KNOWN after a real reload (aliases + barcodes survive)", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // Owner imports their catalog, then scans the imported barcode -> deterministic KNOWN + counted.
    const summary = store.getState().importProductsCsv(CSV);
    expect(summary.productsCreated).toBe(1);
    expect(summary.aliasesCreated).toBeGreaterThan(0);

    const before = store.getState().processScan(IMPORTED_BARCODE);
    expect(before?.status, "imported barcode resolves KNOWN before reload").toBe("known");

    // Reload through the ACTUAL local-runtime persist path.
    const reloaded = reloadLikeLocalRuntime(store);

    // The imported product + its approved alias must survive the reload.
    expect(
      reloaded.getState().products.some((p) => p.name === "Owner Widget 9000"),
      "imported product survives reload",
    ).toBe(true);

    // Scanning the same barcode again after reload MUST still be KNOWN (this is the failing assertion
    // before the fix: aliases were dropped + the product's barcode was stripped, so it went unknown).
    const after = reloaded.getState().processScan(IMPORTED_BARCODE);
    expect(after?.status, "imported barcode STILL resolves KNOWN after reload").toBe("known");
  });

  it("a human-taught alias (resolveUnknown -> create_new) survives reload and resolves KNOWN", () => {
    const store = createTestScanStore({ db: new MockDb() });

    const UNKNOWN = "612340009999";
    store.getState().processScan(UNKNOWN);
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === UNKNOWN && r.status === "open");
    expect(review, "unknown scan created an open review").toBeDefined();

    // Owner teaches the mapping: this permanently creates a verified product + approved alias.
    store.getState().resolveUnknown(review!.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Owner Taught Item" },
    });
    const taughtBefore = store.getState().processScan(UNKNOWN);
    expect(taughtBefore?.status, "taught code resolves KNOWN before reload").toBe("known");

    const reloaded = reloadLikeLocalRuntime(store);

    const taughtAfter = reloaded.getState().processScan(UNKNOWN);
    expect(taughtAfter?.status, "taught code STILL resolves KNOWN after reload").toBe("known");
  });
});
