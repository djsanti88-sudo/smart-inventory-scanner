import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { detectCodeType } from "@/services/codeTypeDetector";
import { decodeBarcodeStructure } from "@/services/ai/barcodeAnatomy";
import { prefixFloorName } from "@/services/catalog/prefixFloor";

// Drift-risk regression (see refactor(resolve): failed-decode placeholder uses shared
// provisionalPlaceholderName): liveDecode's failed-decode branch (scanStore.ts ~2311-2317) used to
// hand-inline the SAME logic as the module-private `provisionalPlaceholderName` helper that
// ensureProvisionalCount and resolveUnknown's reload-resilient fallback already share. Byte-identical
// today, but a future edit to either copy alone would silently break resolveUnknown's post-reload
// merge for codes whose ONLY provisional mint path is a failed live decode (network error / timeout /
// provider down), re-introducing the orphaned-count bug for that path specifically.
//
// This suite drives the REAL failed-decode path (mocked fetch throws, exactly like
// autoDecode.test.ts's "live decode failure" case) and asserts the minted placeholder's name is
// EXACTLY what the shared helper would produce for the same code - computed here via the same two
// public building blocks the helper composes (detectCodeType + decodeBarcodeStructure +
// prefixFloorName), never by importing the store-private helper itself. It also proves the
// reload-resilient merge in resolveUnknown still works for a placeholder minted via this path.

function expectedPlaceholderName(code: string): string {
  const ct = detectCodeType(code);
  const struct = decodeBarcodeStructure(code, ct);
  const floor = prefixFloorName(code, ct);
  return floor ? floor.name : struct.checkDigitValid ? `Unidentified item (barcode ${code})` : `Unidentified item (code ${code})`;
}

function failStub() {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { spy, restore: () => (globalThis.fetch = original) };
}

function aggressiveStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

function totalQty(store: ReturnType<typeof aggressiveStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

function rehydrateAsCustomer(store: ReturnType<typeof aggressiveStore>) {
  const s = store.getState();
  const persisted = buildPersistedScanState(s as unknown as PersistableScanState, "business");
  const rehydrated = JSON.parse(JSON.stringify(persisted));
  store.setState((prev) => ({ ...prev, ...rehydrated }));
}

describe("failed-decode placeholder mint matches the shared provisionalPlaceholderName helper", () => {
  it("a bare-fallback code (no prefix-floor hit) gets the exact shared-helper name after a failed live decode", async () => {
    const store = aggressiveStore();
    const code = "878106003504"; // valid UPC-A, no known GS1 prefix mapping
    const { restore } = failStub();
    try {
      store.getState().processScan(code);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.primaryBarcode === code);
    expect(prod, "a provisional product must exist for the failed-decode code").toBeDefined();
    expect(prod!.name).toBe(expectedPlaceholderName(code));
    expect(prod!.name).toBe("Unidentified item (barcode 878106003504)");
    expect(prod!.provisional).toBe(true);
  });

  it("a prefix-floor-hit code gets the shared-helper's brand-guess name (not the bare fallback) after a failed live decode", async () => {
    const store = aggressiveStore();
    const code = "051596000004"; // valid UPC-A, seed prefix maps to United Solutions
    const { restore } = failStub();
    try {
      store.getState().processScan(code);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"));
    } finally {
      restore();
    }
    const prod = store.getState().products.find((p) => p.primaryBarcode === code);
    expect(prod, "a provisional product must exist for the failed-decode code").toBeDefined();
    expect(prod!.name).toBe(expectedPlaceholderName(code));
    expect(prod!.name).toBe("United Solutions / product unconfirmed");
    expect(prod!.brand).toBe("United Solutions");
  });

  it("reload-resilient merge: resolveUnknown(create_new) after a real customer reload merges a placeholder minted via the FAILED-DECODE path", async () => {
    const store = aggressiveStore();
    const code = "878106003504";
    const { restore } = failStub();
    try {
      store.getState().processScan(code);
      await vi.waitFor(() => expect(store.getState().needsReviewQueue.at(-1)?.decodeStatus).toBe("needs_review"));
    } finally {
      restore();
    }
    expect(totalQty(store), "the failed-decode placeholder is provisionally counted before reload").toBe(1);

    // Real full reload: round-trip through the customer ("business") persist split, which strips the
    // provisional flag and identifier fields (primaryBarcode/gtin/upc/ean/primarySku) - the exact
    // condition that requires resolveUnknown's name-based fallback to re-identify this row.
    rehydrateAsCustomer(store);
    expect(totalQty(store), "reload must not lose the provisional count").toBe(1);

    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open");
    expect(review, "the review for the failed-decode code survives reload").toBeDefined();

    store.getState().resolveUnknown(review!.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Resolved After Failed Decode" },
    });

    const named = store.getState().products.find((p) => p.name === "Resolved After Failed Decode" && p.status !== "archived");
    expect(named, "the newly named product exists").toBeDefined();

    const namedQty = store.getState().finalCounts.find((c) => c.productId === named!.id)?.quantity ?? 0;
    expect(namedQty, "the resolved code's provisional qty (1) was preserved onto the named product, not lost or doubled").toBe(1);
    expect(totalQty(store), "resolving must not change the total counted quantity").toBe(1);

    const staleUnidentifiedRow = store.getState().products.find(
      (p) => p.status !== "archived" && p.name.includes("Unidentified item") && store.getState().finalCounts.some((c) => c.productId === p.id) && p.id !== named!.id,
    );
    expect(staleUnidentifiedRow, "no orphaned leftover placeholder row remains alongside the named product").toBeUndefined();
  });
});
