import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import { getMockDb } from "@/sync-database/mock/mockDb";

// QA finding #16 (critical): the /scan page bricked once accumulated scans pushed localStorage
// near its ~5MB quota - scanStore persisted with a plain createJSONStorage(() => localStorage)
// whose setItem THREW QuotaExceededError synchronously out of set() inside processScan, and every
// subsequent scan re-threw (fresh tab still broken until localStorage cleared). TOP-LEVEL LAW: a
// persist failure must NEVER throw out of processScan and must NEVER roll back the optimistic scan
// (the scan must still appear + count). This drives the REAL persisting store to prove that.

const KNOWN_CODE = "6419440485331"; // seed Nokian tire barcode (deterministic known match)

beforeEach(() => {
  getMockDb().reset();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanStore persist brick (finding #16) - quota fail-soft", () => {
  it("processScan does NOT throw when localStorage.setItem throws QuotaExceededError, and the scan still counts", () => {
    // jsdom's Storage#setItem lives on the prototype; spy there so the real write path is exercised
    // (same technique reconcileStore.test.ts uses for its own quota fail-soft test).
    const proto = Object.getPrototypeOf(window.localStorage);
    const setItemSpy = vi.spyOn(proto, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const before = useScanStore
        .getState()
        .finalCounts.find((c) => c.productId === "prod-nokian")?.quantity ?? 0;

      // On the UNGUARDED code this throws out of set() inside processScan -> the brick. It must not.
      let ev: ReturnType<typeof useScanStore.getState>["processScan"] extends (i: string) => infer R ? R : never;
      expect(() => {
        ev = useScanStore.getState().processScan(KNOWN_CODE);
      }).not.toThrow();

      const st = useScanStore.getState();
      // The optimistic in-memory scan survived even though persistence failed (LAW).
      expect(st.scanFeed.some((e) => e.rawCode === KNOWN_CODE)).toBe(true);
      const after = st.finalCounts.find((c) => c.productId === "prod-nokian")?.quantity ?? 0;
      expect(after).toBe(before + 1);
      // The write is COALESCED (deferred one tick), so force it out synchronously the same way a page
      // close would (pagehide flush) - the quota failure is then LOGGED (never thrown), not silently
      // swallowed. The point of the mitigation is that this failure degrades to a warning, not a brick.
      window.dispatchEvent(new Event("pagehide"));
      expect(warn).toHaveBeenCalled();

      // A SECOND scan must also not throw (the original brick re-threw on every subsequent scan).
      expect(() => useScanStore.getState().processScan(KNOWN_CODE)).not.toThrow();
      const after2 = useScanStore
        .getState()
        .finalCounts.find((c) => c.productId === "prod-nokian")?.quantity ?? 0;
      expect(after2).toBe(before + 2);
    } finally {
      setItemSpy.mockRestore();
    }
  });
});
