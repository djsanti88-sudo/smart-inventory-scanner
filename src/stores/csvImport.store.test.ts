import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";
import type { AuditEventInput } from "@/users-businesses/account/audit";

// Loop 5 proof (store): importProductsCsv adds products + approved aliases, queues them through the
// SAME durable path as scans (SAVE_PRODUCT + RESOLVE_ALIAS), audits the import, and an imported code
// then resolves Known on the next scan.

class RecordingTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

class StrictIdempotencyTarget implements SyncTarget {
  readonly applied: PendingSyncItem[] = [];
  readonly products = new Map<string, Record<string, unknown>>();
  private readonly payloadByKey = new Map<string, string>();

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    this.applied.push(item);
    const payload = JSON.stringify(item.payload);
    const previous = this.payloadByKey.get(item.idempotencyKey);
    if (previous !== undefined) {
      if (previous === payload) return { ok: true, alreadyApplied: true };
      return {
        ok: false,
        alreadyApplied: false,
        error: "idempotency_conflict",
        errorCode: "idempotency_conflict",
        retryable: false,
      };
    }
    this.payloadByKey.set(item.idempotencyKey, payload);
    if (item.operation === "SAVE_PRODUCT") {
      const product = item.payload as Record<string, unknown>;
      this.products.set(item.entityId, { ...product });
    }
    return { ok: true, alreadyApplied: false };
  }

  setFailure() {}
  reset() {}
}

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };
const waitForQueueToDrain = async (store: ReturnType<typeof createTestScanStore>) => {
  for (let i = 0; i < 50 && store.getState().pendingSyncQueue.length > 0; i += 1) await flush();
  expect(store.getState().pendingSyncQueue).toHaveLength(0);
};
const emptyLoader = async () => ({ products: [], aliases: [], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

describe("Loop 5 CSV import (store)", () => {
  it("imports products + aliases through the durable queue, audits, and an imported code resolves Known", async () => {
    const target = new RecordingTarget();
    const events: AuditEventInput[] = [];
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader, audit: (e) => events.push(e) });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    const csv = "name,sku,barcode\nNokian Tire,T432119,6419440485331\nCoke,,049000050103";
    const summary = store.getState().importProductsCsv(csv);
    await flush();

    expect(summary.productsCreated).toBe(2);
    expect(summary.aliasesCreated).toBe(3); // T432119, 6419440485331, 049000050103
    expect(summary.conflicts).toHaveLength(0);

    // Persisted through the durable queue (SAVE_PRODUCT before its aliases).
    const ops = target.applied.map((i) => i.operation);
    expect(ops.filter((o) => o === "SAVE_PRODUCT")).toHaveLength(2);
    expect(ops.filter((o) => o === "RESOLVE_ALIAS")).toHaveLength(3);

    // Audited.
    expect(events.some((e) => e.action === "csv_import" && e.businessId === "biz-real")).toBe(true);

    // An imported, approved code now resolves deterministically (Known) on scan.
    const ev = store.getState().processScan("6419440485331");
    expect(ev?.resolverStatus).toBe("known");
  });

  it("QA Task 7: re-importing an existing barcode refreshes the existing product's fields (never a hard conflict, never a new product)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader, audit: () => {} });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    // First import claims 111222333 for product "A".
    store.getState().importProductsCsv("name,barcode\nA,111222333");
    await flush();
    // Second import re-uses the SAME barcode with a different name -> catalog semantics: refresh the
    // existing product's descriptive fields, never mint a second product and never hard-discard.
    const summary = store.getState().importProductsCsv("name,barcode\nB,111222333");
    await flush();

    expect(summary.productsCreated).toBe(0);
    expect(summary.conflicts).toHaveLength(0);
    expect(summary.refreshed).toBe(1);

    const products = store.getState().products;
    expect(products).toHaveLength(1); // still exactly one product for this barcode, not two
    expect(products[0].name).toBe("B"); // descriptive field refreshed from the re-import row
  });

  it("versions refreshed SAVE_PRODUCT keys by payload so changed CSV content reaches a strict durable target", async () => {
    const target = new StrictIdempotencyTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader, audit: () => {} });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    store.getState().importProductsCsv("name,brand,barcode\nOriginal Name,Original Brand,111222333");
    await waitForQueueToDrain(store);
    const productId = store.getState().products[0].id;
    const firstWrite = target.applied.find((entry) => entry.operation === "SAVE_PRODUCT" && entry.entityId === productId);
    expect(firstWrite).toBeDefined();
    expect(target.products.get(productId)?.name).toBe("Original Name");

    store.getState().importProductsCsv("name,brand,barcode\nRefreshed Name,Refreshed Brand,111222333");
    await waitForQueueToDrain(store);

    const productWrites = target.applied.filter(
      (entry) => entry.operation === "SAVE_PRODUCT" && entry.entityId === productId,
    );
    expect(productWrites).toHaveLength(2);
    expect(productWrites[1].idempotencyKey).not.toBe(firstWrite!.idempotencyKey);
    expect(target.products.get(productId)).toMatchObject({
      name: "Refreshed Name",
      brand: "Refreshed Brand",
    });
  });

  it("reports a genuine conflict when the row's sku points at a DIFFERENT existing product than the barcode owner", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader, audit: () => {} });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    // Seed two independent products: A (barcode 111222333) and C (sku SKU-C, barcode 444555666).
    store.getState().importProductsCsv("name,sku,barcode\nA,SKU-A,111222333\nC,SKU-C,444555666");
    await flush();

    // A row claims A's barcode but C's sku -> genuinely conflicting identity, must not be reassigned
    // or silently merged into either product.
    const summary = store.getState().importProductsCsv("name,sku,barcode\nImpostor,SKU-C,111222333");
    await flush();

    expect(summary.productsCreated).toBe(0);
    expect(summary.conflicts.some((c) => c.code === "111222333")).toBe(true);
  });

  it("export audit fires through auditCsvExport", async () => {
    const events: AuditEventInput[] = [];
    const store = createTestScanStore({ db: new RecordingTarget(), cloudBackend: true, loadBusinessData: emptyLoader, audit: (e) => events.push(e) });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    store.getState().auditCsvExport("export-final-counts", 5);
    expect(events.some((e) => e.action === "csv_export" && e.entityId === "export-final-counts")).toBe(true);
  });
});

