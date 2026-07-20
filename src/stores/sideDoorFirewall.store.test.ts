import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Phase 8C - the scan-context firewall must guard the DETERMINISTIC count path, not just the AI decode
// path. The seed includes verified products + approved aliases: prod-coke ("Coca-Cola 12 pack...", UPC
// 049000028904 - a clearly non-tire item) and prod-nokian (a real tire). The poisoned-identity scenario
// is simulated by scanning the verified non-tire product while the business scan context is "tire" -
// exactly the side door the AI-only firewall used to miss.

function countFor(store: ReturnType<typeof createTestScanStore>, productId: string) {
  return store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;
}

describe("Phase 8C side-door firewall - deterministic count path", () => {
  it("does NOT count a non-tire deterministic match in TIRE context; routes to Needs Review", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });

    // Verified seed product (Coca-Cola) matched deterministically - would have counted before Phase 8C.
    const ev = store.getState().processScan("049000028904");

    expect(countFor(store, "prod-coke")).toBe(0); // blocked - not counted
    expect(ev?.status).toBe("needs_review");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "049000028904");
    expect(review?.status).toBe("open");
    expect(review?.reason ?? "").toMatch(/category conflict/i);
  });

  it("still counts the SAME product in ANY (default) context - the firewall is opt-in to tire", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const ev = store.getState().processScan("049000028904");
    expect(ev?.status).toBe("known");
    expect(countFor(store, "prod-coke")).toBe(1);
  });

  it("still counts a real tire in TIRE context (no false block)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });
    const ev = store.getState().processScan("T432119"); // Nokian Outpost APT
    expect(ev?.status).toBe("known");
    expect(countFor(store, "prod-nokian")).toBe(1);
  });

  it("FIX 2 (scan N = count N): a known-but-context-conflicted scan STILL counts provisionally + review stays open", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ scanContext: "tire" });

    // Verified Coca-Cola matched deterministically but blocked by the tire firewall.
    store.getState().processScan("049000028904");

    // The SUSPECT/poisoned product is never counted...
    expect(countFor(store, "prod-coke")).toBe(0);
    // ...but the physical scan is NOT lost: it counts once against a SAFE provisional placeholder.
    const totalCounted = store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
    expect(totalCounted, "the scan counts exactly once (owner rule scan N = count N)").toBe(1);
    const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "049000028904");
    expect(placeholder, "a safe placeholder holds the count").toBeDefined();
    // PREFIX FLOOR (Plan C Task 3): 049000028904's GS1 prefix (0049000) resolves to a known brand
    // (Coca-Cola) in the derived catalog, so the placeholder states the brand with confidence instead
    // of a bare "Unidentified item" - it still never claims the specific SUSPECT product identity, and
    // stays unverified.
    expect(placeholder!.name).toBe("Coca-Cola / product unconfirmed");
    expect(placeholder!.brand).toBe("Coca-Cola");
    expect(countFor(store, placeholder!.id)).toBe(1);
    expect(placeholder!.verified).toBe(false);

    // The review is still open with the suspect identity surfaced for a human to confirm.
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "049000028904");
    expect(review?.status).toBe("open");
  });
});

describe("Phase 8C markWrong - clears verified identity so it cannot re-match", () => {
  it("un-verifies the wrong product; a re-scan of the same code does NOT deterministically re-count it", async () => {
    const store = createTestScanStore({ db: new MockDb() });

    // 1. Count it the normal way (default context).
    store.getState().processScan("049000028904");
    expect(countFor(store, "prod-coke")).toBe(1);

    // 2. Owner marks it wrong.
    await store.getState().markWrong("prod-coke", { reason: "test-wrong" });

    // 3. The product is now un-verified and the session count is gone.
    expect(store.getState().products.find((p) => p.id === "prod-coke")?.verified).toBe(false);
    expect(countFor(store, "prod-coke")).toBe(0);

    // 4. Re-scanning the same barcode must NOT re-match DETERMINISTICALLY to the wrong product: the
    //    approved alias was deactivated AND the product was un-verified, so matchProductByIdentifiers
    //    can no longer hit prod-coke. Without the Phase 8C un-verify, the verified product's
    //    primaryBarcode would re-match prod-coke directly and re-count against it.
    //    D2 (markWrong quantity transfer) means the first markWrong call already moved the physical
    //    quantity onto a new "Unidentified item" provisional keyed by this same code (never destroyed -
    //    see markWrongTransfer.store.test.ts), so this second scan legitimately counts again, but
    //    against that SAFE provisional, never against prod-coke.
    const ev = store.getState().processScan("049000028904");
    expect(countFor(store, "prod-coke"), "the wrong product itself never re-counts").toBe(0);
    expect(ev?.matchedProductId).not.toBe("prod-coke");
    const provisional = store.getState().products.find(
      (p) => p.provisional === true && p.primaryBarcode === "049000028904",
    );
    expect(provisional, "the transfer provisional exists and is unverified").toBeDefined();
    expect(provisional!.verified).toBe(false);
    expect(ev?.matchedProductId).toBe(provisional!.id);
  });
});
