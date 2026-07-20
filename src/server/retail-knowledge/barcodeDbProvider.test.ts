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
  // Recall fix (2026-07-03): UPCitemdb trial burst-limits aggressively (esp. from shared Vercel egress
  // IPs), and an immediate null deletes the barcode-DB consensus vote. One short backoff retry recovers
  // the transient 429s; a persistent 429 still returns rate_limited after exactly one retry.
  it("retries ONCE after a short backoff on 429 and returns the hit", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => okResp })) as unknown as typeof fetch;
    const r = await lookupBarcodeDb("086699087829", { fetch: f, backoffMs: 1 });
    expect(r?.brand).toBe("Michelin");
    expect(getLastBarcodeDbStatus()).toBe("hit");
  });
  it("returns null + rate_limited when the 429 persists after one retry (exactly 2 calls)", async () => {
    const f = mockFetch(429, {});
    const r = await lookupBarcodeDb("086699087829", { fetch: f, backoffMs: 1 });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("rate_limited");
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
  it("returns null + miss on empty items", async () => {
    const r = await lookupBarcodeDb("000000000000", { fetch: mockFetch(200, { items: [] }) });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("miss");
  });

  // D8 follow-up (P5, 2026-07-20): `skipExact` lets a caller who ALREADY tried the exact code (e.g.
  // decode pipeline rung-0) skip straight to the zero-pad variants instead of wastefully re-fetching
  // the identical exact-code URL against the keyless ~90-100/day trial budget.
  it("skipExact: true skips the exact-code variant and queries only the zero-pad variants", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    const code = "36000291452"; // 11 digits: pad-13 and pad-12 variants both differ from the exact code
    await lookupBarcodeDb(code, { fetch: f, skipExact: true });
    // The exact code itself must never appear in any fetched URL.
    expect(calls.some((u) => u.includes(`upc=${code}`))).toBe(false);
    // But the zero-padded variants must still be tried (skipExact does not disable pad-variant retry).
    expect(calls.some((u) => u.includes(`upc=${code.padStart(13, "0")}`))).toBe(true);
    expect(calls.some((u) => u.includes(`upc=${code.padStart(12, "0")}`))).toBe(true);
  });

  it("skipExact: false (default) still queries the exact code first, unchanged behavior", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    const code = "36000291452";
    await lookupBarcodeDb(code, { fetch: f });
    expect(calls[0]).toContain(`upc=${code}`);
  });
});
