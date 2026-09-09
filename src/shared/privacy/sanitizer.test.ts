import { describe, it, expect } from "vitest";
import { sanitizeForAiLookup, containsSensitiveData } from "@/shared/privacy/sanitizer";

describe("sanitizeForAiLookup", () => {
  it("masks email addresses", () => {
    const r = sanitizeForAiLookup("contact jane@acme.com about the tire");
    expect(r.clean).not.toContain("jane@acme.com");
    expect(r.clean).toContain("[redacted-email]");
    expect(r.maskedCounts.email).toBe(1);
  });

  it("masks phone numbers but keeps barcodes intact", () => {
    const r = sanitizeForAiLookup("call 555-123-4567 about UPC 049000028904");
    expect(r.clean).toContain("[redacted-phone]");
    expect(r.clean).toContain("049000028904"); // 12-digit barcode preserved
  });

  it("masks explicit cost markers", () => {
    expect(sanitizeForAiLookup("COST-12.50").clean).toContain("[redacted-cost]");
    expect(sanitizeForAiLookup("cost $12.50").clean).toContain("[redacted-cost]");
    expect(sanitizeForAiLookup("internal cost 12.50").clean).toContain("[redacted-cost]");
  });

  it("masks margin percentages", () => {
    expect(sanitizeForAiLookup("margin 42 percent").clean).toContain("[redacted-margin]");
    expect(sanitizeForAiLookup("markup: 30%").clean).toContain("[redacted-margin]");
  });

  it("masks money amounts when a cost keyword is nearby", () => {
    const r = sanitizeForAiLookup("wholesale price is $9.25 each");
    expect(r.clean).not.toContain("$9.25");
  });

  it("masks labeled customer/employee names", () => {
    const r = sanitizeForAiLookup("customer: John Smith picked up the order");
    expect(r.clean).toContain("[redacted-name]");
    expect(r.clean).not.toContain("John Smith");
  });

  it("leaves a clean technical product string untouched", () => {
    const text = "Nokian Outpost APT 245/55R19 SKU T432119 GTIN 6419440485331";
    const r = sanitizeForAiLookup(text);
    expect(r.clean).toBe(text);
    expect(containsSensitiveData(text)).toBe(false);
  });
});
