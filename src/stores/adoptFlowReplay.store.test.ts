import { describe, it, expect } from "vitest";
import { migrateLegacyBlobOnce, persistKeyForUid } from "./scanPersistNamespace";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

// Sums feed deltas per product, the same invariant P1's ledger tooling asserts.
function quantitiesByProduct(feed: Array<{ productId?: string; quantityDelta?: number }>) {
  const out: Record<string, number> = {};
  for (const r of feed) {
    if (!r.productId) continue;
    out[r.productId] = (out[r.productId] ?? 0) + (r.quantityDelta === 0 ? 1 : r.quantityDelta ?? 1);
  }
  return out;
}

describe("adopt-flow replay: owner data intact after the owner-initiated adopt", () => {
  it("per-product quantities identical before/after; legacy blob consumed", () => {
    const s = new MemStorage();
    const legacyFeed = [
      { id: "e1", productId: "p1", quantityDelta: 1 },
      { id: "e2", productId: "p1", quantityDelta: 1 },
      { id: "e3", productId: "p2", quantityDelta: 3 },
      { id: "e4", productId: "p2", quantityDelta: 0 }, // pre-D1 ghost -> normalizes to 1
    ];
    s.setItem("sis-scan-v1", JSON.stringify({ state: { scanFeed: legacyFeed, businessId: "b1" }, version: 8 }));

    const before = quantitiesByProduct(legacyFeed); // p1:2, p2:4 (0 counted as 1 by the invariant helper)
    migrateLegacyBlobOnce("owner-uid", s as unknown as Storage);
    const migrated = JSON.parse(s.getItem(persistKeyForUid("owner-uid"))!).state.scanFeed;
    const after = quantitiesByProduct(migrated);

    expect(after).toEqual(before);
    expect(after.p1).toBe(2);
    expect(after.p2).toBe(4);
    expect(s.getItem("sis-scan-v1")).toBeNull(); // adopt CONSUMES the legacy blob (no double-inherit)
  });
});
