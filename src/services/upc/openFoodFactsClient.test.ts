import { describe, it, expect, vi } from "vitest";
import { openFoodFactsLookup, OFF_USER_AGENT } from "./openFoodFactsClient";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as Response;
}

describe("openFoodFactsLookup (pure client)", () => {
  it("status 1 with product -> hit, name/brand/category mapped, nutrition/ingredients ignored", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        status: 1,
        product: {
          product_name: "Danone Activia Yogurt",
          brands: "Danone,Activia",
          categories_tags: ["en:dairies", "en:fermented-foods"],
          nutriments: { energy: 999 }, // must be ignored
          ingredients_text: "milk, sugar", // must be ignored
        },
      }),
    );
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("hit");
    if (outcome.kind === "hit") {
      expect(outcome.product.name).toBe("Danone Activia Yogurt");
      expect(outcome.product.brand).toBe("Danone"); // first of the comma-separated list
      expect(outcome.product.category).toBe("dairies"); // language prefix stripped
      expect("nutriments" in outcome.product).toBe(false);
    }
  });

  it("status 0 (genuine miss per OFF v2 semantics, HTTP 200) -> miss", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 0, product: null }));
    const outcome = await openFoodFactsLookup("0000000000000", { fetchImpl });
    expect(outcome.kind).toBe("miss");
  });

  it("status 1 but product has no product_name -> miss (not a usable identity)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 1, product: { product_name: "" } }));
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("miss");
  });

  it("404 -> miss", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, json: async () => ({}) }) as Response);
    const outcome = await openFoodFactsLookup("0000000000000", { fetchImpl });
    expect(outcome.kind).toBe("miss");
  });

  it("400 -> bad_format", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 400, json: async () => ({}) }) as Response);
    const outcome = await openFoodFactsLookup("bad", { fetchImpl });
    expect(outcome.kind).toBe("bad_format");
  });

  it("429 -> quota", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 429, json: async () => ({}) }) as Response);
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("quota");
  });

  it("5xx -> transient with http status detail", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 503, json: async () => ({}) }) as Response);
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.detail).toContain("503");
  });

  it("network/abort error -> transient, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.detail).toContain("AbortError");
  });

  it("malformed JSON body -> transient, never throws", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response,
    );
    const outcome = await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.detail).toContain("malformed JSON");
  });

  it("uses the v2 product endpoint with the REQUIRED descriptive User-Agent header", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://world.openfoodfacts.org/api/v2/product/3033490004624.json");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["User-Agent"]).toBe(OFF_USER_AGENT);
      expect(OFF_USER_AGENT).toContain("SmartInventoryScanner");
      expect(OFF_USER_AGENT).toContain("djsanti88@gmail.com");
      return jsonResponse(200, { status: 0 });
    }) as unknown as typeof fetch;
    await openFoodFactsLookup("3033490004624", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
