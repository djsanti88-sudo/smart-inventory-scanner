import { describe, it, expect } from "vitest";
import { normCodeToken, blobContainsCodeToken, codeFromNamePrefix } from "@/services/productDedup";

// P2: exact code-token dedup helpers. A barcode hiding inside a product NAME must be found (so a re-scan
// reuses the row, not mints a duplicate), but a tire size / load index / year must NEVER be mistaken for
// a code (wrong identity = failure; we only match a full exact code token).

describe("normCodeToken", () => {
  it("keeps alphanumerics + leading zeros, strips separators, never numeric-converts", () => {
    expect(normCodeToken("029142-712886")).toBe("029142712886");
    expect(normCodeToken(" 28033503 ")).toBe("28033503");
    expect(normCodeToken("x00abc1234")).toBe("X00ABC1234");
  });
});

describe("blobContainsCodeToken", () => {
  const name = "UPC 029142712886 - Discoverer A/T3 E (10 Ply) BW";
  it("matches the barcode that lives only inside the product name", () => {
    expect(blobContainsCodeToken(name, ["029142712886"])).toBe(true);
  });
  it("does NOT match tire size / load / year fragments (no false dedup)", () => {
    const tire = "Defender LTX M/S 275/70R18 125S Fits 2004 Chevrolet";
    expect(blobContainsCodeToken(tire, ["275"])).toBe(false); // too short anyway
    expect(blobContainsCodeToken(tire, ["70R18"])).toBe(false);
    expect(blobContainsCodeToken(tire, ["2004"])).toBe(false);
    expect(blobContainsCodeToken(tire, ["125"])).toBe(false);
  });
  it("requires a WHOLE token, never a substring", () => {
    expect(blobContainsCodeToken("Tire 0291427128861234", ["029142712886"])).toBe(false); // longer run, not a token
    expect(blobContainsCodeToken("Tire 029142712886X", ["029142712886"])).toBe(false);
  });
  it("ignores short codes and empty input", () => {
    expect(blobContainsCodeToken("Widget 12345", ["12345"])).toBe(false); // < 6
    expect(blobContainsCodeToken("", ["029142712886"])).toBe(false);
    expect(blobContainsCodeToken("anything", [])).toBe(false);
  });
});

describe("codeFromNamePrefix", () => {
  it("extracts the code from a leading UPC/GTIN/EAN prefix", () => {
    expect(codeFromNamePrefix("UPC 029142712886 - Discoverer A/T3")).toBe("029142712886");
    expect(codeFromNamePrefix("GTIN 00029142712886 - Cooper")).toBe("00029142712886");
    expect(codeFromNamePrefix("EAN: 4019238008678 - Falken")).toBe("4019238008678");
  });
  it("accepts an en dash or em dash separator exactly like the render-side cleaner (one shared matcher)", () => {
    expect(codeFromNamePrefix("UPC 086699205636 – Defender LTX M/S")).toBe("086699205636");
    expect(codeFromNamePrefix("UPC 086699205636 — Defender LTX M/S")).toBe("086699205636");
  });
  it("returns null for ordinary names (leaves them untouched)", () => {
    expect(codeFromNamePrefix("Discoverer A/T3 LT245/75R16")).toBeNull();
    expect(codeFromNamePrefix("UPC scanner cleaning kit - 3 pack")).toBeNull(); // "scanner" is not a code
    expect(codeFromNamePrefix("")).toBeNull();
  });
});
