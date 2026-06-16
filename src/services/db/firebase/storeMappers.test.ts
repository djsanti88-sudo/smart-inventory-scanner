import { describe, it, expect } from "vitest";
import { toStoreProduct, toStoreAlias, toStoreSession, toStoreCount } from "./storeMappers";

const BIZ = "biz-1";

describe("toStoreProduct", () => {
  it("maps fields and applies safe defaults", () => {
    const p = toStoreProduct("p1", { name: "Falken Sincera", primarySku: "2881-6861", verified: true }, BIZ);
    expect(p).toMatchObject({ id: "p1", businessId: BIZ, name: "Falken Sincera", primarySku: "2881-6861", verified: true });
    expect(p.status).toBe("active");
    expect(p.confidence).toBe(1);
    expect(p.vendorCodes).toEqual([]);
    expect(p.createdBy).toBe("human");
  });

  it("defaults verified to false and respects archived status", () => {
    const p = toStoreProduct("p2", { status: "archived" }, BIZ);
    expect(p.verified).toBe(false);
    expect(p.status).toBe("archived");
  });
});

describe("toStoreAlias", () => {
  it("maps fields, defaults normalizedCode to cleanCode, and approved to false", () => {
    const a = toStoreAlias("a1", { productId: "p1", cleanCode: "28816861" }, BIZ);
    expect(a).toMatchObject({ id: "a1", businessId: BIZ, productId: "p1", cleanCode: "28816861" });
    expect(a.normalizedCode).toBe("28816861");
    expect(a.approved).toBe(false);
    expect(a.aliasType).toBe("barcode");
    expect(a.syncStatus).toBe("synced");
  });

  it("honors approved:true and explicit normalizedCode", () => {
    const a = toStoreAlias("a2", { cleanCode: "abc", normalizedCode: "ABC", approved: true }, BIZ);
    expect(a.approved).toBe(true);
    expect(a.normalizedCode).toBe("ABC");
  });
});

describe("toStoreSession", () => {
  it("maps defaults and normalizes completedAt to null when absent", () => {
    const s = toStoreSession("s1", {}, BIZ);
    expect(s).toMatchObject({ id: "s1", businessId: BIZ, name: "Session", location: "Main", status: "active" });
    expect(s.completedAt).toBeNull();
  });

  it("keeps completedAt + completed status", () => {
    const s = toStoreSession("s2", { status: "completed", completedAt: "2026-06-15T00:00:00Z" }, BIZ);
    expect(s.status).toBe("completed");
    expect(s.completedAt).toBe("2026-06-15T00:00:00Z");
  });
});

describe("toStoreCount", () => {
  it("maps countedQuantity->quantity and countSessionId->sessionId", () => {
    const c = toStoreCount("s1_p1", { countSessionId: "s1", productId: "p1", countedQuantity: 7 }, BIZ);
    expect(c).toMatchObject({ id: "s1_p1", businessId: BIZ, sessionId: "s1", productId: "p1", quantity: 7 });
    expect(c.syncStatus).toBe("synced");
    expect(c.syncError).toBeNull();
  });

  it("falls back to quantity and defaults arrays", () => {
    const c = toStoreCount("x", { quantity: 3 }, BIZ);
    expect(c.quantity).toBe(3);
    expect(c.scanEventIds).toEqual([]);
    expect(c.appliedIdempotencyKeys).toEqual([]);
  });
});
