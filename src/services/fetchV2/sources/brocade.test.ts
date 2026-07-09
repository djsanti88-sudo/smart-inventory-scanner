import { describe, it, expect, vi } from "vitest";
import { brocadeLookup } from "./brocade";

// Minimal Response-like builder for the mocked fetch.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("brocadeLookup", () => {
  it("maps a 200 { gtin, name, brand_name } into a StructuredHit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ gtin: "0074887615305", name: "Aveeno Daily Moisturizing Lotion", brand_name: "Aveeno" }),
    );
    const hit = await brocadeLookup(["0074887615305"], fetchImpl as unknown as typeof fetch);
    expect(hit).toEqual({
      url: "https://www.brocade.io/products/0074887615305",
      name: "Aveeno Daily Moisturizing Lotion",
      brand: "Aveeno",
      matchedBarcode: "0074887615305",
      quality: "medium",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.brocade.io/api/items/0074887615305",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("returns null when no 12-14 digit variant exists (client never called)", async () => {
    const fetchImpl = vi.fn();
    expect(await brocadeLookup(["DCB205", "1234567"], fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a 404 (not in DB)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, false, 404));
    expect(await brocadeLookup(["0074887615305"], fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on malformed / non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);
    expect(await brocadeLookup(["0074887615305"], fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on a 200 whose body has no name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ gtin: "0074887615305" }));
    expect(await brocadeLookup(["0074887615305"], fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null on a network / timeout error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    expect(await brocadeLookup(["0074887615305"], fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
