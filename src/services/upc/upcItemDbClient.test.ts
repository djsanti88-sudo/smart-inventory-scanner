import { describe, it, expect, vi } from "vitest";
import { upcItemDbLookup } from "./upcItemDbClient";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as Response;
}

describe("upcItemDbLookup (pure client)", () => {
  it("200 with items -> hit, items[0] mapped, offers ignored", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        code: "OK",
        items: [
          {
            title: "Falken Wildpeak A/T3W 265/70R17 115T",
            brand: "Falken",
            category: "Tire",
            upc: "848983006257",
            offers: [{ price: 199.99, merchant: "SomeShop" }], // must be ignored
          },
        ],
      }),
    );
    const outcome = await upcItemDbLookup("848983006257", { fetchImpl });
    expect(outcome.kind).toBe("hit");
    if (outcome.kind === "hit") {
      expect(outcome.item.title).toBe("Falken Wildpeak A/T3W 265/70R17 115T");
      expect(outcome.item.brand).toBe("Falken");
      expect(outcome.item.category).toBe("Tire");
      expect(outcome.item.upc).toBe("848983006257");
      // offers is not part of UpcItemDbItem's shape at all - proven by the type; also confirm the
      // raw body still carries it (evidence trail) but toItem() never surfaces it.
      expect("offers" in outcome.item).toBe(false);
    }
  });

  it("200 with empty items array -> miss", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { code: "OK", items: [] }));
    const outcome = await upcItemDbLookup("000000000000", { fetchImpl });
    expect(outcome.kind).toBe("miss");
  });

  it("404 -> miss", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404, json: async () => ({}) }) as Response);
    const outcome = await upcItemDbLookup("000000000000", { fetchImpl });
    expect(outcome.kind).toBe("miss");
  });

  it("400 -> bad_format", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 400, json: async () => ({}) }) as Response);
    const outcome = await upcItemDbLookup("bad", { fetchImpl });
    expect(outcome.kind).toBe("bad_format");
  });

  it("429 -> quota", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 429, json: async () => ({}) }) as Response);
    const outcome = await upcItemDbLookup("848983006257", { fetchImpl });
    expect(outcome.kind).toBe("quota");
  });

  it("5xx -> transient with http status detail", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 503, json: async () => ({}) }) as Response);
    const outcome = await upcItemDbLookup("848983006257", { fetchImpl });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.detail).toContain("503");
  });

  it("network/abort error -> transient, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const outcome = await upcItemDbLookup("848983006257", { fetchImpl });
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
    const outcome = await upcItemDbLookup("848983006257", { fetchImpl });
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") expect(outcome.detail).toContain("malformed JSON");
  });

  it("uses the trial keyless endpoint with the upc query param, no Authorization header", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.upcitemdb.com/prod/trial/lookup?upc=848983006257");
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      return jsonResponse(200, { items: [] });
    }) as unknown as typeof fetch;
    await upcItemDbLookup("848983006257", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
