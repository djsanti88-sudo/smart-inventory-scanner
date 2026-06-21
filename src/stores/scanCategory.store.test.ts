import { describe, it, expect } from "vitest";
import { createTestScanStore, DEFAULT_SETTINGS } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Phase 9: the app defaults to Tires (firewall on out of the box), and a blocked scan drives the
// dismissible scan-page warning banner via lastCategoryWarning.
describe("Phase 9 scan category default + warning banner state", () => {
  it("production DEFAULT_SETTINGS.scanContext is 'tire' (protected with no setup)", () => {
    expect(DEFAULT_SETTINGS.scanContext).toBe("tire");
  });

  it("deterministic non-tire match in tire context: not counted + sets lastCategoryWarning", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const ev = store.getState().processScan("049000028904"); // seeded Coca-Cola (non-tire), approved alias
    expect(ev?.status).not.toBe("known"); // blocked by the category firewall
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-coke")).toBe(false);
    const w = store.getState().lastCategoryWarning;
    expect(w).not.toBeNull();
    expect(w?.code).toBe("049000028904");
    expect(w?.productName).toBeTruthy();
    expect(w?.reason).toBe("category_context_conflict");
  });

  it("clearCategoryWarning() dismisses the banner state", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    store.getState().processScan("049000028904");
    expect(store.getState().lastCategoryWarning).not.toBeNull();
    store.getState().clearCategoryWarning();
    expect(store.getState().lastCategoryWarning).toBeNull();
  });

  it("switching to 'any' context lets the same code count again (selector live-changes behavior)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    store.getState().processScan("049000028904");
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-coke")).toBe(false);
    store.getState().updateSettings({ scanContext: "any" }); // what the scan-page selector / banner action does
    const ev = store.getState().processScan("049000028904");
    expect(ev?.status).toBe("known");
    expect(store.getState().finalCounts.some((c) => c.productId === "prod-coke")).toBe(true);
  });
});
