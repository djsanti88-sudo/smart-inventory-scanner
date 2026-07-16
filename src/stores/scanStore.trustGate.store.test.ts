import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Barcode trust gate (spec v3 AM-4.2), Task 3: resolveUnknown's two product-identity minting sites
// (fresh mint + provisional upgrade) copy np.gtin/upc/ean VERBATIM from the caller's payload today.
// After this gate, a REJECTED barcode field (bad check digit, placeholder/dummy) is silently blanked
// before it becomes stored identity - the product still mints, the code still aliases and counts, only
// the junk identity FIELD is blanked. The scanned cleanCode alias is never gated (physically scanned).

describe("resolveUnknown gates identity barcode fields (AM-4.2)", () => {
  it("fresh mint: blanks a bad-check-digit gtin and a placeholder ean from the minted product; keeps a valid upc", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("PN-TG-1");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "PN-TG-1" && r.status === "open")!.id;

    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: {
        name: "Trust Gate Tire",
        brand: "Blackhawk",
        gtin: "8848111201762", // WRONG check digit - must be blanked
        upc: "6959655468007", // real, valid check digit - must be kept
        ean: "0000000000000", // placeholder - must be blanked
      },
    });

    const p = store.getState().products.find((x) => x.name === "Trust Gate Tire");
    expect(p).toBeTruthy();
    expect(p!.gtin).toBe("");
    expect(p!.ean).toBe("");
    expect(p!.upc).toBe("6959655468007");
    // The scanned code itself still aliases (physically scanned = its existence is ground truth).
    expect(p!.aliases).toContain("PN-TG-1");
    // The identity still mints and still counts - the gate never blocks the top-level law.
    expect(store.getState().finalCounts.find((c) => c.productId === p!.id)?.quantity).toBe(1);
  });

  it("regression: a fully valid newProduct mints exactly as before", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("PN-TG-2");
    const r2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "PN-TG-2" && r.status === "open")!.id;

    store.getState().resolveUnknown(r2, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Clean Tire", brand: "Nexen", upc: "6959655468007" },
    });

    const p = store.getState().products.find((x) => x.name === "Clean Tire");
    expect(p?.upc).toBe("6959655468007");
    expect(p?.verified).toBe(true);
  });

  it("provisional-upgrade site: processScan mints a provisional placeholder for the code first (scan N = count N), then resolveUnknown upgrades THAT row in place - a placeholder ean on the upgrade payload must still be blanked", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // processScan synchronously mints+counts a provisional placeholder for this still-unresolved code
    // (ensureProvisionalCount) - so the resolveUnknown call below hits the provOrphanId upgrade-in-place
    // branch (scanStore.ts ~3373-3411), not the fresh-mint branch.
    store.getState().processScan("PN-TG-3");
    const before = store.getState().products.find((p) => p.primaryBarcode === "PN-TG-3" || p.aliases.includes("PN-TG-3"));
    expect(before, "a provisional placeholder should already exist for the unresolved code").toBeTruthy();
    expect(before!.provisional).toBe(true);

    const r3 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "PN-TG-3" && r.status === "open")!.id;
    store.getState().resolveUnknown(r3, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: {
        name: "Upgraded Tire",
        brand: "Nexen",
        ean: "1234567890128", // placeholder/dummy (blocklisted) - must be blanked
        upc: "6959655468007", // real, valid check digit - must be kept
      },
    });

    // Same product id: the placeholder was upgraded IN PLACE, not replaced by a second product.
    const upgraded = store.getState().products.find((p) => p.id === before!.id)!;
    expect(upgraded.name).toBe("Upgraded Tire");
    expect(upgraded.provisional).toBe(false);
    expect(upgraded.ean).toBe("");
    expect(upgraded.upc).toBe("6959655468007");
    expect(store.getState().products.filter((p) => p.aliases.includes("PN-TG-3")).length).toBe(1);
  });
});
