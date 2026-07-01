import { describe, it, expect, vi } from "vitest";
import { lookupBarcodeDb, getLastBarcodeDbStatus } from "@/server/retail-knowledge/barcodeDbProvider";

const okResp = { items: [{ title: "Michelin LTX M/S2 All-Season P255/70R18 112T", brand: "Michelin", offers: [{ link: "https://x/y" }] }] };
function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => json })) as unknown as typeof fetch;
}
describe("barcode-DB provider (UPCitemdb)", () => {
  it("returns structured identity on a hit", async () => {
    const r = await lookupBarcodeDb("086699087829", { fetch: mockFetch(200, okResp) });
    expect(r?.brand).toBe("Michelin");
    expect(r?.name).toMatch(/LTX/);
    expect(getLastBarcodeDbStatus()).toBe("hit");
  });
  it("returns null + rate_limited on 429", async () => {
    const r = await lookupBarcodeDb("086699087829", { fetch: mockFetch(429, {}) });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("rate_limited");
  });
  it("returns null + miss on empty items", async () => {
    const r = await lookupBarcodeDb("000000000000", { fetch: mockFetch(200, { items: [] }) });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("miss");
  });
});
