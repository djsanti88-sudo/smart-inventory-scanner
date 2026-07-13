import { describe, it, expect } from "vitest";
import { createTestScanStore, scanStoreMigrate } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import type { InventoryCount, Product } from "@/types";

// SDD Task 3.5: count snapshots + variance report - store additions.
// snapshotCount(label) builds a CountSnapshot from the CURRENT finalCounts, prepends it to
// countSnapshots, caps the array at 12 (oldest evicted), and returns the created snapshot.

function product(over: Partial<Product> & { id: string; name: string }): Product {
  return {
    businessId: "b1", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

function count(over: Partial<InventoryCount> & { id: string; productId: string; quantity: number }): InventoryCount {
  return {
    businessId: "b1", sessionId: "s1", lastScannedAt: "t", aliasesSeen: [], scanEventIds: [],
    createdAt: "t", updatedAt: "t", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
    ...over,
  };
}

describe("snapshotCount", () => {
  it("captures the current finalCounts as a CountSnapshot with id/label/takenAt/lines", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({
      products: [product({ id: "p1", name: "Widget" }), product({ id: "p2", name: "Gadget" })],
      finalCounts: [
        count({ id: "c1", productId: "p1", quantity: 5 }),
        count({ id: "c2", productId: "p2", quantity: 2 }),
      ],
    });

    const snap = store.getState().snapshotCount("Morning count");

    expect(snap.label).toBe("Morning count");
    expect(snap.id).toBeTruthy();
    expect(snap.takenAt).toBe("2026-06-12T10:00:00.000Z"); // createTestScanStore's fixed `now`
    expect(snap.lines).toEqual(
      expect.arrayContaining([
        { productId: "p1", name: "Widget", qty: 5 },
        { productId: "p2", name: "Gadget", qty: 2 },
      ]),
    );
    expect(snap.lines).toHaveLength(2);
  });

  it("returns the created snapshot and also appends it to countSnapshots", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({
      products: [product({ id: "p1", name: "Widget" })],
      finalCounts: [count({ id: "c1", productId: "p1", quantity: 1 })],
    });

    const snap = store.getState().snapshotCount("First");
    expect(store.getState().countSnapshots).toHaveLength(1);
    expect(store.getState().countSnapshots[0]).toEqual(snap);
  });

  it("caps countSnapshots at 12, evicting the oldest first", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({
      products: [product({ id: "p1", name: "Widget" })],
      finalCounts: [count({ id: "c1", productId: "p1", quantity: 1 })],
    });

    for (let i = 1; i <= 13; i++) {
      store.getState().snapshotCount(`Snapshot ${i}`);
    }

    const snapshots = store.getState().countSnapshots;
    expect(snapshots).toHaveLength(12);
    // Oldest (Snapshot 1) evicted; newest (Snapshot 13) kept, most-recent-last (append order, same
    // convention as appendFeedback's ring buffer).
    expect(snapshots.map((s) => s.label)).not.toContain("Snapshot 1");
    expect(snapshots[snapshots.length - 1].label).toBe("Snapshot 13");
    expect(snapshots[0].label).toBe("Snapshot 2");
  });
});

describe("countSnapshots persistence", () => {
  it("is included in the persisted (platform) state", () => {
    const base: PersistableScanState = {
      userId: "owner-1",
      businessId: "b1",
      sessionId: "s1",
      currentSession: null,
      settings: {},
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      simulateSyncFailure: false,
      products: [],
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      lastCleanupBackup: null,
      catalog: [],
      shopOverrides: [],
      feedbackEvents: [],
      countSnapshots: [
        { id: "snap-1", label: "Morning", takenAt: "t", lines: [{ productId: "p1", name: "Widget", qty: 5 }] },
      ],
    };
    const persisted = buildPersistedScanState(base, "platform");
    expect(persisted.countSnapshots).toEqual(base.countSnapshots);
  });

  it("round-trips through JSON serialize/parse (simulated reload)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({
      products: [product({ id: "p1", name: "Widget" })],
      finalCounts: [count({ id: "c1", productId: "p1", quantity: 4 })],
    });
    store.getState().snapshotCount("Before reload");

    const persisted = buildPersistedScanState(
      store.getState() as unknown as PersistableScanState,
      "platform",
    );
    const rehydrated = JSON.parse(JSON.stringify(persisted)) as { countSnapshots: unknown[] };
    expect(rehydrated.countSnapshots).toHaveLength(1);
    expect((rehydrated.countSnapshots[0] as { label: string }).label).toBe("Before reload");
  });
});

describe("scanStoreMigrate defaults countSnapshots to [] for pre-existing persisted state", () => {
  it("v5 persisted blob (no countSnapshots field) migrates to an empty array", () => {
    const persistedV5 = {
      products: [],
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
    };
    const migrated = scanStoreMigrate(persistedV5, 5) as unknown as { countSnapshots: unknown[] };
    expect(migrated.countSnapshots).toEqual([]);
  });

  it("v6 persisted blob (also predates countSnapshots) migrates to an empty array", () => {
    const persistedV6 = {
      products: [],
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
    };
    const migrated = scanStoreMigrate(persistedV6, 6) as unknown as { countSnapshots: unknown[] };
    expect(migrated.countSnapshots).toEqual([]);
  });

  it("preserves an existing countSnapshots array untouched (already-migrated v7 install)", () => {
    const existing = [{ id: "keep-me", label: "Keep", takenAt: "t", lines: [] }];
    const persistedV7 = {
      products: [],
      aliases: [],
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      countSnapshots: existing,
    };
    const migrated = scanStoreMigrate(persistedV7, 7) as unknown as { countSnapshots: unknown[] };
    expect(migrated.countSnapshots).toEqual(existing);
  });
});
