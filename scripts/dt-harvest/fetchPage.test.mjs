import { describe, it, expect } from "vitest";
import { BlockRateStop } from "./fetchPage.mjs";

// Only the pure part of Task 4 is unit tested here. fetchProductPage drives a real
// Playwright page and is proven live in Task 5's pilot batch, not in this suite.

describe("BlockRateStop", () => {
  it("does not stop when blocked fraction is at/under the 30% threshold (14 of 50)", () => {
    const stop = new BlockRateStop();
    for (let i = 0; i < 14; i++) stop.record("blocked");
    for (let i = 0; i < 36; i++) stop.record("ok");

    expect(stop.window.length).toBe(50);
    expect(stop.shouldStop()).toBe(false);
  });

  it("stops when blocked fraction exceeds the 30% threshold (16 of 50)", () => {
    const stop = new BlockRateStop();
    for (let i = 0; i < 16; i++) stop.record("blocked");
    for (let i = 0; i < 34; i++) stop.record("ok");

    expect(stop.window.length).toBe(50);
    expect(stop.shouldStop()).toBe(true);
  });

  it("slides the window so old blocks age out past the last 50 records", () => {
    const stop = new BlockRateStop();
    // First 20 are blocked, but they will be pushed out once we add 50 more "ok"s.
    for (let i = 0; i < 20; i++) stop.record("blocked");
    for (let i = 0; i < 50; i++) stop.record("ok");

    // Window now holds only the most recent 50 records: all "ok".
    expect(stop.window.length).toBe(50);
    expect(stop.window.every((status) => status === "ok")).toBe(true);
    expect(stop.shouldStop()).toBe(false);
  });

  it("returns false on an empty window (no fetches recorded yet)", () => {
    const stop = new BlockRateStop();
    expect(stop.shouldStop()).toBe(false);
  });

  it("treats status boundary correctly: exactly 30% (15 of 50) does not stop", () => {
    const stop = new BlockRateStop();
    for (let i = 0; i < 15; i++) stop.record("blocked");
    for (let i = 0; i < 35; i++) stop.record("ok");

    expect(stop.shouldStop()).toBe(false);
  });

  it("counts only 'blocked' status toward the rate, not 'error'", () => {
    const stop = new BlockRateStop();
    for (let i = 0; i < 20; i++) stop.record("error");
    for (let i = 0; i < 30; i++) stop.record("ok");

    expect(stop.shouldStop()).toBe(false);
  });

  it("supports a custom windowSize and threshold", () => {
    const stop = new BlockRateStop({ windowSize: 10, threshold: 0.5 });
    for (let i = 0; i < 6; i++) stop.record("blocked");
    for (let i = 0; i < 4; i++) stop.record("ok");

    expect(stop.window.length).toBe(10);
    expect(stop.shouldStop()).toBe(true);
  });
});

// --- extractProductByCode (pure part of the productByCode capture path) ---

import { extractProductByCode } from "./fetchPage.mjs";

describe("extractProductByCode", () => {
  it("returns the data.product.byCode node from a valid GraphQL body", () => {
    const body = JSON.stringify({ data: { product: { byCode: { gtin: "092971302481", brand: "Bridgestone" } } } });
    expect(extractProductByCode(body)).toEqual({ gtin: "092971302481", brand: "Bridgestone" });
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(extractProductByCode("{not json")).toBeNull();
  });

  it("returns null when the node is absent or not an object", () => {
    expect(extractProductByCode(JSON.stringify({ data: { product: {} } }))).toBeNull();
    expect(extractProductByCode(JSON.stringify({ data: { product: { byCode: "x" } } }))).toBeNull();
    expect(extractProductByCode("")).toBeNull();
    expect(extractProductByCode(undefined)).toBeNull();
  });
});
