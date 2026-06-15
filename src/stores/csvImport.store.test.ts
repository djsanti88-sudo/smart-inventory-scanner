import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";
import type { AuditEventInput } from "@/services/audit/audit";

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

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };
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

  it("reports conflicts and does not reassign a code already mapped to a different product", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader, audit: () => {} });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    // First import claims 111222333 for product A.
    store.getState().importProductsCsv("name,barcode\nA,111222333");
    await flush();
    // Second import tries to map the SAME code to a different product -> conflict, not applied.
    const summary = store.getState().importProductsCsv("name,barcode\nB,111222333");
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
