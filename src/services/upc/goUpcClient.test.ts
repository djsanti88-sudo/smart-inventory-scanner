import { describe, it, expect, vi } from "vitest";
import { goUpcLookup } from "./goUpcClient";

// Build a mock fetch that returns a controllable Response-like object and records the call.
function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function textOnlyResponse(status: number, text: string) {
  // 200 that is not valid JSON: json() rejects.
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON: " + text);
    },
  } as unknown as Response;
}

const KEY = "testkey";
const CODE = "0885909950805";

describe("goUpcLookup", () => {
  it("200 with product + inferred:false -> hit, inferred false, fields mapped, raw preserved", async () => {
    const body = {
      inferred: false,
      product: {
        name: "Apple AirPods",
        brand: "Apple",
        description: "Wireless earbuds",
        imageUrl: "https://img.example/airpods.jpg",
        category: "Electronics",
        specs: [["Color", "White"], ["Weight", "38g"]],
        upc: "885909950805",
        ean: "0885909950805",
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, body));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.inferred).toBe(false);
    expect(out.product.name).toBe("Apple AirPods");
    expect(out.product.brand).toBe("Apple");
    expect(out.product.description).toBe("Wireless earbuds");
    expect(out.product.imageUrl).toBe("https://img.example/airpods.jpg");
    expect(out.product.category).toBe("Electronics");
    expect(out.product.specs).toEqual([["Color", "White"], ["Weight", "38g"]]);
    expect(out.product.upc).toBe("885909950805");
    expect(out.product.ean).toBe("0885909950805");
    // raw preserved verbatim (full parsed body, not just product)
    expect(out.raw).toEqual(body);
  });

  it("200 with inferred:true -> hit, inferred true", async () => {
    const body = { inferred: true, product: { name: "Guessed Product" } };
    const fetchImpl = vi.fn(async () => jsonResponse(200, body));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.inferred).toBe(true);
    expect(out.product.name).toBe("Guessed Product");
    // Missing string fields default to "" and specs defaults to [].
    expect(out.product.brand).toBe("");
    expect(out.product.description).toBe("");
    expect(out.product.imageUrl).toBe("");
    expect(out.product.category).toBe("");
    expect(out.product.specs).toEqual([]);
  });

  it("200 with no inferred flag -> defaults inferred false", async () => {
    const body = { product: { name: "No Flag Product" } };
    const fetchImpl = vi.fn(async () => jsonResponse(200, body));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("expected hit");
    expect(out.inferred).toBe(false);
  });

  it("404 -> miss", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not found" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("miss");
  });

  // DC2-2 (2026-08-13): a bare 404 is indistinguishable from provider flakiness unless we look at the
  // body. A well-formed JSON error body reads as a genuine provider answer -> confident negative.
  it("404 with a well-formed JSON body -> miss, confident: true (genuine provider answer)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not found" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("miss");
    if (out.kind !== "miss") throw new Error("expected miss");
    expect(out.confident).toBe(true);
  });

  // A 404 with an empty/non-JSON body (outage page, load balancer error page, truncated response) is
  // NOT distinguishable from a genuine "not in DB" answer -> must NOT be trusted as a confident negative.
  it("404 with an empty/non-JSON body -> miss, confident: false (possibly transient, not a genuine answer)", async () => {
    const fetchImpl = vi.fn(async () => textOnlyResponse(404, ""));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("miss");
    if (out.kind !== "miss") throw new Error("expected miss");
    expect(out.confident).toBe(false);
  });

  it("400 -> bad_format", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "bad" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("bad_format");
  });

  it("401 -> auth_failed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("auth_failed");
  });

  it("429 -> quota", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "too many" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("quota");
  });

  it("5xx -> transient with detail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "down" }, false));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("transient");
    if (out.kind !== "transient") throw new Error("expected transient");
    expect(typeof out.detail).toBe("string");
    expect(out.detail.length).toBeGreaterThan(0);
  });

  it("fetch throws AbortError -> transient with detail", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    });
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("transient");
    if (out.kind !== "transient") throw new Error("expected transient");
    expect(out.detail).toContain("abort");
  });

  it("200 non-JSON body -> transient with detail", async () => {
    const fetchImpl = vi.fn(async () => textOnlyResponse(200, "<html>gateway</html>"));
    const out = await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(out.kind).toBe("transient");
    if (out.kind !== "transient") throw new Error("expected transient");
    expect(out.detail.length).toBeGreaterThan(0);
  });

  it("sends Authorization: Bearer header and NO key= query param", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      const h = init?.headers as Record<string, string> | undefined;
      seenHeaders = h ?? {};
      return jsonResponse(200, { inferred: false, product: { name: "X" } });
    });
    await goUpcLookup(CODE, { apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    // Header present with exact Bearer value.
    const authHeader = seenHeaders["Authorization"] ?? seenHeaders["authorization"];
    expect(authHeader).toBe("Bearer testkey");
    // URL is the versioned code endpoint, code encoded, and carries NO key= param.
    expect(seenUrl).toContain("https://go-upc.com/api/v1/code/");
    expect(seenUrl).toContain(encodeURIComponent(CODE));
    expect(seenUrl).not.toContain("key=");
  });

  it("default timeout is 10000ms via AbortSignal.timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => jsonResponse(200, { inferred: false, product: { name: "X" } }));
    await goUpcLookup(CODE, { apiKey: KEY, fetchImpl });
    expect(spy).toHaveBeenCalledWith(10000);
    spy.mockRestore();
  });

  it("honors a custom timeoutMs", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => jsonResponse(200, { inferred: false, product: { name: "X" } }));
    await goUpcLookup(CODE, { apiKey: KEY, fetchImpl, timeoutMs: 2500 });
    expect(spy).toHaveBeenCalledWith(2500);
    spy.mockRestore();
  });

  it("encodes the code into the path", async () => {
    let seenUrl = "";
    const weird = "abc /def";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seenUrl = String(url);
      return jsonResponse(200, { inferred: false, product: { name: "X" } });
    });
    await goUpcLookup(weird, { apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seenUrl).toContain(encodeURIComponent(weird));
    expect(seenUrl).not.toContain(" ");
  });
});