describe("importProductsCsv - optional unit_cost column", () => {
  it("maps a unit_cost column onto Product.unitCost when present and numeric", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku,unit_cost\nWidget,Acme,Tools,SKU1,12.50\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU1");
    expect(imported?.unitCost).toBe(12.5);
  });

  it("recognizes case-insensitive unit cost header synonyms", () => {
    for (const header of ["UNIT COST", "cost", "unitcost"]) {
      const store = createTestScanStore({});
      const csv = `name,primary_sku,${header}\nWidget,SKU-${header},7.25\n`;
      store.getState().importProductsCsv(csv);
      const imported = store.getState().products.find((p) => p.primarySku === `SKU-${header}`);
      expect(imported?.unitCost).toBe(7.25);
    }
  });

  it("leaves unitCost UNDEFINED (never 0) when the column is absent", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku\nGadget,Zeta,Electronics,SKU2\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU2");
    expect(imported?.unitCost).toBeUndefined();
  });

  it("leaves unitCost UNDEFINED when the column value is not a valid number", () => {
    const store = createTestScanStore({});
    const csv = "name,brand,category,primary_sku,unit_cost\nBroken,Acme,Tools,SKU3,not-a-number\n";
    store.getState().importProductsCsv(csv);
    const imported = store.getState().products.find((p) => p.primarySku === "SKU3");
    expect(imported?.unitCost).toBeUndefined();
  });
});
