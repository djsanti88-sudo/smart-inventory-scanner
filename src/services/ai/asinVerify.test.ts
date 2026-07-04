import { describe, it, expect } from "vitest";
import { looksLikeAsin, isRealAmazonProductPage, verifyAsinPage } from "@/services/ai/asinVerify";
import type { FetchImpl } from "@/services/ai/pageFetch";

const PRODUCT_HTML = `<html><head><meta property="og:title" content="Echo Dot (5th Gen) | Smart speaker"/><title>Echo Dot</title></head><body><span id="productTitle">Echo Dot (5th Gen)</span></body></html>`;
const ROBOT_HTML = `<html><body>Robot Check - Enter the characters you see below. api-services-support@amazon.com</body></html>`;

const fakeFetch = (status: number, body: string): FetchImpl => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

describe("looksLikeAsin", () => {
  it("accepts B0-prefixed 10-char ASINs", () => expect(looksLikeAsin("B0BCH8W3RD")).toBe(true));
  it("rejects UPCs", () => expect(looksLikeAsin("078742051451")).toBe(false));
  it("rejects FNSKUs (X00...)", () => expect(looksLikeAsin("X004ABCDEF")).toBe(false));
});

describe("isRealAmazonProductPage", () => {
  it("accepts a real product page", () => expect(isRealAmazonProductPage(PRODUCT_HTML)).toBe(true));
  it("rejects a robot-check page", () => expect(isRealAmazonProductPage(ROBOT_HTML)).toBe(false));
  it("rejects empty html", () => expect(isRealAmazonProductPage("")).toBe(false));
});

describe("verifyAsinPage", () => {
  it("verifies when the dp page is a real product page", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(200, PRODUCT_HTML) });
    expect(r.verified).toBe(true);
    expect(r.productName).toContain("Echo Dot");
    expect(r.url).toBe("https://www.amazon.com/dp/B0BCH8W3RD");
  });
  it("does NOT verify on robot-check", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(200, ROBOT_HTML) });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("blocked");
  });
  it("does NOT verify on 404", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(404, "") });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("no_page");
  });
  it("rejects non-ASIN input without fetching", async () => {
    const r = await verifyAsinPage("X004ABCDEF", { fetchImpl: fakeFetch(200, PRODUCT_HTML) });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("not_asin");
  });
});
