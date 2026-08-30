import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// Build 2 / Task 4: the deterministic structurer (src/products/polish/structurer.ts) runs on the
// hot path whenever resolveUnknown mints/upgrades a product via create_new - synchronous, no LLM,
// never blocks a scan. A human correction (correctProduct) permanently stamps structuredBy "human"
// so no later automatic re-structuring pass (hot path or the offline backfill) can overwrite it -
// see structuredFieldsFor's guard, exercised directly in structuredFields.test.ts and
// backfillProducts.test.ts.

describe("scanStore - product structuring on create_new (Task 4)", () => {
  it("a product created via resolveUnknown(create_new) gets deterministic structured fields", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("205551600001");
    const reviewId = store.getState().needsReviewQueue.at(-1)!.id;

    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: {
        name: "Cooper Discoverer AT3 265/70R17",
        brand: "Cooper",
        category: "Tire",
        primaryBarcode: "205551600001",
      },
    });

    const product = store.getState().products.find((p) => p.primaryBarcode === "205551600001")!;
    expect(product, "product was created").toBeDefined();
    expect(product.structuredBrand).toBe("Cooper");
    expect(product.structuredModel).toContain("Discoverer");
    expect(product.sizeTag).toBe("2657017");
    expect(product.structuredBy).toBe("deterministic");
  });

  it("correctProduct (human edit) stamps structuredBy human and mirrors the corrected brand", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("205551600002");
    const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Cooper Discoverer AT3 265/70R17", brand: "Cooper", primaryBarcode: "205551600002" },
    });
    const productId = store.getState().products.find((p) => p.primaryBarcode === "205551600002")!.id;
    expect(store.getState().products.find((p) => p.id === productId)!.structuredBy).toBe("deterministic");

    store.getState().correctProduct(productId, { brand: "Cooper Tires Corrected" });

    const corrected = store.getState().products.find((p) => p.id === productId)!;
    expect(corrected.structuredBy).toBe("human");
    expect(corrected.structuredBrand).toBe("Cooper Tires Corrected");
  });

  it("a human correction locks structuring: only a name/brand edit re-stamps, other edits leave it untouched", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("205551600003");
    const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Placeholder Name", brand: "Placeholder", primaryBarcode: "205551600003" },
    });
    const productId = store.getState().products.find((p) => p.primaryBarcode === "205551600003")!.id;

    // Human corrects the brand (locks structuring for this row going forward).
    store.getState().correctProduct(productId, { name: "Human Chosen Name", brand: "Human Brand" });
    const afterHuman = store.getState().products.find((p) => p.id === productId)!;
    expect(afterHuman.structuredBy).toBe("human");
    expect(afterHuman.structuredBrand).toBe("Human Brand");

    // A later, unrelated edit (location only) must NOT reset or recompute the locked structured fields.
    store.getState().correctProduct(productId, { location: "Aisle 4" });
    const afterLocationEdit = store.getState().products.find((p) => p.id === productId)!;
    expect(afterLocationEdit.structuredBy).toBe("human");
    expect(afterLocationEdit.structuredBrand).toBe("Human Brand");
    expect(afterLocationEdit.location).toBe("Aisle 4");
  });
});

describe("scanStore - structurer containment (Task 4 review fix)", () => {
  it("a structurer throw on create_new never breaks scan flow - the product is still created, just unstructured", async () => {
    vi.resetModules();
    vi.doMock("@/products/polish/structurer", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/products/polish/structurer")>();
      return {
        ...actual,
        structureProduct: () => {
          throw new Error("structurer crashed on this name");
        },
      };
    });

    const { createTestScanStore: createStoreWithMock } = await import("@/stores/scanStore");
    const { MockDb: MockDbWithMock } = await import("@/sync-database/mock/mockDb");

    const store = createStoreWithMock({ db: new MockDbWithMock() });
    store.getState().processScan("205551600099");
    const reviewId = store.getState().needsReviewQueue.at(-1)!.id;

    // Must not throw even though the structurer underneath is crashing.
    expect(() =>
      store.getState().resolveUnknown(reviewId, "create_new", {
        applyToCount: true,
        origin: "human",
        newProduct: {
          name: "Cooper Discoverer AT3 265/70R17",
          brand: "Cooper",
          category: "Tire",
          primaryBarcode: "205551600099",
        },
      }),
    ).not.toThrow();

    const product = store.getState().products.find((p) => p.primaryBarcode === "205551600099");
    expect(product, "product was still created despite the structurer throwing").toBeDefined();
    expect(product?.name).toBe("Cooper Discoverer AT3 265/70R17");
    // Unstructured: the containment wrapper returns an empty patch on throw.
    expect(product?.structuredBrand).toBeUndefined();
    expect(product?.structuredBy).toBeUndefined();

    vi.doUnmock("@/products/polish/structurer");
    vi.resetModules();
  });
});
